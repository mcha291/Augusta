// Functional tests for the admin API Lambda: the real handler is invoked with
// proxy-shaped events in both payload formats — v1 (REST API, what is actually
// deployed, since ap-east-2 has no HTTP APIs) and v2 (HTTP API). Postgres is
// substituted via the _setPoolForTests seam and the GitHub contents API via a
// recording fetch stub. Run: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler, _setPoolForTests, ALLOWED_TABLES, groupsFrom, requiredEnvFor } from './index.mjs';

const ENV = {
  DB_HOST: 'db.local', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'postgres',
  GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'mcha291/Augusta',
  ALLOWED_ORIGIN: 'https://admin.example.com',
};

function makePool(routes = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      for (const r of routes) {
        if (r.match.test(text)) return typeof r.result === 'function' ? r.result(text, params) : r.result;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// `groups` defaults to the approved group so the existing route tests exercise
// the routes rather than the gate; the gate has its own tests below. Pass
// groups: null to simulate a signed-in but unapproved staff member.
function httpEvent({ method = 'GET', path = '/', query, body, groups = ['approved'] } = {}) {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      // HTTP API authorizers pass claims as real arrays.
      authorizer: groups === null ? undefined : { jwt: { claims: { 'cognito:groups': groups } } },
    },
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : undefined,
  };
}

// REST API (payload format 1.0) — the shape the deployed gateway actually
// sends. `path` is stage-stripped by API Gateway, so /prod/tables arrives here
// as /tables; requestContext.path keeps the stage and is deliberately not read.
function restEvent({ method = 'GET', path = '/', query, body, groups = ['approved'] } = {}) {
  return {
    path,
    httpMethod: method,
    resource: path,
    requestContext: {
      path: `/prod${path}`,
      httpMethod: method,
      // REST authorizers flatten claims to strings: "[approved, other]".
      authorizer: groups === null ? undefined : { claims: { 'cognito:groups': `[${groups.join(', ')}]` } },
    },
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : undefined,
  };
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8').toString('base64');
const parse = (res) => JSON.parse(res.body);

// Recording fetch stub for the GitHub contents API
function stubFetch(files, { putStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if ((init.method ?? 'GET') === 'GET') {
      for (const [pathPart, content] of Object.entries(files)) {
        if (String(url).includes(pathPart)) {
          return { ok: true, json: async () => ({ content: b64(content), sha: `sha-${pathPart}` }) };
        }
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    // PUT
    if (putStatus !== 200) return { ok: false, status: putStatus, text: async () => 'conflict' };
    return { ok: true, status: 200, json: async () => ({ commit: { html_url: 'https://github.com/x/commit/1' }, content: { sha: 'sha-new' } }) };
  };
  return calls;
}

const DB_ENV_KEYS = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const GITHUB_ENV_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO'];

// Locale fixtures, used by the env-split tests below as well as the
// translations section further down.
const EN = { common: { hello: 'Hello {{name}}' } };
const ZH = { common: { hello: '你好 {{name}}' } };

const realFetch = globalThis.fetch;
let pool;

beforeEach(() => {
  Object.assign(process.env, ENV);
  pool = makePool();
  _setPoolForTests(pool);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

// ---------------------------------------------------------------------------
// Config / routing basics
// ---------------------------------------------------------------------------

test('fails closed with 500 when env vars are missing', async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  const res = await handler(httpEvent({ path: '/tables' }));
  assert.equal(res.statusCode, 500);
  assert.match(parse(res).error, /missing env/);
});

// ---------------------------------------------------------------------------
// Per-route env requirements
// ---------------------------------------------------------------------------
// One zip is deployed as two functions: the VPC-attached one holds DB
// credentials and no GitHub token, the non-VPC one the reverse. Requiring the
// union would make each fail closed over secrets it was deliberately not given.

test('table routes need DB credentials but not a GitHub token', async () => {
  for (const k of GITHUB_ENV_KEYS) delete process.env[k];
  _setPoolForTests(makePool([{ match: /COUNT/, result: { rows: [{ count: 2 }] } }]));
  const res = await handler(restEvent({ path: '/tables' }));
  assert.equal(res.statusCode, 200, 'no GitHub token must not break the table viewer');
});

test('translations routes need a GitHub token but not DB credentials', async () => {
  for (const k of DB_ENV_KEYS) delete process.env[k];
  stubFetch({ 'en.json': EN, 'zh-Hant.json': ZH });
  const res = await handler(restEvent({ path: '/translations' }));
  assert.equal(res.statusCode, 200, 'no DB credentials must not break the editor');
});

test('a table route still fails closed without DB credentials', async () => {
  for (const k of DB_ENV_KEYS) delete process.env[k];
  const res = await handler(restEvent({ path: '/tables' }));
  assert.equal(res.statusCode, 500);
  assert.match(parse(res).error, /DB_HOST/);
});

test('a translations route still fails closed without a GitHub token', async () => {
  for (const k of GITHUB_ENV_KEYS) delete process.env[k];
  const res = await handler(restEvent({ path: '/translations' }));
  assert.equal(res.statusCode, 500);
  assert.match(parse(res).error, /GITHUB_TOKEN/);
});

test('requiredEnvFor never demands a credential the route cannot use', () => {
  assert.deepEqual(requiredEnvFor('listTables').filter((k) => k.startsWith('GITHUB')), []);
  assert.deepEqual(requiredEnvFor('getTranslations').filter((k) => k.startsWith('DB_')), []);
  // ALLOWED_ORIGIN is the one both need — it shapes the CORS headers.
  for (const r of ['listTables', 'getTable', 'getTranslations', 'putTranslations']) {
    assert.ok(requiredEnvFor(r).includes('ALLOWED_ORIGIN'), `${r} must require ALLOWED_ORIGIN`);
  }
});

// Config state must not be probeable by someone who has not been approved.
test('an unapproved caller gets 403, not a 500 revealing what is unconfigured', async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  const res = await handler(restEvent({ path: '/tables', groups: [] }));
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).code, 'NOT_APPROVED');
});

// Preflight predates both checks: no Authorization header, nothing to configure.
test('preflight works even with no env and no claims at all', async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  const res = await handler(restEvent({ method: 'OPTIONS', path: '/tables', groups: null }));
  assert.equal(res.statusCode, 204);
});

test('OPTIONS preflight returns 204 with the configured origin', async () => {
  const res = await handler(httpEvent({ method: 'OPTIONS', path: '/translations' }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://admin.example.com');
});

test('unknown route returns 404', async () => {
  const res = await handler(httpEvent({ method: 'DELETE', path: '/translations' }));
  assert.equal(res.statusCode, 404);
});

// The deployed gateway is a REST API, so payload format 1.0 is the shape that
// actually runs in production — v2 is the portable-but-unused path. If these
// break, every route 404s behind the real gateway while the v2 tests stay green.
test('REST payload (v1) routes identically to HTTP payload (v2)', async () => {
  _setPoolForTests(makePool([{ match: /COUNT/, result: { rows: [{ count: 7 }] } }]));
  const res = await handler(restEvent({ path: '/tables' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res).tables[0], { name: 'users', rowCount: 7 });
});

test('REST payload (v1) carries method through for non-GET verbs', async () => {
  const res = await handler(restEvent({ method: 'OPTIONS', path: '/translations' }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://admin.example.com');
});

test('REST payload (v1) resolves path parameters from the path, not pathParameters', async () => {
  const res = await handler(restEvent({ path: '/tables/pg_shadow' }));
  assert.equal(res.statusCode, 404);
  assert.match(parse(res).error, /Unknown table/);
});

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------
// Self-signup is open on the admin pool, so a valid token no longer implies
// authorization — only membership of the `approved` group does.

test('a signed-in but unapproved account gets 403, and no query runs', async () => {
  const pool = makePool([{ match: /COUNT/, result: { rows: [{ count: 3 }] } }]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({ path: '/tables', groups: [] }));
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).code, 'NOT_APPROVED');
  assert.equal(pool.calls.length, 0, 'must not touch the database for an unapproved caller');
});

test('membership of some other group is not approval', async () => {
  const res = await handler(restEvent({ path: '/tables', groups: ['staff', 'readonly'] }));
  assert.equal(res.statusCode, 403);
});

test('the REST authorizer bracket-string form is parsed, not matched as a substring', () => {
  assert.deepEqual(groupsFrom({ 'cognito:groups': '[approved, ops]' }), ['approved', 'ops']);
  assert.deepEqual(groupsFrom({ 'cognito:groups': 'approved' }), ['approved']);
  assert.deepEqual(groupsFrom({ 'cognito:groups': ['approved'] }), ['approved']);
  assert.deepEqual(groupsFrom({}), []);
  // "not-approved" must not satisfy a check for "approved"
  assert.equal(groupsFrom({ 'cognito:groups': '[not-approved]' }).includes('approved'), false);
});

// A direct invoke, or a route accidentally left with authorization NONE, has no
// claims at all. That must fail closed rather than be read as "no groups yet".
test('missing authorizer claims are rejected, not treated as unapproved-but-harmless', async () => {
  const res = await handler(restEvent({ path: '/tables', groups: null }));
  assert.equal(res.statusCode, 403);
});

test('preflight is exempt — browsers send OPTIONS with no Authorization header', async () => {
  const res = await handler(restEvent({ method: 'OPTIONS', path: '/tables', groups: null }));
  assert.equal(res.statusCode, 204);
});

test('the gate also covers writes, not just reads', async () => {
  const res = await handler(
    restEvent({ method: 'PUT', path: '/translations', groups: [], body: { locale: 'en' } })
  );
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Table viewer
// ---------------------------------------------------------------------------

test('GET /tables returns a count per allowlisted table', async () => {
  _setPoolForTests(makePool([{ match: /COUNT/, result: { rows: [{ count: 3 }] } }]));
  const res = await handler(httpEvent({ path: '/tables' }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).tables.length, ALLOWED_TABLES.length);
  assert.deepEqual(parse(res).tables[0], { name: 'users', rowCount: 3 });
});

test('GET /tables/{name} rejects non-allowlisted tables without touching SQL', async () => {
  const res = await handler(httpEvent({ path: '/tables/pg_shadow' }));
  assert.equal(res.statusCode, 404);
  assert.equal(pool.calls.length, 0);
});

test('GET /tables/{name} clamps limit, validates sort column, parameterizes paging', async () => {
  let dataQuery;
  _setPoolForTests(makePool([
    { match: /information_schema/, result: { rows: [{ column_name: 'id' }, { column_name: 'email' }] } },
    { match: /SELECT \* FROM users/, result: (text, params) => { dataQuery = { text, params }; return { rows: [{ id: 1 }] }; } },
    { match: /COUNT/, result: { rows: [{ count: 1 }] } },
  ]));
  const res = await handler(httpEvent({
    path: '/tables/users',
    query: { limit: '99999', offset: '10', sort: 'email', dir: 'desc' },
  }));
  assert.equal(res.statusCode, 200);
  assert.match(dataQuery.text, /ORDER BY "email" DESC/);
  assert.deepEqual(dataQuery.params, [200, 10]); // limit clamped to 200
});

test('GET /tables/{name} falls back to the first column for unknown sort', async () => {
  let dataQuery;
  _setPoolForTests(makePool([
    { match: /information_schema/, result: { rows: [{ column_name: 'id' }] } },
    { match: /SELECT \* FROM genders/, result: (text) => { dataQuery = text; return { rows: [] }; } },
    { match: /COUNT/, result: { rows: [{ count: 0 }] } },
  ]));
  await handler(httpEvent({ path: '/tables/genders', query: { sort: 'evil"; DROP TABLE users;--' } }));
  assert.match(dataQuery, /ORDER BY "id" ASC/);
});

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

test('GET /translations returns both locales with shas', async () => {
  stubFetch({ 'en.json': EN, 'zh-Hant.json': ZH });
  const res = await handler(httpEvent({ path: '/translations' }));
  assert.equal(res.statusCode, 200);
  const body = parse(res);
  assert.deepEqual(body.en.content, EN);
  assert.equal(body['zh-Hant'].sha, 'sha-zh-Hant.json');
});

test('GET /translations targets the tish-app/locales path in the monorepo', async () => {
  const calls = stubFetch({ 'en.json': EN, 'zh-Hant.json': ZH });
  await handler(httpEvent({ path: '/translations' }));
  assert.ok(calls.every((c) => c.url.includes('/contents/tish-app/locales/')), calls.map((c) => c.url).join());
});

test('PUT /translations rejects malformed requests with 400', async () => {
  for (const body of [undefined, { locale: 'fr', content: {}, sha: 'x' }, { locale: 'en', sha: 'x' }, { locale: 'en', content: {} }]) {
    const res = await handler(httpEvent({ method: 'PUT', path: '/translations', body }));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

test('PUT /translations blocks a broken placeholder with 422 and never commits', async () => {
  const calls = stubFetch({ 'en.json': EN, 'zh-Hant.json': ZH });
  const res = await handler(httpEvent({
    method: 'PUT', path: '/translations',
    body: { locale: 'zh-Hant', content: { common: { hello: '你好 {{nmae}}' } }, sha: 'sha-zh-Hant.json', message: 'typo' },
  }));
  assert.equal(res.statusCode, 422);
  assert.ok(parse(res).problems.length >= 1);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('PUT /translations happy path commits with prefixed message and returns commit url', async () => {
  const calls = stubFetch({ 'en.json': EN, 'zh-Hant.json': ZH });
  const res = await handler(httpEvent({
    method: 'PUT', path: '/translations',
    body: { locale: 'en', content: { common: { hello: 'Hi {{name}}' } }, sha: 'sha-en.json', message: 'reword greeting' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).commitUrl, 'https://github.com/x/commit/1');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.message, 'translations: reword greeting');
  assert.equal(put.body.branch, 'main');
  const committed = JSON.parse(Buffer.from(put.body.content, 'base64').toString('utf8'));
  assert.equal(committed.common.hello, 'Hi {{name}}');
});

test('PUT /translations maps a stale sha to 409', async () => {
  stubFetch({ 'en.json': EN, 'zh-Hant.json': ZH }, { putStatus: 409 });
  const res = await handler(httpEvent({
    method: 'PUT', path: '/translations',
    body: { locale: 'en', content: { common: { hello: 'Hi {{name}}' } }, sha: 'stale', message: 'x' },
  }));
  assert.equal(res.statusCode, 409);
});

test('internal errors return sanitized 500 (no stack/details in the response)', async () => {
  globalThis.fetch = async () => { throw new Error('secret internal detail'); };
  const res = await handler(httpEvent({ path: '/translations' }));
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).error, 'Internal error');
});
