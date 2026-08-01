#!/usr/bin/env node
// Runs `maestro check-syntax` over every flow under .maestro/.
//
// Exists because `check-syntax` takes exactly one file per invocation, and
// because it is the only Maestro check that needs neither a device nor a
// build — which makes it the one part of the E2E setup that can run in the
// same breath as `npm test` and `tsc --noEmit`.
//
// It is a real check, not a formality: an unrecognised command (a typo'd
// `tapOn`, a command removed in a Maestro upgrade) exits non-zero here rather
// than surfacing twenty minutes into an EAS run. It does NOT verify that
// selectors exist, that ${MAESTRO_APP_ID} resolves, or that a flow passes —
// only that Maestro can parse and understand every step.
//
// Run: node scripts/check-maestro-syntax.mjs
// Requires `maestro` on PATH; skips with a notice (exit 0) if absent, so this
// never breaks a checkout that has not installed it.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOW_DIR = path.join(__dirname, '..', '.maestro');

// `maestro` ships as a .bat on Windows, and Node cannot exec a .bat directly.
// `shell: true` would work but triggers DEP0190 (args are concatenated, not
// escaped); going through cmd.exe with an argument array keeps the escaping
// and stays quiet.
const WIN = process.platform === 'win32';

function maestro(args) {
  return WIN
    ? spawnSync('cmd.exe', ['/c', 'maestro', ...args], { encoding: 'utf8' })
    : spawnSync('maestro', args, { encoding: 'utf8' });
}

function flowFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...flowFiles(full));
    } else if (entry.name.endsWith('.yml')) {
      // config.yaml is workspace configuration, not a flow — check-syntax
      // rejects it because it has no steps. The .yaml extension excludes it.
      out.push(full);
    }
  }
  return out;
}

const probe = maestro(['--version']);
if (probe.error || probe.status !== 0) {
  console.log('• maestro not on PATH — skipping flow syntax check.');
  console.log('  See .maestro/README.md for the one-time install.');
  process.exit(0);
}

const files = flowFiles(FLOW_DIR).sort();
if (files.length === 0) {
  console.error(`✗ no .yml flows found under ${FLOW_DIR}`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  const res = maestro(['check-syntax', file]);
  if (res.status === 0) {
    console.log(`✓ ${rel}`);
  } else {
    failed++;
    // The banner Maestro prints on every invocation is noise here; the lines
    // that matter are the ones naming the offending command and position.
    const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`
      .split('\n')
      .filter((l) => l.trim() && !/^[\s?│╭╰─]*$/.test(l) && !/analytics|Analyze with Ai|maestro\.mobile\.dev|MAESTRO_CLI/i.test(l))
      .join('\n    ');
    console.error(`✗ ${rel}\n    ${detail}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} flow(s) failed syntax check.`);
  process.exit(1);
}
console.log(`\n${files.length} flow(s) OK.`);
