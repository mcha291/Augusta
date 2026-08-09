// Functional tests for the admin API Lambda: the real handler is invoked with
// proxy-shaped events in both payload formats — v1 (REST API, what is actually
// deployed, since ap-east-2 has no HTTP APIs) and v2 (HTTP API). Postgres is
// substituted via the _setPoolForTests seam and the GitHub contents API via a
// recording fetch stub. Run: npm test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handler, _setPoolForTests, ALLOWED_TABLES, groupsFrom, requiredEnvFor, validateAnnouncement, validateAnnouncementType } from './index.mjs';

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

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const draft = (over = {}) => ({
  type_id: 2,
  title_en: 'Clinic closed Monday',
  content_en: 'The clinic is closed all day.',
  title_zh_hant: '週一休診',
  content_zh_hant: '診所全日休診。',
  ...over,
});

test('validateAnnouncement requires a type_id, since 010 made the vocabulary a table', () => {
  assert.deepEqual(validateAnnouncement(draft()), []);
  assert.match(validateAnnouncement(draft({ type_id: undefined }))[0], /type_id is required/);
  // A label is not a type any more — only the foreign key is.
  assert.match(validateAnnouncement(draft({ type_id: 'news' }))[0], /type_id is required/);
});

test('A DRAFT MAY BE HALF-WRITTEN, because that is what a draft is', () => {
  const problems = validateAnnouncement(draft({ title_zh_hant: '', content_zh_hant: '' }));
  assert.deepEqual(problems, []);
});

test('PUBLISHING NEEDS ONE COMPLETE LANGUAGE, or the card renders blank', () => {
  const halfWritten = draft({ content_en: '', title_zh_hant: '', content_zh_hant: '' });
  const problems = validateAnnouncement(halfWritten, { publishing: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least one language/);
  // The same article is a perfectly legal draft.
  assert.deepEqual(validateAnnouncement(halfWritten), []);
});

test('a body with no headline is rejected even as a draft', () => {
  // Unreachable rather than incomplete: the editor list renders titles, so this
  // article would hold text nobody could ever open.
  const problems = validateAnnouncement(draft({ title_zh_hant: '' }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zh-Hant: content without a title/);
});

test('GET /announcements returns drafts too, unresolved, newest first', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /FROM announcements/, result: (t) => { sql = t; return { rows: [{ id: 1, published_at: null }] }; } },
  ]));
  const res = await handler(restEvent({ path: '/announcements' }));
  assert.equal(res.statusCode, 200);
  assert.match(sql, /ORDER BY COALESCE\(a\.published_at, a\.created_at\) DESC/);
  assert.doesNotMatch(sql, /WHERE a\.published_at IS NOT NULL/);
});

test('the article list carries the types too, so the picker is never empty on first paint', async () => {
  _setPoolForTests(makePool([
    { match: /FROM announcements a/, result: { rows: [{ id: 1 }] } },
    { match: /FROM announcement_types ORDER BY/, result: { rows: [{ id: 1, label_en: 'News' }] } },
  ]));
  const res = await handler(restEvent({ path: '/announcements' }));
  assert.equal(parse(res).types[0].label_en, 'News');
});

test('POST /announcements creates a draft when published is absent', async () => {
  let params;
  _setPoolForTests(makePool([
    { match: /INSERT INTO announcements/, result: (t, p) => { params = p; return { rows: [{ id: 7 }], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({ method: 'POST', path: '/announcements', body: draft() }));
  assert.equal(res.statusCode, 201);
  assert.equal(params[5], false);
});

test('POST /announcements refuses to publish an article with no complete language', async () => {
  _setPoolForTests(makePool([]));
  const res = await handler(restEvent({
    method: 'POST', path: '/announcements',
    body: draft({ content_en: '', title_zh_hant: '', content_zh_hant: '', published: true }),
  }));
  assert.equal(res.statusCode, 422);
  assert.match(parse(res).problems[0], /at least one language/);
});

test('EDITING A LIVE ARTICLE KEEPS ITS PUBLICATION DATE', async () => {
  // Restamping would jump a typo fix above genuinely newer news on every
  // patient's home screen, because the app orders by published_at.
  let sql;
  _setPoolForTests(makePool([
    { match: /UPDATE announcements/, result: (t) => { sql = t; return { rows: [{ id: 3 }], rowCount: 1 }; } },
  ]));
  const res = await handler(restEvent({
    method: 'PUT', path: '/announcements/3', body: draft({ published: true }),
  }));
  assert.equal(res.statusCode, 200);
  assert.match(sql, /COALESCE\(published_at, now\(\)\)/);
});

test('unpublishing clears published_at rather than keeping a stale date', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /UPDATE announcements/, result: (t) => { sql = t; return { rows: [{ id: 3 }], rowCount: 1 }; } },
  ]));
  await handler(restEvent({ method: 'PUT', path: '/announcements/3', body: draft({ published: false }) }));
  assert.match(sql, /ELSE NULL END/);
});

test('PUT and DELETE on an unknown id are 404, not a silent success', async () => {
  for (const method of ['PUT', 'DELETE']) {
    _setPoolForTests(makePool([]));  // rowCount 0
    const res = await handler(restEvent({ method, path: '/announcements/999', body: draft() }));
    assert.equal(res.statusCode, 404, `${method} should 404`);
  }
});

test('a non-numeric article id does not reach a query', async () => {
  const pool = makePool([]);
  _setPoolForTests(pool);
  const res = await handler(restEvent({ method: 'DELETE', path: '/announcements/abc' }));
  assert.equal(res.statusCode, 404);
  assert.equal(pool.calls.length, 0);
});

// --- article types (migration 010) ------------------------------------------

test('validateAnnouncementType requires the English label but not the Chinese one', () => {
  // Only label_en is the key, and the read path falls back to it. Requiring
  // both would block staff from adding a category until a Chinese reader is
  // free, which is the opposite of why this table exists.
  assert.deepEqual(validateAnnouncementType({ label_en: 'Recalls' }), []);
  assert.match(validateAnnouncementType({ label_en: '  ' })[0], /label_en is required/);
  assert.deepEqual(validateAnnouncementType({ label_en: 'Recalls', label_zh_hant: null }), []);
});

test('a malformed colour or sort order is named rather than stored', () => {
  assert.match(validateAnnouncementType({ label_en: 'X', color: 'red' })[0], /6-digit hex/);
  assert.deepEqual(validateAnnouncementType({ label_en: 'X', color: '#6366F1' }), []);
  assert.match(validateAnnouncementType({ label_en: 'X', sort_order: 1.5 })[0], /whole number/);
});

test('GET /announcement-types reports how many articles use each one', async () => {
  let sql;
  _setPoolForTests(makePool([
    { match: /FROM announcement_types t/, result: (t) => { sql = t; return { rows: [{ id: 1, label_en: 'News', article_count: 3 }] }; } },
  ]));
  const res = await handler(restEvent({ path: '/announcement-types' }));
  assert.equal(res.statusCode, 200);
  assert.match(sql, /COUNT\(a\.id\)::int AS article_count/);
  assert.equal(parse(res).types[0].article_count, 3);
});

test('DELETING A TYPE STILL IN USE IS A 409, not a 500 and not a silent cascade', async () => {
  // The RESTRICT in migration 010 is the feature; this is the sentence that
  // makes it usable. A 500 here would read as "the dashboard is broken".
  _setPoolForTests(makePool([
    { match: /DELETE FROM announcement_types/, result: () => { const e = new Error('violates foreign key'); e.code = '23503'; throw e; } },
  ]));
  const res = await handler(restEvent({ method: 'DELETE', path: '/announcement-types/1' }));
  assert.equal(res.statusCode, 409);
  assert.equal(parse(res).code, 'TYPE_IN_USE');
  assert.match(parse(res).error, /still used/);
});

test('a duplicate label is a named 422, not the raw unique-index message', async () => {
  _setPoolForTests(makePool([
    { match: /INSERT INTO announcement_types/, result: () => { const e = new Error('duplicate key'); e.code = '23505'; throw e; } },
  ]));
  const res = await handler(restEvent({ method: 'POST', path: '/announcement-types', body: { label_en: 'News' } }));
  assert.equal(res.statusCode, 422);
  assert.match(parse(res).problems[0], /already exists/);
  assert.doesNotMatch(JSON.stringify(parse(res)), /duplicate key/);
});

test('an article pointing at a deleted type is a 422 the editor can recover from', async () => {
  // Reachable in one tab after another deletes the type.
  _setPoolForTests(makePool([
    { match: /INSERT INTO announcements/, result: () => { const e = new Error('fk'); e.code = '23503'; throw e; } },
  ]));
  const res = await handler(restEvent({ method: 'POST', path: '/announcements', body: draft() }));
  assert.equal(res.statusCode, 422);
  assert.match(parse(res).problems[0], /no longer exists/);
});

test('an empty Chinese label is stored as NULL, not as an empty string', async () => {
  // So the read path's "is it filled?" test and the database agree about what
  // "missing translation" means.
  let params;
  _setPoolForTests(makePool([
    { match: /INSERT INTO announcement_types/, result: (t, p) => { params = p; return { rows: [{ id: 5 }], rowCount: 1 }; } },
  ]));
  await handler(restEvent({ method: 'POST', path: '/announcement-types', body: { label_en: 'Recalls', label_zh_hant: '   ' } }));
  assert.equal(params[1], null);
});

test('type routes are gated on approval like everything else', async () => {
  for (const [method, path] of [['GET', '/announcement-types'], ['POST', '/announcement-types'], ['DELETE', '/announcement-types/1']]) {
    const pool = makePool([]);
    _setPoolForTests(pool);
    const res = await handler(restEvent({ method, path, body: { label_en: 'X' }, groups: [] }));
    assert.equal(res.statusCode, 403, `${method} ${path} should be gated`);
    assert.equal(pool.calls.length, 0);
  }
});

test('announcement routes need the database env, never the GitHub token', () => {
  for (const name of ['listAnnouncements', 'createAnnouncement', 'updateAnnouncement', 'deleteAnnouncement',
                      'listAnnouncementTypes', 'createAnnouncementType', 'updateAnnouncementType', 'deleteAnnouncementType']) {
    const env = requiredEnvFor(name);
    assert.ok(env.includes('DB_HOST'), `${name} needs DB_HOST`);
    assert.ok(!env.includes('GITHUB_TOKEN'), `${name} must not require GITHUB_TOKEN`);
  }
});

test('the unapproved gate covers writes, not just reads', async () => {
  for (const [method, path] of [['POST', '/announcements'], ['PUT', '/announcements/1'], ['DELETE', '/announcements/1']]) {
    const pool = makePool([]);
    _setPoolForTests(pool);
    const res = await handler(restEvent({ method, path, body: draft(), groups: [] }));
    assert.equal(res.statusCode, 403, `${method} ${path} should be gated`);
    assert.equal(pool.calls.length, 0);
  }
});

test('CORS advertises the write methods the editor actually uses', async () => {
  const res = await handler(restEvent({ method: 'OPTIONS', path: '/announcements' }));
  for (const m of ['POST', 'PUT', 'DELETE']) {
    assert.match(res.headers['Access-Control-Allow-Methods'], new RegExp(m));
  }
});
