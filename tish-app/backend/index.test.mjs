// Functional tests for the app backend Lambda: the real handler is invoked
// with API-Gateway-REST-shaped events; only the Postgres pool is substituted
// (scripted per test via the _setPoolForTests seam). Run: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler, _setPoolForTests, resolveRoutePath, APP_TIMEZONE } from './index.mjs';

// ---------------------------------------------------------------------------
// Scripted pool: routes queries by regex against the SQL text, records calls.
// ---------------------------------------------------------------------------

function makePool(routes = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      for (const r of routes) {
        if (r.match.test(text)) {
          if (r.throws) throw r.throws;
          return typeof r.result === 'function' ? r.result(text, params) : r.result;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function restEvent({ method = 'GET', path = '/', sub, email, query, body } = {}) {
  return {
    path,
    httpMethod: method,
    queryStringParameters: query ?? null,
    body: body ? JSON.stringify(body) : null,
    requestContext: sub ? { authorizer: { claims: { sub, email } } } : {},
  };
}

const parse = (res) => JSON.parse(res.body);

let pool;
beforeEach(() => {
  pool = makePool();
  _setPoolForTests(pool);
});

// ---------------------------------------------------------------------------
// CORS / routing basics
// ---------------------------------------------------------------------------

test('OPTIONS preflight returns 204 with CORS headers and hits no SQL', async () => {
  const res = await handler(restEvent({ method: 'OPTIONS', path: '/appointments' }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(pool.calls.length, 0);
});

test('unknown path without auth returns 401 (auth guard sits before the 404 fallback)', async () => {
  const res = await handler(restEvent({ path: '/nope' }));
  assert.equal(res.statusCode, 401);
});

test('unknown path with auth returns 404', async () => {
  const res = await handler(restEvent({ path: '/nope', sub: 'sub-1' }));
  assert.equal(res.statusCode, 404);
  assert.match(parse(res).error, /Not found/);
});

test('every JSON response carries CORS headers', async () => {
  const res = await handler(restEvent({ path: '/nope' }));
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(res.headers['Content-Type'], 'application/json');
});

// 1.7 — statusCode is emitted as a number, not a string. REST API Gateway
// tolerated the string form; nothing else in the stack does, and the admin
// Lambda has always used numbers.
test('statusCode is always a number, on success and on every error path', async () => {
  const cases = [
    restEvent({ method: 'OPTIONS', path: '/appointments' }), // 204
    restEvent({ path: '/genders' }),                          // 200
    restEvent({ path: '/check-availability' }),               // 400
    restEvent({ path: '/appointments' }),                     // 401
    restEvent({ path: '/nope', sub: 'sub-1' }),               // 404
  ];
  for (const event of cases) {
    const res = await handler(event);
    assert.equal(typeof res.statusCode, 'number', `${event.path} returned a ${typeof res.statusCode}`);
  }
});

// ---------------------------------------------------------------------------
// Public lookups
// ---------------------------------------------------------------------------

test('GET /genders is public and returns rows', async () => {
  _setPoolForTests(makePool([
    { match: /FROM genders/, result: { rows: [{ id: 1, name: 'Female' }] } },
  ]));
  const res = await handler(restEvent({ path: '/genders' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), [{ id: 1, name: 'Female' }]);
});

test('GET /check-availability without params returns 400', async () => {
  const res = await handler(restEvent({ path: '/check-availability' }));
  assert.equal(res.statusCode, 400);
});

test('GET /check-availability reports which field is taken', async () => {
  _setPoolForTests(makePool([
    { match: /FROM users WHERE email/, result: { rows: [{ email: 'a@b.c', phone_number: null }] } },
  ]));
  const res = await handler(restEvent({ path: '/check-availability', query: { email: 'A@B.C' } }));
  assert.deepEqual(parse(res), { exists: true, field: 'email address' });
});

// ---------------------------------------------------------------------------
// Debug table allowlist
// ---------------------------------------------------------------------------

test('GET /debug/{table} rejects non-allowlisted tables', async () => {
  const res = await handler(restEvent({ path: '/debug/pg_shadow' }));
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.length, 0); // rejected before any SQL
});

test('GET /debug/users returns rows for allowlisted table', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT \* FROM users LIMIT 100/, result: { rows: [{ id: 1 }], rowCount: 1 } },
  ]));
  const res = await handler(restEvent({ path: '/debug/users' }));
  assert.equal(parse(res).count, 1);
});

// ---------------------------------------------------------------------------
// Auth guard + access control
// ---------------------------------------------------------------------------

test('protected route without Cognito claims returns 401', async () => {
  const res = await handler(restEvent({ path: '/appointments' }));
  assert.equal(res.statusCode, 401);
});

test('accessing another user without an active relationship returns 403', async () => {
  _setPoolForTests(makePool([
    { match: /FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
    { match: /FROM user_relationships WHERE caregiver_id/, result: { rows: [] } }, // no grant
  ]));
  const res = await handler(restEvent({ path: '/appointments', sub: 'sub-1', query: { user_id: '99' } }));
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).error, 'Access Denied');
});

test('caregiver with active relationship can read a dependent', async () => {
  const appts = [{ id: 7, doctor_name: 'Dr Yu' }];
  _setPoolForTests(makePool([
    { match: /FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
    { match: /FROM user_relationships WHERE caregiver_id/, result: { rows: [{ 1: 1 }] } },
    { match: /FROM appointments a JOIN/, result: (t, params) => {
        assert.deepEqual(params, [99]); // scoped to the dependent, not self
        return { rows: appts };
      } },
  ]));
  const res = await handler(restEvent({ path: '/appointments', sub: 'sub-1', query: { user_id: '99' } }));
  assert.deepEqual(parse(res), appts);
});

// ---------------------------------------------------------------------------
// 1.1 — /me must not answer 200 with an empty body
//
// The original had two faults on adjacent lines: `res.rows.count` is always
// undefined so the not-found branch never ran, and missing braces made the 200
// unconditional. The client's res.json() then threw on an empty body, which
// made AuthContext's incomplete-profile recovery unreachable (it tests
// `!res.ok`, and the response *was* ok) and presented as a bounce to /login.
// ---------------------------------------------------------------------------

test('GET /me returns 404 when the Cognito user has no RDS row', async () => {
  _setPoolForTests(makePool([
    { match: /FROM users u/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({ path: '/me', sub: 'sub-orphan' }));
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).error, 'User not found');
});

test('GET /me returns 404 with a non-empty body the client can parse', async () => {
  _setPoolForTests(makePool([
    { match: /FROM users u/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({ path: '/me', sub: 'sub-orphan' }));
  // The specific regression: an empty string body is what made res.json() throw.
  assert.notEqual(res.body, '');
  assert.doesNotThrow(() => JSON.parse(res.body));
});

test('GET /me returns the joined profile when the row exists', async () => {
  const profile = { id: 3, full_name: 'Margaret', gender_name: 'Female', condition_name: 'General Wellness' };
  _setPoolForTests(makePool([
    { match: /FROM users u/, result: (t, params) => {
        assert.deepEqual(params, ['sub-1']);
        return { rows: [profile] };
      } },
  ]));
  const res = await handler(restEvent({ path: '/me', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), profile);
});

// ---------------------------------------------------------------------------
// 1.9 — /my-id returns an object, and 404 rather than an empty 200
// ---------------------------------------------------------------------------

test('GET /my-id returns { id } rather than a bare scalar', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 5 }] } },
  ]));
  const res = await handler(restEvent({ path: '/my-id', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), { id: 5 });
});

test('GET /my-id returns 404 when the user is missing', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({ path: '/my-id', sub: 'sub-orphan' }));
  assert.equal(res.statusCode, 404);
  assert.notEqual(res.body, '');
});

// ---------------------------------------------------------------------------
// 1.10 — /my-dependents was defined twice; the second branch was dead code and
// its query omitted relationship_type. Only the richer one should survive.
// ---------------------------------------------------------------------------

test('GET /my-dependents selects relationship_type (the surviving branch)', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
    { match: /FROM user_relationships r/, result: (t) => {
        sql = t;
        return { rows: [{ id: 9, username: 'mgt', full_name: 'Margaret', relationship_type: 'Family' }] };
      } },
  ]));
  const res = await handler(restEvent({ path: '/my-dependents', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);
  assert.match(sql, /relationship_type/);
  assert.equal(parse(res)[0].relationship_type, 'Family');
});

// ---------------------------------------------------------------------------
// /reset-db rebuilds application data but keeps accounts.
// ---------------------------------------------------------------------------

test('POST /reset-db does not drop users, and says what it preserved', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /DROP TABLE/, result: (t) => { sql = t; return { rows: [] }; } },
  ]));
  const res = await handler(restEvent({ method: 'POST', path: '/reset-db' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res).preserved, ['users', 'genders', 'conditions', 'user_relationships']);

  // The assertion that matters: the SQL actually sent, not just the response.
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS users\b/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS genders\b/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS conditions\b/);
  // Added 2026-07-31: a reset used to wipe the caregiver graph, which made every
  // D-1 feature untestable until two accounts re-paired through a verification
  // code. Preserving it is why /debug/unlink had to exist.
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS user_relationships\b/);
  assert.match(sql, /DROP TABLE IF EXISTS medication_reminders\b/);
  // And it must rebuild what it dropped, with the column whose absence broke
  // every reminder write on the live database.
  assert.match(sql, /CREATE TABLE medication_reminders/);
  assert.match(sql, /alarm_labels/);
});

// ---------------------------------------------------------------------------
// Route resolution through a *nested* proxy resource.
//
// API Gateway's `/debug/{proxy+}` sets pathParameters.proxy to only the part
// after the mount point, so rebuilding the route as `/${proxy}` turned
// `GET /debug/users` into `/users`. The visible symptom was a 401 saying
// "Cognito: login required (/users)" — and `/debug/genders` was worse, matching
// the *public* /genders route and returning a 200 full of the wrong table, which
// looks exactly like the debug dump working.
// ---------------------------------------------------------------------------

function nestedProxyEvent({ path, proxy, stage = 'production', query, method = 'GET' }) {
  return {
    path,
    httpMethod: method,
    pathParameters: { proxy },
    queryStringParameters: query ?? null,
    body: null,
    requestContext: { stage },
  };
}

test('resolveRoutePath keeps the mount point of a nested proxy resource', () => {
  assert.equal(resolveRoutePath(nestedProxyEvent({ path: '/debug/users', proxy: 'users' })), '/debug/users');
});

test('resolveRoutePath is unchanged for a root-mounted proxy resource', () => {
  assert.equal(
    resolveRoutePath(nestedProxyEvent({ path: '/medication-reminders', proxy: 'medication-reminders' })),
    '/medication-reminders'
  );
});

test('resolveRoutePath strips a stage prefix when one is present', () => {
  // REST proxy integrations do not include it; an HTTP API's rawPath does
  // whenever the stage is not $default, and this handler reads both.
  assert.equal(resolveRoutePath({ rawPath: '/production/debug/users', requestContext: { stage: 'production' } }), '/debug/users');
  assert.equal(resolveRoutePath({ rawPath: '/debug/users', requestContext: { stage: '$default' } }), '/debug/users');
});

test('resolveRoutePath falls back to the proxy parameter when no path is carried', () => {
  assert.equal(resolveRoutePath({ pathParameters: { proxy: 'genders' } }), '/genders');
  assert.equal(resolveRoutePath({}), '/');
});

test('THE REGRESSION: /debug/{table} through a nested proxy dumps the table instead of 401ing', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT \* FROM users/, result: { rows: [{ id: 1 }], rowCount: 1 } },
  ]));
  const res = await handler(nestedProxyEvent({ path: '/debug/users', proxy: 'users' }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).table, 'users');
});

test('THE REGRESSION, quieter half: /debug/genders is the dump, not the public /genders route', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT \* FROM genders/, result: { rows: [{ id: 1, name: 'Male' }], rowCount: 1 } },
  ]));
  const res = await handler(nestedProxyEvent({ path: '/debug/genders', proxy: 'genders' }));
  assert.equal(res.statusCode, 200);
  // The public route returns a bare array; the dump returns { table, count, rows }.
  // Before the fix this test passed a 200 back with the array, which is why the
  // breakage looked like a success.
  assert.equal(parse(res).table, 'genders');
});

// ---------------------------------------------------------------------------
// /debug/link and /debug/unlink — caregiver pairing fixtures.
//
// These exist because user_relationships is now preserved across a reset, so
// the reset can no longer produce a clean graph.
// ---------------------------------------------------------------------------

test('GET /debug/link pairs two users as active, skipping the code exchange', async () => {
  let inserted;
  const pool = makePool([
    { match: /SELECT id FROM users WHERE id = ANY/, result: { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } },
    {
      match: /INSERT INTO user_relationships/,
      result: (t, p) => { inserted = p; return { rows: [{ id: 9, caregiver_id: 1, dependent_id: 2, status: 'active' }], rowCount: 1 }; },
    },
  ]);
  _setPoolForTests(pool);

  const res = await handler(restEvent({ path: '/debug/link', query: { caregiver: '1', dependent: '2' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).relationship.status, 'active');
  assert.deepEqual(inserted.slice(0, 2), [1, 2]);
  assert.equal(inserted[2], 'family', 'defaults the relationship type');
});

test('GET /debug/link re-activates an existing pending row rather than failing', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE id = ANY/, result: { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } },
    { match: /INSERT INTO user_relationships/, result: (t) => { sql = t; return { rows: [{ id: 9 }], rowCount: 1 }; } },
  ]));
  await handler(restEvent({ path: '/debug/link', query: { caregiver: '1', dependent: '2' } }));
  assert.match(sql, /ON CONFLICT \(caregiver_id, dependent_id\)/);
  assert.match(sql, /DO UPDATE SET status = 'active'/);
});

test('GET /debug/link without ids returns 400 and touches no SQL', async () => {
  const pool = makePool();
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/debug/link' }));
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.length, 0);
});

test('GET /debug/link rejects a self-link', async () => {
  const pool = makePool();
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/debug/link', query: { caregiver: '3', dependent: '3' } }));
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /own caregiver/);
  assert.equal(pool.calls.length, 0);
});

test('GET /debug/link names the missing user rather than letting the FK 500', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE id = ANY/, result: { rows: [{ id: 1 }], rowCount: 1 } },
  ]));
  const res = await handler(restEvent({ path: '/debug/link', query: { caregiver: '1', dependent: '77' } }));
  assert.equal(res.statusCode, 404);
  assert.match(parse(res).error, /77/);
});

test('GET /debug/link rejects a non-numeric id instead of coercing it', async () => {
  const pool = makePool();
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/debug/link', query: { caregiver: 'abc', dependent: '2' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.length, 0);
});

test('GET /debug/unlink removes one pair', async () => {
  let params;
  _setPoolForTests(makePool([
    { match: /DELETE FROM user_relationships WHERE caregiver_id/, result: (t, p) => { params = p; return { rows: [{ id: 9 }], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({ path: '/debug/unlink', query: { caregiver: '1', dependent: '2' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(params, [1, 2]);
});

test('GET /debug/unlink on a pair that is not linked returns 404', async () => {
  _setPoolForTests(makePool([
    { match: /DELETE FROM user_relationships WHERE caregiver_id/, result: { rows: [], rowCount: 0 } },
  ]));
  const res = await handler(restEvent({ path: '/debug/unlink', query: { caregiver: '1', dependent: '2' } }));
  assert.equal(res.statusCode, 404);
});

test('GET /debug/unlink?all=1 clears the graph, which is what a reset no longer does', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /DELETE FROM user_relationships/, result: (t) => { sql = t; return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }; } },
  ]));
  const res = await handler(restEvent({ path: '/debug/unlink', query: { all: '1' } }));
  assert.equal(res.statusCode, 200);
  assert.match(parse(res).message, /Removed 2/);
  assert.doesNotMatch(sql, /WHERE/, 'the all=1 form must not be scoped');
});

test('/debug/link is not read as a table name by the dump route', async () => {
  const pool = makePool();
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/debug/link' }));
  // 400 for missing ids, not 400 for "table 'link' is restricted".
  assert.match(parse(res).error, /caregiver/);
});

// ---------------------------------------------------------------------------
// 5.1 — dose materialisation and confirmation.
//
// The half that is easy to miss is materialisation: expected doses must exist as
// rows *before* they happen, or neither the missed list (D-4) nor the escalation
// sweep (5.4) can tell "not taken" from "never scheduled".
// ---------------------------------------------------------------------------

/** The SQL text of the first call matching a pattern, for asserting shape. */
function sqlMatching(pool, pattern) {
  const hit = pool.calls.find((c) => pattern.test(c.text ?? c));
  return hit ? (hit.text ?? hit) : null;
}

test('creating a reminder materialises its doses', async () => {
  const pool = makePool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 42, user_id: 7 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 14 } },
  ]);
  _setPoolForTests(pool);

  const res = await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: { med_id: 1, alarms: ['08:00'] },
  }));
  assert.equal(res.statusCode, 200);

  const sql = sqlMatching(pool, /INSERT INTO medication_doses/);
  assert.ok(sql, 'a new reminder must materialise doses');
  assert.match(sql, /r\.id = \$1/, 'scoped to the reminder just created');
});

test('materialisation never writes a dose in the past — D-2 has no backlog', async () => {
  const pool = makePool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-reminders', sub: 'sub-1', body: { med_id: 1 } }));

  const sql = sqlMatching(pool, /INSERT INTO medication_doses/);
  assert.match(sql, /slot\.at > now\(\)/, 'a reminder created at 10:00 must not materialise this morning as missed');
});

test('materialisation resolves wall-clock alarms in the patient\'s own timezone', async () => {
  // Migration 005. `alarms` holds "HH:mm" with no zone, so turning one into a
  // timestamptz needs to know where the patient is. This was APP_TIMEZONE, a
  // module constant, until `users.timezone` existed — correct for a Taiwan-only
  // product and wrong for anyone who travels.
  const pool = makePool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-reminders', sub: 'sub-1', body: { med_id: 1 } }));

  const sql = sqlMatching(pool, /INSERT INTO medication_doses/);
  assert.match(sql, /JOIN users u ON u\.id = r\.user_id/);
  assert.match(sql, /COALESCE\(u\.timezone, \$2\)/);
  // Both the date arithmetic and the cast back must use the same zone; using
  // the constant for one and the column for the other would put every dose out
  // by the offset between them.
  assert.match(sql, /AT TIME ZONE z\.tz\)::date/);
  assert.match(sql, /AT TIME ZONE z\.tz AS at/);
});

test('materialisation still falls back to the constant if a row carries no timezone', async () => {
  // The column is NOT NULL so this cannot fire today. It means a future nullable
  // column degrades to the old behaviour rather than materialising every dose at
  // UTC midnight, which is a silent eight-hour error here.
  const pool = makePool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-reminders', sub: 'sub-1', body: { med_id: 1 } }));

  const call = pool.calls.find((c) => /INSERT INTO medication_doses/.test(c.text));
  assert.equal(call.params[1], APP_TIMEZONE);
});

test('materialisation skips inactive reminders and malformed alarm strings', async () => {
  const pool = makePool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-reminders', sub: 'sub-1', body: { med_id: 1 } }));

  const sql = sqlMatching(pool, /INSERT INTO medication_doses/);
  assert.match(sql, /r\.status = 'active'/);
  // One bad stored string must not take the whole user's materialisation down.
  assert.match(sql, /a\.alarm ~ /);
});

test('materialisation is idempotent, so re-covering the window is a no-op', async () => {
  const pool = makePool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-reminders', sub: 'sub-1', body: { med_id: 1 } }));

  const sql = sqlMatching(pool, /INSERT INTO medication_doses/);
  assert.match(sql, /ON CONFLICT \(reminder_id, scheduled_for\) DO NOTHING/);
});

test('editing a reminder clears future doses before rebuilding them', async () => {
  const pool = makePool([
    { match: /UPDATE medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /DELETE FROM medication_doses/, result: { rows: [], rowCount: 3 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 7 } },
  ]);
  _setPoolForTests(pool);

  await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: { id: 42, alarms: ['09:00'] },
  }));

  const order = pool.calls
    .map((c) => c.text ?? c)
    .filter((t) => /medication_doses/.test(t))
    .map((t) => (/^\s*DELETE/.test(t) ? 'clear' : 'materialise'));
  assert.deepEqual(order, ['clear', 'materialise'], 'rebuild, not reconcile — and in that order');
});

test('clearing spares confirmed doses and the past, which is what keeps history honest', async () => {
  const pool = makePool([
    { match: /UPDATE medication_reminders/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /DELETE FROM medication_doses/, result: { rows: [], rowCount: 0 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'PUT', path: '/medication-reminders', sub: 'sub-1', body: { id: 42 } }));

  const sql = sqlMatching(pool, /DELETE FROM medication_doses/);
  assert.match(sql, /confirmed_at IS NULL/, 'a confirmed dose records something the patient actually did');
  assert.match(sql, /scheduled_for > now\(\)/, 'a schedule change cannot un-happen yesterday');
});

test('a PUT that finds no reminder touches no doses', async () => {
  const pool = makePool([
    { match: /UPDATE medication_reminders/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({ method: 'PUT', path: '/medication-reminders', sub: 'sub-1', body: { id: 999 } }));
  assert.equal(res.statusCode, 404);
  assert.equal(sqlMatching(pool, /medication_doses/), null);
});

test('listing reminders tops the window up', async () => {
  const pool = makePool([
    { match: /SELECT r\.\*, l\.name as med_name/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, result: { rows: [], rowCount: 2 } },
  ]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/medication-reminders', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);

  const sql = sqlMatching(pool, /INSERT INTO medication_doses/);
  assert.match(sql, /r\.user_id = \$1/, 'the top-up is scoped to the user, not one reminder');
});

test('a failed top-up must not stop a patient seeing their medication list', async () => {
  const pool = makePool([
    { match: /SELECT r\.\*, l\.name as med_name/, result: { rows: [{ id: 42 }], rowCount: 1 } },
    { match: /INSERT INTO medication_doses/, throws: new Error('materialisation exploded') },
  ]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/medication-reminders', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).length, 1);
});

// --- confirmation -----------------------------------------------------------

test('POST /medication-doses confirms the dose nearest to now without being told which', async () => {
  const pool = makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /UPDATE medication_doses\s+SET confirmed_at/, result: { rows: [{ id: 5, confirmed_at: 'now' }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);

  const res = await handler(restEvent({
    method: 'POST', path: '/medication-doses', sub: 'sub-1', body: { reminder_id: 42 },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).confirmed_at, 'now');

  const lookup = sqlMatching(pool, /SELECT d\.\* FROM medication_doses/);
  assert.match(lookup, /abs\(extract\(epoch FROM \(d\.scheduled_for - now\(\)\)\)\) ASC/, 'nearest, so the client never computes a timestamp');
  assert.match(lookup, /r\.user_id = \$2/, 'scoped to the target user, not just the reminder id');
});

test('confirming twice does not overwrite who recorded it first (D-1: two devices)', async () => {
  const pool = makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /UPDATE medication_doses\s+SET confirmed_at/, result: { rows: [{ id: 5 }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-doses', sub: 'sub-1', body: { reminder_id: 42 } }));

  const sql = sqlMatching(pool, /UPDATE medication_doses\s+SET confirmed_at/);
  assert.match(sql, /confirmed_at = COALESCE\(confirmed_at, now\(\)\)/);
  assert.match(sql, /confirmed_by = COALESCE\(confirmed_by, \$2\)/);
});

test('the dose lookup prefers unconfirmed but does not exclude confirmed', async () => {
  // Found by testing against the real database, not by reasoning. Excluding
  // confirmed rows made a second confirm return 404, which made the COALESCE
  // idempotency above unreachable — and under D-1 the second confirm is the
  // caregiver's, i.e. exactly the case the column pair exists for.
  const pool = makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /UPDATE medication_doses\s+SET confirmed_at/, result: { rows: [{ id: 5 }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);
  await handler(restEvent({ method: 'POST', path: '/medication-doses', sub: 'sub-1', body: { reminder_id: 42 } }));

  const sql = sqlMatching(pool, /SELECT d\.\* FROM medication_doses/);
  assert.match(sql, /ORDER BY \(d\.confirmed_at IS NOT NULL\) ASC/, 'unconfirmed wins when one exists');
  assert.doesNotMatch(sql, /AND d\.confirmed_at IS NULL/, 'but a confirmed dose is still findable');
});

test('a dose that was never materialised returns 404 rather than pretending to record', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [], rowCount: 0 } },
  ]));
  const res = await handler(restEvent({ method: 'POST', path: '/medication-doses', sub: 'sub-1', body: { reminder_id: 42 } }));
  assert.equal(res.statusCode, 404);
});

test('POST /medication-doses without a reminder_id is a 400 and touches no SQL', async () => {
  const pool = makePool([{ match: /SELECT id FROM users/, result: { rows: [{ id: 7 }], rowCount: 1 } }]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({ method: 'POST', path: '/medication-doses', sub: 'sub-1', body: {} }));
  assert.equal(res.statusCode, 400);
  assert.equal(sqlMatching(pool, /medication_doses/), null);
});

// --- snooze (D-6, D-12) -----------------------------------------------------

test('snoozing sets snoozed_until and counts the snooze', async () => {
  const pool = makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /SET snoozed_until/, result: { rows: [{ id: 5, snooze_count: 1 }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);

  const res = await handler(restEvent({
    method: 'POST', path: '/medication-doses', sub: 'sub-1',
    body: { reminder_id: 42, action: 'snooze', minutes: 10 },
  }));
  assert.equal(res.statusCode, 200);

  const sql = sqlMatching(pool, /SET snoozed_until/);
  assert.match(sql, /snooze_count = snooze_count \+ 1/);
  // scheduled_for must not move — the missed list would rewrite history.
  assert.doesNotMatch(sql, /scheduled_for =/);
});

test('D-12: past three snoozes the response says escalation happens regardless', async () => {
  const pool = makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /SET snoozed_until/, result: { rows: [{ id: 5, snooze_count: 4 }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-doses', sub: 'sub-1',
    body: { reminder_id: 42, action: 'snooze' },
  }));
  assert.equal(parse(res).escalates_regardless, true);
});

test('at or below the threshold, snoozing still defers escalation as D-6 intends', async () => {
  const pool = makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /SET snoozed_until/, result: { rows: [{ id: 5, snooze_count: 3 }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-doses', sub: 'sub-1',
    body: { reminder_id: 42, action: 'snooze' },
  }));
  assert.equal(parse(res).escalates_regardless, false, 'three is the threshold, not the breach');
});

test('snoozing an already-confirmed dose is a 409, not a silent no-op', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /SET snoozed_until/, result: { rows: [], rowCount: 0 } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-doses', sub: 'sub-1',
    body: { reminder_id: 42, action: 'snooze' },
  }));
  assert.equal(res.statusCode, 409);
});

test('the snooze interval is clamped rather than trusted', async () => {
  let params;
  _setPoolForTests(makePool([
    { match: /SELECT d\.\* FROM medication_doses/, result: { rows: [{ id: 5 }], rowCount: 1 } },
    { match: /SET snoozed_until/, result: (t, p) => { params = p; return { rows: [{ id: 5, snooze_count: 1 }], rowCount: 1 }; } },
  ]));
  await handler(restEvent({
    method: 'POST', path: '/medication-doses', sub: 'sub-1',
    body: { reminder_id: 42, action: 'snooze', minutes: 99999 },
  }));
  assert.equal(params[1], 120);
});

// --- reading (server half of 5.7) -------------------------------------------

test('GET /medication-doses is bounded and windowed', async () => {
  const pool = makePool([
    { match: /FROM medication_doses d/, result: { rows: [{ id: 1 }], rowCount: 1 } },
  ]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({
    path: '/medication-doses', sub: 'sub-1', query: { from: '2026-07-01', to: '2026-07-31' },
  }));
  assert.equal(res.statusCode, 200);

  const sql = sqlMatching(pool, /FROM medication_doses d/);
  assert.match(sql, /LIMIT 500/, 'this table grows by ~3,000 rows per user per year');
  assert.match(sql, /d\.user_id = \$1/);
});

test('a caregiver can read a dependent\'s doses; a stranger cannot', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users/, result: { rows: [{ id: 7 }], rowCount: 1 } },
    { match: /FROM user_relationships/, result: { rows: [], rowCount: 0 } },
  ]));
  const res = await handler(restEvent({ path: '/medication-doses', sub: 'sub-1', query: { user_id: '99' } }));
  assert.equal(res.statusCode, 403);
});

test('DELETE /medication-doses is rejected with 405 rather than silently listing', async () => {
  _setPoolForTests(makePool());
  const res = await handler(restEvent({ method: 'DELETE', path: '/medication-doses', sub: 'sub-1' }));
  assert.equal(res.statusCode, 405);
});

// ---------------------------------------------------------------------------
// 3.1 — /relationships/respond never checked that the responder is the
// dependent. The caregiver is shown the handshake code when they request access
// and `id` is a sequential SERIAL, so a caregiver could approve their own
// request; and the deny branch was a bare DELETE by id, so any authenticated
// user could delete any relationship by guessing one.
//
// The assertions below check the *scoping of the write*, not just the status
// code — a 404 with an unscoped UPDATE still behind it would pass a status-only
// test while leaving the hole open.
// ---------------------------------------------------------------------------

test('POST /relationships/respond approves when the responder is the dependent', async () => {
  let updateParams;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /SELECT verification_code FROM user_relationships/, result: { rows: [{ verification_code: 'TISH-123' }] } },
    { match: /UPDATE user_relationships SET status/, result: (t, p) => { updateParams = p; return { rows: [], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-dependent',
    body: { request_id: 5, action: 'active', provided_code: 'TISH-123' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).message, 'Granted');
  // The dependent id must be part of the write, not merely of an earlier check.
  assert.deepEqual(updateParams, ['active', 5, 7]);
});

test('POST /relationships/respond returns 404 when the responder is not the dependent', async () => {
  let selectParams;
  // **Bound to a local, and that is not a style preference.** The outer `pool`
  // is rebuilt by `beforeEach` and then *replaced* by this call, so the
  // "no UPDATE was attempted" assertion below used to read the call list of a
  // pool the handler never touched — always empty, always passing. Found in
  // session 8 when a new test written to the same pattern crashed on it instead
  // of quietly passing. This is the only assertion in the 3.1 block that checks
  // an *absence*, so it is the only one the mistake could hide.
  const scripted = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 99 }] } },
    // Scoped by dependent_id, so somebody else's request matches nothing.
    { match: /SELECT verification_code FROM user_relationships/, result: (t, p) => { selectParams = p; return { rows: [] }; } },
  ]);
  _setPoolForTests(scripted);
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-caregiver',
    body: { request_id: 5, action: 'active', provided_code: 'TISH-123' },
  }));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(selectParams, [5, 99]);
  // Knowing the code must not be enough: no UPDATE may have been attempted.
  assert.equal(scripted.calls.filter((c) => /UPDATE user_relationships/.test(c.text)).length, 0);
});

test('POST /relationships/respond scopes the lookup by dependent_id, not by id alone', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /SELECT verification_code FROM user_relationships/, result: (t) => { sql = t; return { rows: [] }; } },
  ]));
  await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-dependent',
    body: { request_id: 5, action: 'active', provided_code: 'nope' },
  }));
  assert.match(sql, /dependent_id/);
});

test('POST /relationships/respond still rejects a wrong handshake code', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /SELECT verification_code FROM user_relationships/, result: { rows: [{ verification_code: 'TISH-123' }] } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-dependent',
    body: { request_id: 5, action: 'active', provided_code: 'TISH-999' },
  }));
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).error, 'Security Mismatch');
});

test('POST /relationships/respond denies when the responder is the dependent', async () => {
  let deleteParams;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /DELETE FROM user_relationships/, result: (t, p) => { deleteParams = p; return { rows: [{ id: 5 }], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-dependent',
    body: { request_id: 5, action: 'denied' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).message, 'Denied');
  assert.deepEqual(deleteParams, [5, 7]);
});

test('POST /relationships/respond deny by a non-participant deletes nothing and returns 404', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 99 }] } },
    { match: /DELETE FROM user_relationships/, result: (t) => { sql = t; return { rows: [], rowCount: 0 } } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-stranger',
    body: { request_id: 5, action: 'denied' },
  }));
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).message, undefined);
  // The DELETE is allowed to run, but only ever scoped — an unscoped one would
  // have deleted a stranger's relationship before we could report 404.
  assert.match(sql, /dependent_id/);
});

// ---------------------------------------------------------------------------
// 3.2 — revocation.
//
// The point of the feature is that access *stops*, so the assertions below are
// mostly about the scoping of the write and about what the row looks like
// afterwards. `checkAccess` already filters on `status = 'active'`, which is why
// there is no enforcement code to test: the last test in this block pins that
// dependency, because the day somebody "simplifies" that filter away is the day
// revocation silently stops working with every test here still green.
// ---------------------------------------------------------------------------

test('POST /relationships/revoke lets the dependent withdraw access', async () => {
  let updateParams;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    {
      match: /UPDATE user_relationships\s+SET status = 'revoked'/,
      result: (t, p) => { updateParams = p; return { rows: [{ caregiver_id: 3, dependent_id: 7 }], rowCount: 1 }; },
    },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-dependent',
    body: { relationship_id: 5 },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).message, 'Access revoked.');
  assert.deepEqual(updateParams, [5, 7]);
});

test('POST /relationships/revoke lets the caregiver step back too', async () => {
  // Wider than /relationships/respond's dependent-only rule, deliberately: a
  // caregiver who no longer wants the responsibility must not need the other
  // person to act. Same row, same route, caller is the caregiver this time.
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 3 }] } },
    {
      match: /UPDATE user_relationships\s+SET status = 'revoked'/,
      result: { rows: [{ caregiver_id: 3, dependent_id: 7 }], rowCount: 1 },
    },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-caregiver',
    body: { relationship_id: 5 },
  }));
  assert.equal(res.statusCode, 200);
});

test('THE REVOKE IS SCOPED TO A PARTICIPANT, in the WHERE clause rather than a prior check', async () => {
  // 3.1's shape: ownership in the UPDATE itself, so there is no window between
  // checking and writing and two racing revokes cannot both pass a check. A
  // status-only test would be satisfied by an unscoped UPDATE that returned 404
  // *after* revoking a stranger's relationship.
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 99 }] } },
    { match: /UPDATE user_relationships\s+SET status = 'revoked'/, result: (t) => { sql = t; return { rows: [], rowCount: 0 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-stranger',
    body: { relationship_id: 5 },
  }));
  assert.equal(res.statusCode, 404);
  assert.match(sql, /caregiver_id = \$2 OR dependent_id = \$2/);
});

test('a non-participant gets 404 rather than 403, because ids are guessable', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 99 }] } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-stranger',
    body: { relationship_id: 5 },
  }));
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).error, 'Relationship not found');
});

test('revoking twice is a 200, not a 404 — the same idempotency 5.1 needed', async () => {
  // Two devices, or one impatient double-tap. Reporting "not found" for a
  // revocation that has already succeeded reads to the user as "it did not
  // work", which is exactly the non-idempotent lookup §0.6 records against 5.1's
  // second confirm.
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /UPDATE user_relationships\s+SET status = 'revoked'/, result: { rows: [], rowCount: 0 } },
    { match: /SELECT 1 FROM user_relationships/, result: { rows: [{ '?column?': 1 }], rowCount: 1 } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-dependent',
    body: { relationship_id: 5 },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).message, 'Access already revoked.');
});

test('the already-revoked lookup is scoped too, so it cannot confirm a stranger\'s relationship', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /UPDATE user_relationships\s+SET status = 'revoked'/, result: { rows: [], rowCount: 0 } },
    { match: /SELECT 1 FROM user_relationships/, result: (t) => { sql = t; return { rows: [], rowCount: 0 }; } },
  ]));
  await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-dependent',
    body: { relationship_id: 5 },
  }));
  assert.match(sql, /caregiver_id = \$2 OR dependent_id = \$2/);
});

test('a missing relationship_id is a 400 and touches no relationship row', async () => {
  const scripted = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
  ]);
  _setPoolForTests(scripted);
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-dependent', body: {},
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(
    scripted.calls.filter((c) => /user_relationships/.test(c.text)).length,
    0,
    'a malformed request must not reach the table at all'
  );
});

test('revoking enqueues an access-revoked push for THE CAREGIVER, not the dependent', async () => {
  // The whole reason the row is filed under the caregiver. The drain resolves
  // `schedule-changed` recipients through `user_relationships ... status =
  // 'active'`, so a row filed under the dependent reaches every device except
  // the one still holding their alarms.
  let outboxParams;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    {
      match: /UPDATE user_relationships\s+SET status = 'revoked'/,
      result: { rows: [{ caregiver_id: 3, dependent_id: 7 }], rowCount: 1 },
    },
    { match: /INSERT INTO push_outbox/, result: (t, p) => { outboxParams = p; return { rows: [{ id: 1 }] }; } },
  ]));
  await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-dependent',
    body: { relationship_id: 5 },
  }));
  assert.deepEqual(outboxParams, [3, 'access-revoked', null]);
});

test('a failed revocation enqueues nothing', async () => {
  const scripted = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 99 }] } },
    { match: /UPDATE user_relationships\s+SET status = 'revoked'/, result: { rows: [], rowCount: 0 } },
  ]);
  _setPoolForTests(scripted);
  await handler(restEvent({
    method: 'POST', path: '/relationships/revoke', sub: 'sub-stranger',
    body: { relationship_id: 5 },
  }));
  assert.equal(scripted.calls.filter((c) => /INSERT INTO push_outbox/.test(c.text)).length, 0);
});

test('ENFORCEMENT IS checkAccess FILTERING ON active, which is the whole of it', async () => {
  // Revocation ships no enforcement code of its own — it relies entirely on
  // every scoped route already resolving access through a query that requires
  // `status = 'active'`. This test exists so that dependency is written down
  // somewhere executable: remove the filter and revocation silently stops
  // working while every other test in this block stays green.
  let accessSql;
  const scripted = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 3 }] } },
    {
      match: /SELECT 1 FROM user_relationships WHERE caregiver_id/,
      result: (t) => { accessSql = t; return { rows: [] }; },
    },
  ]);
  _setPoolForTests(scripted);
  const res = await handler(restEvent({
    path: '/medication-reminders', sub: 'sub-caregiver', query: { user_id: '7' },
  }));
  assert.match(accessSql, /status = \$3/);
  assert.equal(scripted.calls.find((c) => /SELECT 1 FROM user_relationships/.test(c.text)).params[2], 'active');
  // And the route really does refuse once the relationship stops matching.
  assert.equal(parse(res).error, 'Access Denied');
});

test('GET /relationships/granted reports both directions with the other party named', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    {
      match: /FROM user_relationships r\s+JOIN users other/,
      result: (t) => {
        sql = t;
        return { rows: [{ id: 5, status: 'active', role: 'caregiver', other_user_id: 3, other_username: 'ann' }] };
      },
    },
  ]));
  const res = await handler(restEvent({ path: '/relationships/granted', sub: 'sub-dependent' }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res)[0].role, 'caregiver');
  // Both directions, because either participant may revoke.
  assert.match(sql, /r\.caregiver_id = \$1 OR r\.dependent_id = \$1/);
  // Revoked rows are history, not access — they must not appear in a list whose
  // whole purpose is "who can see my records right now".
  assert.match(sql, /r\.status IN \('pending', 'active'\)/);
});

test('re-requesting a revoked pair reactivates the row instead of failing on the unique key', async () => {
  // The consequence of keeping the row rather than deleting it:
  // UNIQUE(caregiver_id, dependent_id) makes a bare INSERT fail forever after
  // the first revocation, which would make revocation a one-way door.
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 3 }] } },
    { match: /SELECT id FROM users WHERE email/, result: { rows: [{ id: 7 }] } },
    { match: /INSERT INTO user_relationships/, result: (t) => { sql = t; return { rows: [{ id: 5 }], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/request', sub: 'sub-caregiver',
    body: { dependent_email: 'pat@example.com', relationship_type: 'family' },
  }));
  assert.equal(res.statusCode, 200);
  assert.match(parse(res).handshakeCode, /^TISH-\d{3}$/);
  assert.match(sql, /ON CONFLICT \(caregiver_id, dependent_id\) DO UPDATE/);
  // Cleared, or migration 007's CHECK rejects the write — a live relationship
  // must not carry a revoked_at.
  assert.match(sql, /revoked_at = NULL/);
  assert.match(sql, /revoked_by = NULL/);
});

test('re-requesting access that is ALREADY ACTIVE is refused rather than downgraded', async () => {
  // The DO UPDATE is guarded on `status <> 'active'`, so an accidental
  // re-request cannot knock a live relationship back to pending and demand a
  // fresh code from the dependent. Returning a handshake code nobody will be
  // asked for is the silent-failure shape Phase 1 exists to remove.
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 3 }] } },
    { match: /SELECT id FROM users WHERE email/, result: { rows: [{ id: 7 }] } },
    { match: /INSERT INTO user_relationships/, result: (t) => { sql = t; return { rows: [], rowCount: 0 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/request', sub: 'sub-caregiver',
    body: { dependent_email: 'pat@example.com', relationship_type: 'family' },
  }));
  assert.equal(res.statusCode, 409);
  assert.equal(parse(res).handshakeCode, undefined);
  assert.match(sql, /WHERE user_relationships\.status <> 'active'/);
});

test('A STALE HANDSHAKE CODE CANNOT RESURRECT A REVOKED RELATIONSHIP', async () => {
  // Before revocation existed, a row was only ever pending or active, so
  // `/relationships/respond` had no reason to filter on status. Now the revoked
  // row survives in the table carrying its old verification_code — and without
  // this filter, replaying that code re-grants access the dependent has
  // deliberately ended.
  let sql;
  const scripted = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /SELECT verification_code FROM user_relationships/, result: (t) => { sql = t; return { rows: [] }; } },
  ]);
  _setPoolForTests(scripted);
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-dependent',
    body: { request_id: 5, action: 'active', provided_code: 'TISH-123' },
  }));
  assert.equal(res.statusCode, 404);
  assert.match(sql, /status = 'pending'/);
  assert.equal(scripted.calls.filter((c) => /UPDATE user_relationships/.test(c.text)).length, 0);
});

test('the deny branch cannot delete a revoked row, because that is the access history', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    { match: /DELETE FROM user_relationships/, result: (t) => { sql = t; return { rows: [], rowCount: 0 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/relationships/respond', sub: 'sub-dependent',
    body: { request_id: 5, action: 'denied' },
  }));
  assert.equal(res.statusCode, 404);
  assert.match(sql, /status = 'pending'/);
});

test('/debug/link clears the revocation columns when it re-links a revoked pair', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /SELECT id FROM users WHERE id = ANY/, result: { rows: [{ id: 1 }, { id: 2 }] } },
    { match: /INSERT INTO user_relationships/, result: (t) => { sql = t; return { rows: [{ id: 5 }], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({ path: '/debug/link', query: { caregiver: '1', dependent: '2' } }));
  assert.equal(res.statusCode, 200);
  assert.match(sql, /revoked_at = NULL/);
  assert.match(sql, /revoked_by = NULL/);
});

// ---------------------------------------------------------------------------
// 1.3 — /medication-library was method-blind: a POST fell into the GET branch
// and returned the unchanged list with 200, so the dialog reported success and
// saved nothing.
// ---------------------------------------------------------------------------

test('GET /medication-library still lists the library', async () => {
  _setPoolForTests(makePool([
    { match: /SELECT \* FROM medication_library/, result: { rows: [{ id: 1, name: 'Aspirin' }] } },
  ]));
  const res = await handler(restEvent({ path: '/medication-library', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), [{ id: 1, name: 'Aspirin' }]);
});

test('POST /medication-library actually inserts and returns 201', async () => {
  let inserted;
  _setPoolForTests(makePool([
    { match: /INSERT INTO medication_library/, result: (t, params) => {
        inserted = params;
        return { rows: [{ id: 42, name: 'Aspirin', default_dosage: '100mg' }] };
      } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-library', sub: 'sub-1',
    body: { name: '  Aspirin  ', default_dosage: ' 100mg ' },
  }));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(inserted, ['Aspirin', '100mg']); // trimmed
  assert.equal(parse(res).id, 42);
});

test('POST /medication-library rejects a missing name with 400 and no SQL', async () => {
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-library', sub: 'sub-1',
    body: { default_dosage: '100mg' },
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.length, 0);
});

test('DELETE /medication-library is rejected with 405 rather than silently listing', async () => {
  const res = await handler(restEvent({ method: 'DELETE', path: '/medication-library', sub: 'sub-1' }));
  assert.equal(res.statusCode, 405);
  assert.equal(pool.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 1.4 / 1.11 — /register-profile sits above the auth guard, so it needs its own
// check; and its upsert must refresh every mutable column, because retrying a
// partial signup is the documented recovery path for the Cognito/RDS split.
// ---------------------------------------------------------------------------

test('POST /register-profile without a token returns 401, not a 500 TypeError', async () => {
  const res = await handler(restEvent({
    method: 'POST', path: '/register-profile',
    body: { username: 'nobody', full_name: 'No Body' },
  }));
  assert.equal(res.statusCode, 401);
  assert.equal(pool.calls.length, 0); // never reached the database
});

test('POST /register-profile upserts every mutable profile column', async () => {
  let sql;
  let params;
  _setPoolForTests(makePool([
    { match: /INSERT INTO users/, result: (t, p) => {
        sql = t;
        params = p;
        return { rows: [{ id: 7 }] };
      } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/register-profile', sub: 'sub-1', email: 'm@example.com',
    body: {
      username: 'margaret', full_name: 'Margaret Chen', birth_date: '1948-03-02',
      gender_id: 2, condition_id: 4, phone_number: '+886912345678', role: 'civilian',
    },
  }));
  assert.equal(res.statusCode, 200);

  // The regression: only full_name was refreshed on conflict, so a retry with
  // a corrected gender/condition/birth date/phone silently kept the old values.
  const onConflict = sql.slice(sql.indexOf('ON CONFLICT'));
  for (const col of ['username', 'email', 'phone_number', 'role', 'full_name', 'birth_date', 'gender_id', 'condition_id']) {
    assert.match(onConflict, new RegExp(`${col}\\s*=\\s*EXCLUDED\\.${col}`), `ON CONFLICT does not refresh ${col}`);
  }

  // Email is taken from the verified token, not the request body.
  assert.equal(params[0], 'sub-1');
  assert.equal(params[2], 'm@example.com');
  assert.equal(params[3], '+886912345678');
  assert.equal(params[6], '1948-03-02');
});

// ---------------------------------------------------------------------------
// 1.5 — /admin/stats returned bigint counts as strings, so totalUsers + 1 was
// the string "421".
// ---------------------------------------------------------------------------

test('GET /admin/stats returns counts as numbers', async () => {
  _setPoolForTests(makePool([
    { match: /COUNT\(\*\)::int AS count FROM users/, result: { rows: [{ count: 42 }] } },
    { match: /COUNT\(\*\)::int AS count FROM appointments/, result: { rows: [{ count: 7 }] } },
  ]));
  const res = await handler(restEvent({ path: '/admin/stats', sub: 'sub-1' }));
  const stats = parse(res);
  assert.equal(typeof stats.totalUsers, 'number');
  assert.equal(typeof stats.totalMissions, 'number');
  assert.equal(stats.totalUsers + 1, 43); // arithmetic, not concatenation
});

test('GET /admin/stats casts in SQL rather than in JS', async () => {
  // The pool is bound to a local rather than left to the `beforeEach` one: this
  // asserts over `calls`, and the outer `pool` is a *different*, unused pool
  // whose call list is always empty. See the note on the 3.1 deny test.
  const scripted = makePool([
    { match: /COUNT/, result: { rows: [{ count: 1 }] } },
  ]);
  _setPoolForTests(scripted);
  await handler(restEvent({ path: '/admin/stats', sub: 'sub-1' }));
  assert.ok(scripted.calls.length > 0, 'the route must have queried something');
  for (const call of scripted.calls) assert.match(call.text, /::int/);
});

// ---------------------------------------------------------------------------
// Medication reminders — regression coverage for the alarm-labels feature
// ---------------------------------------------------------------------------

const selfPool = (extra = []) => makePool([
  { match: /FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
  ...extra,
]);

// ---------------------------------------------------------------------------
// Reading /medication-reminders parameters by column name rather than position.
//
// These two statements have now grown twice — alarm_sources in 4.8, then four
// escalation/burst columns in 4.6 — and each time every positional index after
// the insertion point shifted, including the id/user_id scoping params at the
// end of the UPDATE. Renumbering by hand is exactly the kind of edit that
// silently asserts the wrong thing: swap two indices and the test still passes
// while checking nothing it claims to.
//
// Mapping name -> value from the SQL itself removes the churn and makes the
// assertions say what they mean. The count assertions stay, because
// placeholder/column arity is a real failure mode these cannot catch.
// ---------------------------------------------------------------------------

/** For `INSERT INTO t (a, b, c) VALUES ($1, $2, COALESCE($3, x))`. */
function insertedByColumn(sql, params) {
  const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
  return Object.fromEntries(columns.map((name, i) => [name, params[i]]));
}

/** For `UPDATE t SET a = COALESCE($1, a), b = COALESCE($2, b) WHERE ...`. */
function updatedByColumn(sql, params) {
  const out = {};
  for (const m of sql.matchAll(/([a-z_]+)\s*=\s*COALESCE\(\$(\d+)/g)) {
    out[m[1]] = params[Number(m[2]) - 1];
  }
  return out;
}

test('POST /medication-reminders inserts alarms, labels and sources', async () => {
  let inserted;
  let sql;
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: (t, params) => {
        sql = t;
        inserted = params;
        return { rows: [{ id: 5 }] };
      } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: {
      med_id: 2, selected_dosage: '30mg',
      at_breakfast: true, breakfast_timing: 'after',
      at_lunch: false, lunch_timing: 'none',
      at_dinner: false, dinner_timing: 'none',
      at_bedtime: false, frequency_days: 1,
      alarms: ['08:30', '19:00'],
      alarm_labels: ['After breakfast', 'Before dinner'],
      alarm_sources: ['breakfast:after', 'dinner:before'],
      reminder_sound: 'calm',
    },
  }));
  assert.equal(res.statusCode, 200);
  const cols = insertedByColumn(sql, inserted);
  assert.deepEqual(cols.alarms, ['08:30', '19:00']);
  assert.deepEqual(cols.alarm_labels, ['After breakfast', 'Before dinner']);
  assert.equal(cols.reminder_sound, 'calm');
  assert.deepEqual(cols.alarm_sources, ['breakfast:after', 'dinner:before']);

  // The placeholder count has to match the column count, or Postgres rejects
  // the whole statement at runtime — which no other assertion here would catch.
  const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').length;
  const placeholders = (sql.match(/\$\d+/g) || []).length;
  assert.equal(columns, inserted.length);
  assert.equal(placeholders, inserted.length);
});

test('POST /medication-reminders keeps alarm_sources aligned with alarms', async () => {
  // 4.8's whole mechanism rests on these two arrays being positionally
  // aligned: a misalignment silently reclassifies a hand-set alarm as
  // meal-derived, and the next meal-time change then overwrites it.
  let inserted;
  let sql;
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: (t, params) => { sql = t; inserted = params; return { rows: [{ id: 5 }] }; } },
  ]));
  await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: {
      med_id: 2,
      alarms: ['08:00', '12:00', '22:00'],
      alarm_labels: ['Manual', 'After lunch', 'Bedtime'],
      alarm_sources: ['manual', 'lunch:after', 'bedtime:at'],
    },
  }));
  const cols = insertedByColumn(sql, inserted);
  assert.equal(cols.alarms.length, cols.alarm_sources.length);
  assert.equal(cols.alarms.length, cols.alarm_labels.length);
});

test('PUT /medication-reminders sends a full COALESCE update with id+user scoping last', async () => {
  let updated;
  let sql;
  _setPoolForTests(selfPool([
    { match: /UPDATE medication_reminders SET/, result: (t, params) => {
        sql = t;
        updated = params;
        return { rows: [{ id: 5 }] };
      } },
  ]));
  await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: { id: 5, status: 'inactive' },
  }));
  const cols = updatedByColumn(sql, updated);
  assert.equal(cols.status, 'inactive');
  // alarm_sources was omitted from the body. node-postgres sends a nullish
  // parameter as NULL, so COALESCE keeps whatever is already stored — the same
  // contract every other optional field in this statement relies on.
  assert.equal(cols.alarm_sources ?? null, null);

  // The id/user placeholders must be the last two params, whatever the SET list
  // has grown to, and the WHERE clause must reference exactly those two.
  const setCount = Object.keys(cols).length;
  assert.equal(updated.length, setCount + 2);
  assert.equal(updated[setCount], 5);       // id
  assert.equal(updated[setCount + 1], 1);   // user scoping
  assert.match(sql, new RegExp(`WHERE id = \\$${setCount + 1} AND user_id = \\$${setCount + 2}`));
});

test('PUT /medication-reminders updates alarm_sources when meal times are re-resolved', async () => {
  let updated;
  let sql;
  _setPoolForTests(selfPool([
    { match: /UPDATE medication_reminders SET/, result: (t, params) => { sql = t; updated = params; return { rows: [{ id: 5 }] }; } },
  ]));
  await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: {
      id: 5,
      alarms: ['09:00', '20:00'],
      alarm_labels: ['After breakfast', 'Before dinner'],
      alarm_sources: ['breakfast:after', 'dinner:before'],
    },
  }));
  const cols = updatedByColumn(sql, updated);
  assert.deepEqual(cols.alarms, ['09:00', '20:00']);
  assert.deepEqual(cols.alarm_sources, ['breakfast:after', 'dinner:before']);
});

// ---------------------------------------------------------------------------
// 4.6 / 2.4 / 2.6 — escalation settings and the alarm burst count, end to end
// through the API. D-3: per-medication, not a global constant.
// ---------------------------------------------------------------------------

test('POST /medication-reminders persists escalation settings and burst count', async () => {
  let inserted;
  let sql;
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: (t, params) => { sql = t; inserted = params; return { rows: [{ id: 5 }] }; } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: {
      med_id: 2, alarms: ['08:00'],
      escalation_enabled: true, escalation_delay_minutes: 15,
      escalation_order: 'caregiver_first', alarm_repeat_count: 5,
    },
  }));
  assert.equal(res.statusCode, 200);
  const cols = insertedByColumn(sql, inserted);
  assert.equal(cols.escalation_enabled, true);
  assert.equal(cols.escalation_delay_minutes, 15);
  assert.equal(cols.escalation_order, 'caregiver_first');
  assert.equal(cols.alarm_repeat_count, 5);
});

test('POST /medication-reminders defaults the escalation columns when omitted', async () => {
  // These columns are NOT NULL, and a column DEFAULT only applies when the
  // column is omitted from the statement — this INSERT always lists all of them,
  // so an omitted field arrives as an explicit NULL and would be rejected. The
  // COALESCE wrappers in the SQL are what make omission work.
  let sql;
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: (t) => { sql = t; return { rows: [{ id: 5 }] }; } },
  ]));
  await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: { med_id: 2, alarms: ['08:00'] },
  }));
  assert.match(sql, /COALESCE\(\$\d+,false\)/);
  assert.match(sql, /COALESCE\(\$\d+,30\)/);
  assert.match(sql, /COALESCE\(\$\d+,'caregiver_first'\)/);
  assert.match(sql, /COALESCE\(\$\d+,3\)/);
});

test('PUT /medication-reminders can toggle escalation without touching anything else', async () => {
  let updated;
  let sql;
  _setPoolForTests(selfPool([
    { match: /UPDATE medication_reminders SET/, result: (t, params) => { sql = t; updated = params; return { rows: [{ id: 5 }] }; } },
  ]));
  await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: { id: 5, escalation_enabled: true, escalation_delay_minutes: 60 },
  }));
  const cols = updatedByColumn(sql, updated);
  assert.equal(cols.escalation_enabled, true);
  assert.equal(cols.escalation_delay_minutes, 60);
  // Everything unmentioned must stay nullish so COALESCE preserves it.
  assert.equal(cols.alarms ?? null, null);
  assert.equal(cols.escalation_order ?? null, null);
  assert.equal(cols.alarm_repeat_count ?? null, null);
});

test('escalation_delay_minutes outside 5-240 is a 400, not a constraint violation', async () => {
  // Migration 002 has a CHECK on this, so without the API guard an out-of-range
  // value reaches Postgres and comes back through the one-line error contract as
  // a 500 carrying internal English prose (Phase 6).
  for (const value of [4, 241, 30.5, 'soon']) {
    _setPoolForTests(selfPool([
      { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 5 }] } },
    ]));
    const res = await handler(restEvent({
      method: 'POST', path: '/medication-reminders', sub: 'sub-1',
      body: { med_id: 2, escalation_delay_minutes: value },
    }));
    assert.equal(res.statusCode, 400, `expected 400 for delay ${value}`);
    assert.match(parse(res).error, /escalation_delay_minutes/);
  }
});

test('alarm_repeat_count outside 1-6 is a 400', async () => {
  for (const value of [0, 7, 2.5]) {
    _setPoolForTests(selfPool([
      { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 5 }] } },
    ]));
    const res = await handler(restEvent({
      method: 'POST', path: '/medication-reminders', sub: 'sub-1',
      body: { med_id: 2, alarm_repeat_count: value },
    }));
    assert.equal(res.statusCode, 400, `expected 400 for count ${value}`);
    assert.match(parse(res).error, /alarm_repeat_count/);
  }
});

test('an unknown escalation_order is a 400, and both valid values are accepted', async () => {
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 5 }] } },
  ]));
  const bad = await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: { med_id: 2, escalation_order: 'patient_first' },
  }));
  assert.equal(bad.statusCode, 400);
  assert.match(parse(bad).error, /escalation_order/);

  // 'sms_first' is accepted by the API even though D-8 keeps it unselectable in
  // the UI until Track B lands. 5.4's channel fallback is what handles a rung
  // whose transport cannot send, so rejecting it here would be a redundant gate.
  for (const order of ['caregiver_first', 'sms_first']) {
    _setPoolForTests(selfPool([
      { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 5 }] } },
    ]));
    const res = await handler(restEvent({
      method: 'POST', path: '/medication-reminders', sub: 'sub-1',
      body: { med_id: 2, escalation_order: order },
    }));
    assert.equal(res.statusCode, 200, `expected ${order} to be accepted`);
  }
});

test('a validation failure writes nothing', async () => {
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: { rows: [{ id: 5 }] } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/medication-reminders', sub: 'sub-1',
    body: { med_id: 2, alarm_repeat_count: 99 },
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.filter((c) => /INSERT INTO medication_reminders/.test(c.text)).length, 0);
});

// ---------------------------------------------------------------------------
// 2.7 / 4.8 — meal times. Without these, "before dinner" cannot be turned into
// a clock time, which is why meal selections were never scheduled at all.
// ---------------------------------------------------------------------------

test('GET /meal-times returns the four preferences', async () => {
  const times = { breakfast_time: '08:00:00', lunch_time: '12:30:00', dinner_time: '18:30:00', bedtime_time: '22:00:00' };
  _setPoolForTests(selfPool([
    { match: /SELECT breakfast_time/, result: { rows: [times] } },
  ]));
  const res = await handler(restEvent({ path: '/meal-times', sub: 'sub-1' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), times);
});

test('PUT /meal-times updates only the supplied columns', async () => {
  let params;
  _setPoolForTests(selfPool([
    { match: /UPDATE users SET/, result: (t, p) => {
        params = p;
        return { rows: [{ breakfast_time: '07:15:00', lunch_time: '12:30:00', dinner_time: '18:30:00', bedtime_time: '22:00:00' }] };
      } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/meal-times', sub: 'sub-1',
    body: { breakfast_time: '07:15' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(params[0], '07:15');
  // The three omitted meals arrive as null so COALESCE keeps their stored values.
  assert.deepEqual(params.slice(1, 4), [null, null, null]);
  assert.equal(parse(res).breakfast_time, '07:15:00');
});

test('PUT /meal-times rejects a malformed time with 400 rather than a 500 from the driver', async () => {
  const res = await handler(restEvent({
    method: 'PUT', path: '/meal-times', sub: 'sub-1',
    body: { dinner_time: '25:99' },
  }));
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /dinner_time/);
});

test('PUT /meal-times accepts both HH:mm and Postgres HH:mm:ss', async () => {
  _setPoolForTests(selfPool([
    { match: /UPDATE users SET/, result: { rows: [{ breakfast_time: '07:15:00' }] } },
  ]));
  for (const value of ['07:15', '07:15:00', '00:00', '23:59']) {
    const res = await handler(restEvent({
      method: 'PUT', path: '/meal-times', sub: 'sub-1', body: { breakfast_time: value },
    }));
    assert.equal(res.statusCode, 200, `rejected valid time ${value}`);
  }
});

test('PUT /meal-times returns 404 when the user row is gone', async () => {
  _setPoolForTests(selfPool([
    { match: /UPDATE users SET/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/meal-times', sub: 'sub-1', body: { lunch_time: '13:00' },
  }));
  assert.equal(res.statusCode, 404);
});

test('DELETE /meal-times is rejected with 405', async () => {
  _setPoolForTests(selfPool());
  const res = await handler(restEvent({ method: 'DELETE', path: '/meal-times', sub: 'sub-1' }));
  assert.equal(res.statusCode, 405);
});

test('a caregiver without an active relationship cannot read a dependent meal times', async () => {
  _setPoolForTests(makePool([
    { match: /FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
    { match: /FROM user_relationships WHERE caregiver_id/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({ path: '/meal-times', sub: 'sub-1', query: { user_id: '99' } }));
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// 1.14 — a PUT matching no rows returned an empty body with 200. Worst in
// medication-reminder-form, where the resulting res.json() throw was caught
// and ignored, so the app scheduled notifications from local state for a
// reminder the server never updated.
// ---------------------------------------------------------------------------

test('PUT /medication-reminders returns 404 when the id matches no row', async () => {
  _setPoolForTests(selfPool([
    { match: /UPDATE medication_reminders SET/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: { id: 999, status: 'inactive' },
  }));
  assert.equal(res.statusCode, 404);
  assert.notEqual(res.body, '');
  assert.doesNotThrow(() => JSON.parse(res.body));
});

test('PUT /appointments returns 404 when the id matches no row', async () => {
  _setPoolForTests(selfPool([
    { match: /UPDATE appointments SET/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/appointments', sub: 'sub-1',
    body: { id: 999, status_id: 4 },
  }));
  assert.equal(res.statusCode, 404);
  assert.notEqual(res.body, '');
});

test('PUT /test-results returns 404 when the id matches no row', async () => {
  _setPoolForTests(selfPool([
    { match: /UPDATE test_results SET/, result: { rows: [] } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/test-results', sub: 'sub-1',
    body: { id: 999, field_1: 5 },
  }));
  assert.equal(res.statusCode, 404);
  assert.notEqual(res.body, '');
});

test('a PUT that does match a row still returns it with 200', async () => {
  _setPoolForTests(selfPool([
    { match: /UPDATE medication_reminders SET/, result: { rows: [{ id: 5, status: 'inactive' }] } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: { id: 5, status: 'inactive' },
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), { id: 5, status: 'inactive' });
});

test('POST /test-results is unaffected by the PUT 404 guard', async () => {
  _setPoolForTests(selfPool([
    { match: /INSERT INTO test_results/, result: { rows: [{ id: 11 }] } },
  ]));
  const res = await handler(restEvent({
    method: 'POST', path: '/test-results', sub: 'sub-1',
    body: { field_1: 5 },
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), { id: 11 });
});

// ---------------------------------------------------------------------------
// 5.8 — push token registration (D-5)
// ---------------------------------------------------------------------------

/** The pool every /push-tokens test starts from: a caller who has a profile. */
function poolWithUser(routes = []) {
  const pool = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [{ id: 7 }] } },
    ...routes,
  ]);
  _setPoolForTests(pool);
  return pool;
}

test('POST /push-tokens registers the device against the caller', async () => {
  const pool = poolWithUser([
    { match: /INSERT INTO push_tokens/, result: { rows: [{ id: 1, user_id: 7, token: 'ExponentPushToken[abc]' }] } },
  ]);

  const res = await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-1',
    body: { token: 'ExponentPushToken[abc]', platform: 'ios' },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).user_id, 7);
  const insert = sqlMatching(pool, /INSERT INTO push_tokens/);
  assert.match(insert, /ON CONFLICT \(token\) DO UPDATE/, 'called on every launch, so re-registering must not fail');
  assert.match(insert, /last_seen_at = now\(\)/);
});

test('A DEVICE THAT CHANGES HANDS MOVES TO THE NEW OWNER', async () => {
  // The upsert must reassign `user_id`, not just refresh the timestamp.
  // Otherwise a reinstall under another account — or a shared family tablet —
  // leaves the previous owner receiving the new owner's notifications, which
  // here means somebody else's medication schedule arriving on their phone.
  const pool = poolWithUser([
    { match: /INSERT INTO push_tokens/, result: { rows: [{ id: 1, user_id: 7 }] } },
  ]);
  await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-1', body: { token: 'tok' },
  }));
  assert.match(sqlMatching(pool, /INSERT INTO push_tokens/), /SET user_id = EXCLUDED\.user_id/);
});

test('the token is filed against the caller, never against ?user_id', async () => {
  // The one deliberate asymmetry with every other route: a push token belongs
  // to the device in your hand, not to whoever you are currently viewing. A
  // caregiver looking at a dependent is still registering their own phone, and
  // honouring `user_id` here would send the dependent's escalations to the
  // person they were meant to escalate *to*.
  const pool = poolWithUser([
    { match: /INSERT INTO push_tokens/, result: { rows: [{ id: 1, user_id: 7 }] } },
  ]);
  await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-1',
    query: { user_id: '99' }, body: { token: 'tok' },
  }));

  const insert = pool.calls.find((c) => /INSERT INTO push_tokens/.test(c.text));
  assert.equal(insert.params[0], 7, 'the caller, not the query parameter');
  assert.equal(pool.calls.some((c) => /user_relationships/.test(c.text)), false, 'no checkAccess: there is nothing to check');
});

test('an unknown platform is stored as null rather than rejected', async () => {
  // A token with no platform is still a usable address. Rejecting it would
  // trade a working push channel for a tidy column.
  const pool = poolWithUser([
    { match: /INSERT INTO push_tokens/, result: { rows: [{ id: 1 }] } },
  ]);
  await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-1',
    body: { token: 'tok', platform: 'symbian' },
  }));
  const insert = pool.calls.find((c) => /INSERT INTO push_tokens/.test(c.text));
  assert.equal(insert.params[2], null);
});

test('POST /push-tokens without a token is a 400, before any write', async () => {
  const pool = poolWithUser();
  const res = await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-1', body: { platform: 'ios' },
  }));
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /token/);
  assert.equal(pool.calls.some((c) => /INSERT INTO push_tokens/.test(c.text)), false);
});

test('a whitespace-only token is not a token', async () => {
  const pool = poolWithUser();
  const res = await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-1', body: { token: '   ' },
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(pool.calls.some((c) => /INSERT INTO push_tokens/.test(c.text)), false);
});

test('an authenticated caller with no profile row gets 404, not 401', async () => {
  // Same shape as /me (§0.6): the caller *is* authenticated, the profile just
  // does not exist yet, and a 401 would invite the client to sign them out.
  // It also stops a NULL-owner row being inserted — the failure mode the
  // `medication_reminders.user_id` finding describes.
  const pool = makePool([
    { match: /SELECT id FROM users WHERE cognito_id/, result: { rows: [] } },
  ]);
  _setPoolForTests(pool);

  const res = await handler(restEvent({
    method: 'POST', path: '/push-tokens', sub: 'sub-unknown', body: { token: 'tok' },
  }));
  assert.equal(res.statusCode, 404);
  assert.equal(pool.calls.some((c) => /INSERT INTO push_tokens/.test(c.text)), false);
});

test('/push-tokens without auth is 401, like every other authed route', async () => {
  const res = await handler(restEvent({ method: 'POST', path: '/push-tokens', body: { token: 'tok' } }));
  assert.equal(res.statusCode, 401);
});

test('DELETE /push-tokens is scoped by owner as well as by token', async () => {
  // Otherwise one account could unregister another's device by guessing a
  // token, silently removing their only escalation channel.
  const pool = poolWithUser([
    { match: /DELETE FROM push_tokens/, result: { rows: [], rowCount: 1 } },
  ]);
  const res = await handler(restEvent({
    method: 'DELETE', path: '/push-tokens', sub: 'sub-1', body: { token: 'tok' },
  }));
  assert.equal(res.statusCode, 200);

  const del = pool.calls.find((c) => /DELETE FROM push_tokens/.test(c.text));
  assert.match(del.text, /token = \$1 AND user_id = \$2/);
  assert.deepEqual(del.params, ['tok', 7]);
});

test('deleting a token that is already gone is a 200, not a 404', async () => {
  // The caller wanted it absent and it is absent. A 404 here would make
  // sign-out and 5.8's dead-token reap both look like failures.
  poolWithUser([{ match: /DELETE FROM push_tokens/, result: { rows: [], rowCount: 0 } }]);
  const res = await handler(restEvent({
    method: 'DELETE', path: '/push-tokens', sub: 'sub-1', body: { token: 'gone' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).removed, 0);
});

test('GET /push-tokens is 405 — tokens are written, never listed back', async () => {
  poolWithUser();
  const res = await handler(restEvent({ method: 'GET', path: '/push-tokens', sub: 'sub-1' }));
  assert.equal(res.statusCode, 405);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('database failure surfaces as 500', async () => {
  _setPoolForTests(makePool([
    { match: /FROM genders/, throws: new Error('connection refused') },
  ]));
  const res = await handler(restEvent({ path: '/genders' }));
  assert.equal(res.statusCode, 500);
});
