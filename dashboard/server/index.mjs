// Tish admin API — single-file Lambda handler (API Gateway, Lambda proxy).
//
// Accepts both proxy payload shapes. ap-east-2 has no HTTP APIs, so the
// deployed gateway is a REST API sending payload format 1.0 (`httpMethod` /
// `path`); the v2 shape (`requestContext.http.method` / `rawPath`) is still
// read first so the handler stays portable if it ever moves to a region
// where HTTP APIs exist. See eventMethod/eventPath below.
//
// Routes (all behind the gateway's Cognito JWT authorizer — admin pool
// membership IS the authorization; this code never sees unauthenticated
// traffic in production):
//   GET /tables                  -> allowlisted table names + row counts
//   GET /tables/{name}           -> rows (limit/offset/sort/dir), read-only
//   GET /translations            -> both locale files from GitHub (content + sha)
//   PUT /translations            -> validate + commit one locale file to main
//
// This file is deployed as **two Lambda functions from one zip**, differing
// only in VPC attachment and which env vars they carry:
//
//   tish-admin-api           VPC-attached  -> /tables routes, reaches private RDS
//   tish-admin-translations  no VPC        -> /translations routes, reaches github.com
//
// The split is forced by networking, not by design taste. A VPC-attached
// Lambda in these subnets has *no route to the internet* — the subnets point
// 0.0.0.0/0 at an Internet Gateway, and Lambda ENIs get no public IP, so
// api.github.com is unreachable and the request hangs until the timeout. The
// alternatives were a NAT gateway or interface endpoints, both of which cost
// real money monthly to reintroduce connectivity that a function outside the
// VPC has for free. RDS is private, so the table routes must stay inside.
//
// API Gateway routes per resource, so which function serves a request is a
// gateway integration detail; this code is identical in both and simply never
// sees the routes it wasn't given.
//
// Required env vars are therefore **per route** (see requiredEnvFor). No
// fallbacks by design — fail loudly, never ship credentials in source. It also
// means the translations function never carries DB_PASSWORD, and the table
// function never carries GITHUB_TOKEN: neither can leak a credential it was
// never given.

import pg from 'pg';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_ENV = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const GITHUB_ENV = ['GITHUB_TOKEN', 'GITHUB_REPO'];

/**
 * Env vars a given route actually needs. Checking the union instead would mean
 * each function failing closed over credentials it has no use for — and would
 * have hidden the real fault here, since a function missing GITHUB_TOKEN and a
 * function that cannot route to GitHub both surface as a broken /translations.
 */
export function requiredEnvFor(routeName) {
  switch (routeName) {
    case 'listTables':
    case 'getTable':
    case 'listAnnouncements':
    case 'createAnnouncement':
    case 'updateAnnouncement':
    case 'deleteAnnouncement':
    case 'listAnnouncementTypes':
    case 'createAnnouncementType':
    case 'updateAnnouncementType':
    case 'deleteAnnouncementType':
    case 'listAdherencePatients':
    case 'getPatientAdherence':
    case 'getDailyOpens':
      return [...DB_ENV, 'ALLOWED_ORIGIN'];
    case 'getTranslations':
    case 'putTranslations':
      return [...GITHUB_ENV, 'ALLOWED_ORIGIN'];
    default:
      return ['ALLOWED_ORIGIN'];
  }
}

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
  'announcements',
];

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/** Mirrors the app's locale set; the column suffix each one writes to. */
export const ANNOUNCEMENT_LOCALES = { en: 'en', 'zh-Hant': 'zh_hant' };

const isFilled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate an article type (migration 010).
 *
 * **Only the English label is required.** It is the natural key, unique
 * case-insensitively in the database, and the read path falls back to it when a
 * translation is missing — so a type with no 中文 label still renders, in
 * English, which is the same bargain the articles themselves strike. Requiring
 * both would block staff from creating a category until someone who reads
 * Chinese is available.
 */
export function validateAnnouncementType(input) {
  const problems = [];
  if (!isFilled(input?.label_en)) problems.push('label_en is required — it is the type’s name and its key');
  if (input?.color != null && !/^#[0-9a-fA-F]{6}$/.test(String(input.color))) {
    problems.push('color must be a 6-digit hex value like #6366F1');
  }
  if (input?.sort_order != null && !Number.isInteger(input.sort_order)) {
    problems.push('sort_order must be a whole number');
  }
  return problems;
}

/**
 * Validate an article, returning the same `problems` array shape
 * `validateLocalePair` uses so the handler can 422 both the same way.
 *
 * **Publishing is the strict gate, saving a draft is not.** A draft is
 * work in progress and half a sentence in one language is a legitimate state to
 * leave it in; a *published* article is rendered on a patient's home screen,
 * where `localiseAnnouncement` resolves it as a unit. An article published with
 * a title in neither language renders a card with a blank headline, and one with
 * no body renders a headline that opens onto nothing.
 */
export function validateAnnouncement(input, { publishing } = {}) {
  const problems = [];

  // Migration 010 moved the vocabulary into a table, so this checks the shape
  // and the foreign key checks the value. A type that does not exist comes back
  // from Postgres as a constraint violation, which the handler turns into a 422
  // naming the field rather than leaking the constraint text.
  if (!Number.isInteger(input?.type_id)) {
    problems.push('type_id is required — pick one of the configured article types');
  }

  for (const [locale, suffix] of Object.entries(ANNOUNCEMENT_LOCALES)) {
    const title = input?.[`title_${suffix}`];
    const content = input?.[`content_${suffix}`];
    // A body with no headline is the one lopsided case that is always wrong:
    // the list renders titles, so the article would be invisible from the list
    // and unreachable even though it holds text.
    if (isFilled(content) && !isFilled(title)) {
      problems.push(`${locale}: content without a title — the list renders titles, so this article would be unreachable`);
    }
  }

  if (publishing) {
    const complete = Object.values(ANNOUNCEMENT_LOCALES)
      .some((s) => isFilled(input?.[`title_${s}`]) && isFilled(input?.[`content_${s}`]));
    if (!complete) {
      problems.push('publishing needs a title and body filled in for at least one language');
    }
  }

  return problems;
}

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

// Payload-shape adapters. HTTP API (v2) carries the method under
// requestContext.http and the path as rawPath; REST API (v1) uses httpMethod
// and path. On a REST API `path` is already stage-stripped — a request to
// /prod/tables arrives as "/tables" — so route matching is identical either way.
export function eventMethod(event) {
  return event?.requestContext?.http?.method ?? event?.httpMethod ?? '';
}

export function eventPath(event) {
  return event?.rawPath ?? event?.path ?? '/';
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------
//
// Self-signup is open on the admin pool, so "has a valid token" no longer means
// "may see patient data" — the gateway's Cognito authorizer accepts any
// confirmed member of the pool, which now includes anyone who just registered.
// Membership of the `approved` group is the actual authorization, and an
// administrator grants it by hand in the Cognito console.
//
// Checked here rather than in a Pre-Authentication trigger deliberately: this
// is the request that touches the data, and the claim is only as old as the ID
// token (one hour), whereas sign-in gating would leave a removed user working
// until their refresh token expired, up to 30 days later.

export const APPROVED_GROUP = 'approved';

// REST API authorizers flatten claims to strings, so cognito:groups arrives as
// "[approved, other]" — not an array, and not JSON. HTTP API authorizers pass a
// real array. Accept both, plus the single-value string form.
export function groupsFrom(claims) {
  const raw = claims?.['cognito:groups'];
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

export function isApproved(event) {
  const claims = event?.requestContext?.authorizer?.claims ?? event?.requestContext?.authorizer?.jwt?.claims;
  // No claims at all means the gateway authorizer did not run. That is either a
  // direct invoke or a misconfigured route, and neither should reach data.
  if (!claims) return false;
  return groupsFrom(claims).includes(APPROVED_GROUP);
}

// Route matching on the request path, which never includes a stage prefix
// (see eventPath) — documented in AWS-SETUP.md.
/**
 * The date range for an adherence query, defaulted and bounded.
 *
 * Exported so it is testable on its own: an unbounded or inverted range is the
 * difference between a query that reads a few hundred rows and one that scans a
 * table growing at ~3,000 rows per user per year, on a `db.t4g.micro` that is
 * also answering the question of whether an alarm should fire.
 *
 * Dates are passed through as strings rather than parsed and re-formatted —
 * Postgres casts them, and a client sending nonsense gets a 400 from the driver
 * rather than a silently-shifted window from a `new Date()` here.
 */
export function adherenceRange(q = {}) {
  const DAY = 24 * 60 * 60 * 1000;
  const MAX_DAYS = 366;

  const parsed = (v) => {
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
  };

  const now = Date.now();
  let toMs = parsed(q.to) ?? now;
  let fromMs = parsed(q.from) ?? toMs - 30 * DAY;

  // An inverted range returns zero rows and reads as "this patient has no
  // doses", which is the wrong answer to a malformed question.
  if (fromMs > toMs) [fromMs, toMs] = [toMs, fromMs];
  // Capped rather than rejected: a year of one patient's doses is a legitimate
  // thing to want, and ten years is a typo.
  if (toMs - fromMs > MAX_DAYS * DAY) fromMs = toMs - MAX_DAYS * DAY;

  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

export function routeOf(method, path) {
  const clean = path.replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return { name: 'preflight' };
  if (method === 'GET' && clean === '/tables') return { name: 'listTables' };
  const tableMatch = clean.match(/^\/tables\/([a-z_]+)$/);
  if (method === 'GET' && tableMatch) return { name: 'getTable', table: tableMatch[1] };
  if (method === 'GET' && clean === '/translations') return { name: 'getTranslations' };
  if (method === 'PUT' && clean === '/translations') return { name: 'putTranslations' };
  if (method === 'GET' && clean === '/announcements') return { name: 'listAnnouncements' };
  if (method === 'POST' && clean === '/announcements') return { name: 'createAnnouncement' };
  // \d+ rather than .+ so a non-numeric id is a 404 here instead of reaching a
  // query as NaN, which Postgres rejects with prose the client should not see.
  const articleMatch = clean.match(/^\/announcements\/(\d+)$/);
  if (method === 'PUT' && articleMatch) return { name: 'updateAnnouncement', id: Number(articleMatch[1]) };
  if (method === 'DELETE' && articleMatch) return { name: 'deleteAnnouncement', id: Number(articleMatch[1]) };
  // TELEMETRY.md §4 — the per-patient drill-down, the one view §4 says earns
  // its keep. `/adherence/patients` is matched before the numeric id below so
  // the literal segment cannot be read as a user id.
  if (method === 'GET' && clean === '/adherence/patients') return { name: 'listAdherencePatients' };
  const adherenceMatch = clean.match(/^\/adherence\/(\d+)$/);
  if (method === 'GET' && adherenceMatch) return { name: 'getPatientAdherence', userId: Number(adherenceMatch[1]) };
  if (method === 'GET' && clean === '/daily-opens') return { name: 'getDailyOpens' };
  if (method === 'GET' && clean === '/announcement-types') return { name: 'listAnnouncementTypes' };
  if (method === 'POST' && clean === '/announcement-types') return { name: 'createAnnouncementType' };
  const typeMatch = clean.match(/^\/announcement-types\/(\d+)$/);
  if (method === 'PUT' && typeMatch) return { name: 'updateAnnouncementType', id: Number(typeMatch[1]) };
  if (method === 'DELETE' && typeMatch) return { name: 'deleteAnnouncementType', id: Number(typeMatch[1]) };
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
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  const method = eventMethod(event);
  const path = eventPath(event);
  const route = routeOf(method, path);

  // Preflight is exempt from everything below: browsers send OPTIONS without an
  // Authorization header, so there are no claims to check, and it returns
  // nothing but CORS headers so there is no configuration to require.
  if (route.name === 'preflight') return json(204, {});

  if (!isApproved(event)) {
    // Distinct from the gateway's 401. 401 means "no valid token"; this means
    // "valid token, account not approved yet", which is what a newly signed-up
    // staff member sees and what the dashboard turns into a waiting message.
    //
    // Ordered before the config check deliberately: a caller who is not
    // approved should not be able to probe which env vars this function holds.
    return json(403, {
      error: 'Your account is awaiting administrator approval.',
      code: 'NOT_APPROVED',
    });
  }

  const missing = requiredEnvFor(route.name).filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return json(500, { error: `Lambda misconfigured; missing env: ${missing.join(', ')}` });
  }

  try {
    switch (route.name) {
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

      // --- TELEMETRY.md §4: the per-patient drill-down --------------------
      //
      // **Every one of these aggregates in Postgres and returns tens of rows.**
      // §4 calls this the decision that makes or breaks the view: a latency
      // histogram over 50,000 doses should cross the wire as 24 buckets, not as
      // 50,000 rows the browser reduces. The existing `GET /medication-doses`
      // on the app backend has `LIMIT 500` and cannot back a chart at all,
      // which is why these are new actions here rather than a reuse of it.

      case 'listAdherencePatients': {
        const db = getPool();
        // Only people who actually have materialised doses. A picker listing
        // every user, most with nothing to show, makes the useful ones harder
        // to find rather than easier.
        const res = await db.query(`
          SELECT u.id,
                 u.full_name,
                 u.username,
                 COUNT(d.id)::int                                        AS doses,
                 MAX(d.scheduled_for)                                    AS last_dose_at,
                 COUNT(*) FILTER (WHERE d.confirmed_at IS NOT NULL)::int AS confirmed
          FROM users u
          JOIN medication_doses d ON d.user_id = u.id
          GROUP BY u.id, u.full_name, u.username
          ORDER BY last_dose_at DESC NULLS LAST
          LIMIT 200`);
        return json(200, { patients: res.rows });
      }

      case 'getPatientAdherence': {
        const db = getPool();
        const q = event.queryStringParameters ?? {};
        const { from, to } = adherenceRange(q);

        // One round trip per shape rather than one query doing all four: they
        // group differently, and a single query with four FILTER'd CTEs is
        // harder to read than it is fast.
        const [summary, daily, latency, timeline] = await Promise.all([
          db.query(`
            SELECT COUNT(*)::int                                                          AS total,
                   COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int                  AS confirmed,
                   COUNT(*) FILTER (WHERE confirmed_at IS NULL
                                      AND scheduled_for < now())::int                     AS missed,
                   COUNT(*) FILTER (WHERE snooze_count > 0)::int                          AS snoozed,
                   -- D-1: a caregiver confirming is different behaviour and §2
                   -- says it must be segmented, not averaged in.
                   COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL
                                      AND confirmed_by IS DISTINCT FROM user_id)::int     AS by_caregiver
            FROM medication_doses
            WHERE user_id = $1 AND scheduled_for BETWEEN $2 AND $3`, [route.userId, from, to]),

          db.query(`
            -- Taipei days, resolved in SQL. §4: a dashboard opened from another
            -- timezone would otherwise silently shift every daily count.
            SELECT date_trunc('day', scheduled_for AT TIME ZONE 'Asia/Taipei')::date      AS day,
                   COUNT(*)::int                                                          AS scheduled,
                   COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int                  AS confirmed,
                   COUNT(*) FILTER (WHERE confirmed_at IS NULL
                                      AND scheduled_for < now())::int                     AS missed
            FROM medication_doses
            WHERE user_id = $1 AND scheduled_for BETWEEN $2 AND $3
            GROUP BY 1 ORDER BY 1`, [route.userId, from, to]),

          db.query(`
            -- §4's histogram, verbatim in shape: 24 five-minute buckets over
            -- two hours. COALESCE prefers the device's reported press time over
            -- when the POST landed — which for a confirm replayed from 4.4's
            -- offline queue differ by hours (§2).
            SELECT width_bucket(
                     EXTRACT(epoch FROM COALESCE(confirmed_reported_at, confirmed_at) - scheduled_for) / 60,
                     0, 120, 24)::int AS bucket,
                   COUNT(*)::int      AS n
            FROM medication_doses
            WHERE user_id = $1
              AND confirmed_at IS NOT NULL
              AND scheduled_for BETWEEN $2 AND $3
              -- §2: latency can legitimately be negative — the POST resolves to
              -- the nearest dose within ±12h, so confirming at 07:00 for an
              -- 08:00 dose matches the 08:00 row. Excluded here rather than
              -- clamped into bucket 0, which would invent punctuality.
              AND COALESCE(confirmed_reported_at, confirmed_at) >= scheduled_for
            GROUP BY 1 ORDER BY 1`, [route.userId, from, to]),

          db.query(`
            -- The timeline. **The join to medication_reminders is the whole
            -- point** (§4) — without the medication name this is a list of
            -- timestamps nobody can act on.
            SELECT d.id, d.scheduled_for, d.confirmed_at, d.confirmed_by,
                   d.confirmed_reported_at, d.alarm_shown_at,
                   d.snoozed_until, d.snooze_count, d.user_id,
                   l.name AS med_name, r.selected_dosage,
                   -- **Decided here, against the server's clock.** The browser
                   -- must not be the thing that rules a dose missed: it would
                   -- disagree with the summary counts beside it whenever the
                   -- viewer's clock is off, and "missed" is the one label on
                   -- this page that reads as a judgement about a person (D-4).
                   CASE WHEN d.confirmed_at IS NOT NULL THEN 'confirmed'
                        WHEN d.scheduled_for < now()   THEN 'missed'
                        ELSE 'scheduled' END AS status
            FROM medication_doses d
            JOIN medication_reminders r ON r.id = d.reminder_id
            JOIN medication_library   l ON l.id = r.med_id
            WHERE d.user_id = $1 AND d.scheduled_for BETWEEN $2 AND $3
            ORDER BY d.scheduled_for DESC
            LIMIT 500`, [route.userId, from, to]),
        ]);

        return json(200, {
          from, to,
          summary: summary.rows[0],
          daily: daily.rows,
          latency: latency.rows,
          timeline: timeline.rows,
        });
      }

      case 'getDailyOpens': {
        const db = getPool();
        const q = event.queryStringParameters ?? {};
        const { from, to } = adherenceRange(q);
        // Straight out of the nightly rollup (§4 / migration 012). No Athena
        // call on the request path — that is the entire point of the job.
        const res = await db.query(`
          SELECT day, source, opens, users, refreshed_at
          FROM telemetry_daily_opens
          WHERE day BETWEEN $1::date AND $2::date
          ORDER BY day`, [from, to]);
        return json(200, { opens: res.rows });
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

      case 'listAnnouncementTypes': {
        const db = getPool();
        const res = await db.query(
          `SELECT t.*, COUNT(a.id)::int AS article_count
             FROM announcement_types t
             LEFT JOIN announcements a ON a.type_id = t.id
            GROUP BY t.id
            ORDER BY t.sort_order ASC, t.id ASC`
        );
        // `article_count` is what lets the editor grey out a delete before the
        // user clicks it, rather than explaining the RESTRICT afterwards.
        return json(200, { types: res.rows });
      }

      case 'createAnnouncementType':
      case 'updateAnnouncementType': {
        let input;
        try {
          input = JSON.parse(event.body ?? '');
        } catch {
          return json(400, { error: 'Request body must be JSON' });
        }

        const problems = validateAnnouncementType(input);
        if (problems.length > 0) return json(422, { error: 'Validation failed', problems });

        const db = getPool();
        const values = [
          String(input.label_en).trim(),
          isFilled(input.label_zh_hant) ? String(input.label_zh_hant).trim() : null,
          input.color ?? null,
          Number.isInteger(input.sort_order) ? input.sort_order : 0,
        ];

        try {
          if (route.name === 'createAnnouncementType') {
            const res = await db.query(
              `INSERT INTO announcement_types (label_en, label_zh_hant, color, sort_order)
               VALUES ($1, $2, $3, $4) RETURNING *`,
              values
            );
            return json(201, { type: res.rows[0] });
          }
          const res = await db.query(
            `UPDATE announcement_types
                SET label_en = $1, label_zh_hant = $2, color = $3, sort_order = $4
              WHERE id = $5 RETURNING *`,
            [...values, route.id]
          );
          if (res.rowCount === 0) return json(404, { error: `No article type with id ${route.id}` });
          return json(200, { type: res.rows[0] });
        } catch (e) {
          // 23505 is the case-insensitive unique index on label_en. Reported as
          // a named field rather than swallowed into the catch-all 500, because
          // "News already exists" is something the user can act on.
          if (e?.code === '23505') {
            return json(422, { error: 'Validation failed', problems: ['a type with that English label already exists'] });
          }
          throw e;
        }
      }

      case 'deleteAnnouncementType': {
        const db = getPool();
        try {
          const res = await db.query('DELETE FROM announcement_types WHERE id = $1 RETURNING id', [route.id]);
          if (res.rowCount === 0) return json(404, { error: `No article type with id ${route.id}` });
          return json(200, { deleted: route.id });
        } catch (e) {
          // Migration 010's ON DELETE RESTRICT doing its job. **Two codes, and
          // the distinction is not academic:** Postgres raises `23001`
          // (restrict_violation) for an explicit RESTRICT and `23503`
          // (foreign_key_violation) for the NO ACTION default. Only 23001 can
          // actually reach here today; 23503 is listed so that changing the
          // constraint later cannot silently turn this 409 back into a 500.
          //
          // Found live, not by a test — the unit test asserted 23503 because
          // that is what the code assumed, so it agreed with the bug.
          if (e?.code === '23001' || e?.code === '23503') {
            return json(409, {
              error: 'That type is still used by one or more articles. Move them to another type first.',
              code: 'TYPE_IN_USE',
            });
          }
          throw e;
        }
      }

      case 'listAnnouncements': {
        // Drafts included and unresolved: this is the editor's view, so it needs
        // both languages side by side and the articles that are not live yet.
        // The patient-facing read in the app backend is the opposite of this on
        // both counts.
        const db = getPool();
        const [articles, types] = await Promise.all([
          db.query(
            `SELECT a.*, t.label_en AS type_label_en, t.label_zh_hant AS type_label_zh_hant, t.color AS type_color
               FROM announcements a
               JOIN announcement_types t ON t.id = a.type_id
              ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id DESC`
          ),
          // Returned alongside rather than fetched separately: the editor needs
          // them to render a type picker on every article, and a second round
          // trip would let the page paint a picker with nothing in it.
          db.query('SELECT * FROM announcement_types ORDER BY sort_order ASC, id ASC'),
        ]);
        return json(200, { announcements: articles.rows, types: types.rows });
      }

      case 'createAnnouncement':
      case 'updateAnnouncement': {
        let input;
        try {
          input = JSON.parse(event.body ?? '');
        } catch {
          return json(400, { error: 'Request body must be JSON' });
        }

        const publishing = input?.published === true;
        const problems = validateAnnouncement(input, { publishing });
        if (problems.length > 0) return json(422, { error: 'Validation failed', problems });

        const db = getPool();
        const values = [
          input.title_en ?? null,
          input.title_zh_hant ?? null,
          input.content_en ?? null,
          input.content_zh_hant ?? null,
          input.type_id,
        ];

        try {
          if (route.name === 'createAnnouncement') {
            const res = await db.query(
              `INSERT INTO announcements
                 (title_en, title_zh_hant, content_en, content_zh_hant, type_id, published_at)
               VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() ELSE NULL END)
               RETURNING *`,
              [...values, publishing]
            );
            return json(201, { announcement: res.rows[0] });
          }

        // **An edit to a live article keeps its original publication date.**
        // COALESCE rather than now(): the patient-facing list orders by
        // published_at, so restamping it would jump a typo fix to the top of
        // everyone's home screen above genuinely newer news. Unpublishing
        // clears it outright, so re-publishing later is deliberately a new date.
          const res = await db.query(
            `UPDATE announcements SET
               title_en = $1, title_zh_hant = $2,
               content_en = $3, content_zh_hant = $4,
               type_id = $5,
               published_at = CASE WHEN $6::boolean THEN COALESCE(published_at, now()) ELSE NULL END,
               updated_at = now()
             WHERE id = $7
             RETURNING *`,
            [...values, publishing, route.id]
          );
          if (res.rowCount === 0) return json(404, { error: `No article with id ${route.id}` });
          return json(200, { announcement: res.rows[0] });
        } catch (e) {
          // 23503: a type_id that is not a row. Only reachable from a stale
          // editor whose type was deleted in another tab, so it is a real case
          // rather than a defensive one.
          if (e?.code === '23503') {
            return json(422, { error: 'Validation failed', problems: ['that article type no longer exists — reload and pick another'] });
          }
          throw e;
        }
      }

      case 'deleteAnnouncement': {
        const db = getPool();
        const res = await db.query('DELETE FROM announcements WHERE id = $1 RETURNING id', [route.id]);
        if (res.rowCount === 0) return json(404, { error: `No article with id ${route.id}` });
        return json(200, { deleted: route.id });
      }

      default:
        return json(404, { error: `No route for ${method} ${path}` });
    }
  } catch (e) {
    console.error('admin-api error:', e);
    return json(500, { error: 'Internal error' }); // details stay in CloudWatch, not the response
  }
}
