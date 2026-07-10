// Functional tests for the app backend Lambda: the real handler is invoked
// with API-Gateway-REST-shaped events; only the Postgres pool is substituted
// (scripted per test via the _setPoolForTests seam). Run: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler, _setPoolForTests } from './index.mjs';

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
  assert.equal(res.statusCode, '401');
});

test('unknown path with auth returns 404', async () => {
  const res = await handler(restEvent({ path: '/nope', sub: 'sub-1' }));
  assert.equal(res.statusCode, '404');
  assert.match(parse(res).error, /Not found/);
});

test('every JSON response carries CORS headers', async () => {
  const res = await handler(restEvent({ path: '/nope' }));
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(res.headers['Content-Type'], 'application/json');
});

// ---------------------------------------------------------------------------
// Public lookups
// ---------------------------------------------------------------------------

test('GET /genders is public and returns rows', async () => {
  _setPoolForTests(makePool([
    { match: /FROM genders/, result: { rows: [{ id: 1, name: 'Female' }] } },
  ]));
  const res = await handler(restEvent({ path: '/genders' }));
  assert.equal(res.statusCode, '200');
  assert.deepEqual(parse(res), [{ id: 1, name: 'Female' }]);
});

test('GET /check-availability without params returns 400', async () => {
  const res = await handler(restEvent({ path: '/check-availability' }));
  assert.equal(res.statusCode, '400');
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
  assert.equal(res.statusCode, '400');
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
  assert.equal(res.statusCode, '401');
});

test('accessing another user without an active relationship returns 403', async () => {
  _setPoolForTests(makePool([
    { match: /FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
    { match: /FROM user_relationships WHERE caregiver_id/, result: { rows: [] } }, // no grant
  ]));
  const res = await handler(restEvent({ path: '/appointments', sub: 'sub-1', query: { user_id: '99' } }));
  assert.equal(res.statusCode, '403');
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
// Medication reminders — regression coverage for the alarm-labels feature
// ---------------------------------------------------------------------------

const selfPool = (extra = []) => makePool([
  { match: /FROM users WHERE cognito_id/, result: { rows: [{ id: 1 }] } },
  ...extra,
]);

test('POST /medication-reminders inserts alarms and alarm_labels', async () => {
  let inserted;
  _setPoolForTests(selfPool([
    { match: /INSERT INTO medication_reminders/, result: (t, params) => {
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
      alarms: ['08:00'], alarm_labels: ['Morning dose'], reminder_sound: 'calm',
    },
  }));
  assert.equal(res.statusCode, '200');
  assert.equal(inserted.length, 14);
  assert.deepEqual(inserted[11], ['08:00']);          // alarms
  assert.deepEqual(inserted[12], ['Morning dose']);   // alarm_labels
  assert.equal(inserted[13], 'calm');                 // reminder_sound
});

test('PUT /medication-reminders sends full COALESCE update (15 params, id+user last)', async () => {
  let updated;
  _setPoolForTests(selfPool([
    { match: /UPDATE medication_reminders SET/, result: (t, params) => {
        updated = params;
        return { rows: [{ id: 5 }] };
      } },
  ]));
  await handler(restEvent({
    method: 'PUT', path: '/medication-reminders', sub: 'sub-1',
    body: { id: 5, status: 'inactive' },
  }));
  assert.equal(updated.length, 15);
  assert.equal(updated[0], 'inactive');
  assert.equal(updated[13], 5);  // id
  assert.equal(updated[14], 1);  // user scoping
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('database failure surfaces as 500', async () => {
  _setPoolForTests(makePool([
    { match: /FROM genders/, throws: new Error('connection refused') },
  ]));
  const res = await handler(restEvent({ path: '/genders' }));
  assert.equal(res.statusCode, '500');
});
