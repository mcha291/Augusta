#!/usr/bin/env node
// Validates that locales/*.json stay in sync with each other:
//   1. Both files parse as valid JSON.
//   2. Every key exists in both locales (compared by "stem", so plural
//      variants like `_one`/`_other` don't false-positive when a language
//      legitimately only needs one form).
//   3. Every {{interpolation}} placeholder used for a key in one locale is
//      also used for that key in the other locale.
//
// Run: node scripts/validate-translations.mjs
// Exits non-zero (and prints every problem found) on failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Optional override (e.g. `node validate-translations.mjs /some/dir`) so this
// can be exercised against a scratch copy without touching the real locales.
const LOCALES_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'locales');

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

function loadLocale(filename) {
  const filePath = path.join(LOCALES_DIR, filename);
  const raw = readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`✗ ${filename} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

function stemOf(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  return key;
}

function placeholdersIn(text) {
  if (typeof text !== 'string') return new Set();
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  return new Set(Array.from(matches, (m) => m[1]));
}

function groupByStem(flatMap) {
  const stems = new Map(); // stem -> [{ key, value }]
  for (const [key, value] of Object.entries(flatMap)) {
    const stem = stemOf(key);
    if (!stems.has(stem)) stems.set(stem, []);
    stems.get(stem).push({ key, value });
  }
  return stems;
}

const en = loadLocale('en.json');
const zhHant = loadLocale('zh-Hant.json');

const enFlat = flatten(en);
const zhFlat = flatten(zhHant);

const enStems = groupByStem(enFlat);
const zhStems = groupByStem(zhFlat);

const problems = [];

for (const stem of enStems.keys()) {
  if (!zhStems.has(stem)) problems.push(`Missing in zh-Hant.json: "${stem}" (present in en.json)`);
}
for (const stem of zhStems.keys()) {
  if (!enStems.has(stem)) problems.push(`Missing in en.json: "${stem}" (present in zh-Hant.json)`);
}

for (const stem of enStems.keys()) {
  if (!zhStems.has(stem)) continue;

  const enPlaceholders = new Set();
  for (const { value } of enStems.get(stem)) for (const p of placeholdersIn(value)) enPlaceholders.add(p);

  const zhPlaceholders = new Set();
  for (const { value } of zhStems.get(stem)) for (const p of placeholdersIn(value)) zhPlaceholders.add(p);

  const missingInZh = [...enPlaceholders].filter((p) => !zhPlaceholders.has(p));
  const missingInEn = [...zhPlaceholders].filter((p) => !enPlaceholders.has(p));

  if (missingInZh.length > 0) {
    problems.push(`"${stem}": placeholder(s) {{${missingInZh.join('}}, {{')}}} used in en.json but missing from zh-Hant.json`);
  }
  if (missingInEn.length > 0) {
    problems.push(`"${stem}": placeholder(s) {{${missingInEn.join('}}, {{')}}} used in zh-Hant.json but missing from en.json`);
  }
}

if (problems.length > 0) {
  console.error(`✗ Translation validation failed with ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`✓ Translations valid: ${enStems.size} keys checked across en.json and zh-Hant.json.`);
