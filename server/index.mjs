// Tish admin API — single-file Lambda handler (API Gateway HTTP API, payload v2).
//
// Routes (all behind the gateway's Cognito JWT authorizer — admin pool
// membership IS the authorization; this code never sees unauthenticated
// traffic in production):
//   GET /tables                  -> allowlisted table names + row counts
//   GET /tables/{name}           -> rows (limit/offset/sort/dir), read-only
//   GET /translations            -> both locale files from GitHub (content + sha)
//   PUT /translations            -> validate + commit one locale file to main
//
// Required env vars (no fallbacks by design — fail loudly, never ship
// credentials in source): DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
// GITHUB_TOKEN, GITHUB_REPO (e.g. "mcha291/Augusta"), ALLOWED_ORIGIN.

import pg from 'pg';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'GITHUB_TOKEN', 'GITHUB_REPO', 'ALLOWED_ORIGIN'];

// Read-only viewer allowlist. Mirrors the table set the app backend exposes
// via its /debug endpoint. Never derived from user input.
export const ALLOWED_TABLES = [
  'users',
  'appointments',
  'medication_reminders',
  'medication_library',
  'test_results',
  'test_config',
  'user_relationships',
  'genders',
  'conditions',
  'appointment_statuses',
];

// Path of the locales directory *within the GitHub repo*. The app repo is a
// monorepo with the Expo app under tish-app/, so the default reflects that.
const LOCALES_DIR = (process.env.GITHUB_LOCALES_DIR || 'tish-app/locales').replace(/\/+$/, '');

const LOCALE_FILES = {
  en: `${LOCALES_DIR}/en.json`,
  'zh-Hant': `${LOCALES_DIR}/zh-Hant.json`,
};

const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

let pool; // lazily created so pure helpers can be imported without env/DB

// Test seam: lets index.test.mjs substitute a scripted pool so the handler
// can be exercised functionally without a database connection.
export function _setPoolForTests(fakePool) { pool = fakePool; }

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: 5432,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for local smoke testing)
// ---------------------------------------------------------------------------

export function isAllowedTable(name) {
  return ALLOWED_TABLES.includes(name);
}

export function flattenKeys(obj, prefix = '') {
  const out = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenKeys(value, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

export function stemOf(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  return key;
}

export function placeholdersIn(text) {
  if (typeof text !== 'string') return new Set();
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  return new Set(Array.from(matches, (m) => m[1]));
}

// Same rules as scripts/validate-translations.mjs in the app repo (and the CI
// workflow): key-stem parity in both directions, then placeholder parity per
// stem. Returns a list of human-readable problems; empty list = valid.
export function validateLocalePair(enObj, zhObj) {
  const problems = [];

  const group = (flat) => {
    const stems = new Map();
    for (const [key, value] of Object.entries(flat)) {
      const stem = stemOf(key);
      if (!stems.has(stem)) stems.set(stem, []);
      stems.get(stem).push(value);
    }
    return stems;
  };

  const enStems = group(flattenKeys(enObj));
  const zhStems = group(flattenKeys(zhObj));

  for (const stem of enStems.keys()) {
    if (!zhStems.has(stem)) problems.push(`Missing in zh-Hant: "${stem}"`);
  }
  for (const stem of zhStems.keys()) {
    if (!enStems.has(stem)) problems.push(`Missing in en: "${stem}"`);
  }

  for (const stem of enStems.keys()) {
    if (!zhStems.has(stem)) continue;
    const enPh = new Set();
    for (const v of enStems.get(stem)) for (const p of placeholdersIn(v)) enPh.add(p);
    const zhPh = new Set();
    for (const v of zhStems.get(stem)) for (const p of placeholdersIn(v)) zhPh.add(p);

    for (const p of enPh) if (!zhPh.has(p)) problems.push(`"${stem}": {{${p}}} missing from zh-Hant`);
    for (const p of zhPh) if (!enPh.has(p)) problems.push(`"${stem}": {{${p}}} missing from en`);
  }

  return problems;
}

// Route matching on the HTTP API's rawPath (deploy with the $default stage so
// no stage prefix appears — documented in AWS-SETUP.md).
export function routeOf(method, path) {
  const clean = path.replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return { name: 'preflight' };
  if (method === 'GET' && clean === '/tables') return { name: 'listTables' };
  const tableMatch = clean.match(/^\/tables\/([a-z_]+)$/);
  if (method === 'GET' && tableMatch) return { name: 'getTable', table: tableMatch[1] };
  if (method === 'GET' && clean === '/translations') return { name: 'getTranslations' };
  if (method === 'PUT' && clean === '/translations') return { name: 'putTranslations' };
  return { name: 'notFound' };
}

// ---------------------------------------------------------------------------
// GitHub contents API (plain fetch; token never leaves this Lambda)
// ---------------------------------------------------------------------------

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tish-admin-lambda',
  };
}

async function githubGetFile(path) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { content, sha: data.sha };
}

async function githubPutFile(path, contentObj, sha, message) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    branch: GITHUB_BRANCH,
    sha,
    content: Buffer.from(JSON.stringify(contentObj, null, 2) + '\n', 'utf8').toString('base64'),
  };
  const res = await fetch(url, { method: 'PUT', headers: githubHeaders(), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) {
    // sha mismatch — someone else committed since the client loaded the file
    const detail = await res.text();
    return { conflict: true, detail };
  }
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { conflict: false, commitUrl: data.commit?.html_url, newSha: data.content?.sha };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return json(500, { error: `Lambda misconfigured; missing env: ${missing.join(', ')}` });
  }

  const method = event.requestContext?.http?.method ?? '';
  const path = event.rawPath ?? '/';
  const route = routeOf(method, path);

  try {
    switch (route.name) {
      case 'preflight':
        return json(204, {});

      case 'listTables': {
        const db = getPool();
        const tables = [];
        for (const name of ALLOWED_TABLES) {
          const res = await db.query(`SELECT COUNT(*)::int AS count FROM ${name}`); // name from static allowlist only
          tables.push({ name, rowCount: res.rows[0].count });
        }
        return json(200, { tables });
      }

      case 'getTable': {
        if (!isAllowedTable(route.table)) return json(404, { error: `Unknown table: ${route.table}` });
        const db = getPool();

        const q = event.queryStringParameters ?? {};
        const limit = Math.min(Math.max(parseInt(q.limit) || 50, 1), 200);
        const offset = Math.max(parseInt(q.offset) || 0, 0);
        const dir = q.dir === 'desc' ? 'DESC' : 'ASC';

        const colRes = await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [route.table]
        );
        const columns = colRes.rows.map((r) => r.column_name);
        // sort column must be a real column of this table — identifier is
        // interpolated only after that check, everything else is parameterized
        const sort = columns.includes(q.sort) ? q.sort : columns[0];

        const rowsRes = await db.query(
          `SELECT * FROM ${route.table} ORDER BY "${sort}" ${dir} LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        const countRes = await db.query(`SELECT COUNT(*)::int AS count FROM ${route.table}`);

        return json(200, { columns, rows: rowsRes.rows, total: countRes.rows[0].count, limit, offset, sort, dir });
      }

      case 'getTranslations': {
        const [en, zhHant] = await Promise.all([
          githubGetFile(LOCALE_FILES.en),
          githubGetFile(LOCALE_FILES['zh-Hant']),
        ]);
        return json(200, { en, 'zh-Hant': zhHant, repo: process.env.GITHUB_REPO, branch: GITHUB_BRANCH });
      }

      case 'putTranslations': {
        let body;
        try {
          body = JSON.parse(event.body ?? '');
        } catch {
          return json(400, { error: 'Request body must be JSON' });
        }
        const { locale, content, sha, message } = body ?? {};
        if (!LOCALE_FILES[locale]) return json(400, { error: `locale must be one of: ${Object.keys(LOCALE_FILES).join(', ')}` });
        if (!content || typeof content !== 'object') return json(400, { error: 'content must be the full locale JSON object' });
        if (!sha) return json(400, { error: 'sha of the file version being edited is required' });

        // Re-validate server-side against the *other* locale, fetched fresh —
        // client-side validation is UX, this is the actual gate.
        const otherLocale = locale === 'en' ? 'zh-Hant' : 'en';
        const other = await githubGetFile(LOCALE_FILES[otherLocale]);
        const [enObj, zhObj] = locale === 'en' ? [content, other.content] : [other.content, content];
        const problems = validateLocalePair(enObj, zhObj);
        if (problems.length > 0) return json(422, { error: 'Validation failed', problems });

        const note = (message || 'edit via dashboard').slice(0, 200);
        const result = await githubPutFile(LOCALE_FILES[locale], content, sha, `translations: ${note}`);
        if (result.conflict) {
          return json(409, { error: 'File changed since you loaded it — reload and reapply your edits.' });
        }
        return json(200, { commitUrl: result.commitUrl, sha: result.newSha });
      }

      default:
        return json(404, { error: `No route for ${method} ${path}` });
    }
  } catch (e) {
    console.error('admin-api error:', e);
    return json(500, { error: 'Internal error' }); // details stay in CloudWatch, not the response
  }
}
