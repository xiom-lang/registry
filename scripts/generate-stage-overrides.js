// XIOM Package Registry -- generate stage-overrides.json (SESSION.md 21.4).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Builds the audited display-stage override file from the publisher repo's
// STATUS.json files, so entries published before the workflow stamped the
// manifest still get the right badge. The output is reviewed as a PR in the
// registry repo; the service only reads it (display-only, never publish
// authorization).
//
// Usage:
//   node scripts/generate-stage-overrides.js \
//     --packages-dir ../xiom-packages/packages/packages \
//     --repository xiom-packages/packages \
//     --commit 471c5e3 \
//     --why "badge backfill from STATUS.json" \
//     --index https://registry.xiom-lang.org/index.json \
//     --out stage-overrides.json
//
// --index is optional: when given, only packages that are actually published
// with an empty stage are emitted (keeps the file minimal). Usage without it
// emits every valid STATUS.json stage.

'use strict';

const fs = require('fs');
const path = require('path');

const { STAGES } = require('../src/categories');
const { EXCLUDED_PACKAGES } = require('../src/stage-overrides');

const STAGE_SET = new Set(STAGES);
const EXCLUDED_SET = new Set(EXCLUDED_PACKAGES);
const SAFE_PACKAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/**
 * Read one STATUS.json and return { name, stage } when it is usable.
 * The directory name (`xiom-pci`) is only a fallback: STATUS.json's `package`
 * field is authoritative (`xiom.pci`).
 */
function readStatus(file, dirName) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { error: `${dirName}: STATUS.json is unreadable or corrupt` };
  }
  const name = typeof parsed.package === 'string' && parsed.package
    ? parsed.package
    : dirName.replace(/^xiom-/, 'xiom.');
  if (!SAFE_PACKAGE_NAME.test(name)) return { error: `${dirName}: unusable package name "${name}"` };
  if (!STAGE_SET.has(parsed.stage)) return { error: `${name}: stage "${parsed.stage}" is not a known stage` };
  if (EXCLUDED_SET.has(name)) return { skipped: `${name}: excluded from display-stage overrides` };
  return { name, stage: parsed.stage };
}

/**
 * Build the override document.
 *
 * @param {{ packagesDir: string, repository?: string, commit?: string,
 *           why?: string, index?: object|null, now?: string }} input
 * @returns {{ document: object, counts: object, errors: string[], skipped: string[] }}
 */
function generateStageOverrides({ packagesDir, repository = '', commit = '', why = '', index = null, now = new Date().toISOString() }) {
  const overrides = {};
  const errors = [];
  const skipped = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    throw new Error(`cannot read packages directory ${packagesDir}: ${err.message}`);
  }
  for (const dir of dirs) {
    const statusFile = path.join(packagesDir, dir, 'STATUS.json');
    if (!fs.existsSync(statusFile)) continue;
    const result = readStatus(statusFile, dir);
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    if (result.skipped) {
      skipped.push(result.skipped);
      continue;
    }
    // Optional publish filter: keep only names present in the given index
    // whose package entry has no stage yet.
    if (index) {
      const pkg = index.packages ? index.packages[result.name] : null;
      if (!pkg) continue;
      if (typeof pkg.stage === 'string' && pkg.stage !== '') continue;
    }
    overrides[result.name] = result.stage;
  }
  const sorted = {};
  for (const name of Object.keys(overrides).sort()) sorted[name] = overrides[name];
  const counts = { total: Object.keys(sorted).length };
  for (const stage of STAGES) {
    counts[stage] = Object.values(sorted).filter((value) => value === stage).length;
  }
  return {
    document: {
      version: 1,
      source: {
        repository,
        commit,
        generated_at: now,
        why,
      },
      overrides: sorted,
    },
    counts,
    errors,
    skipped,
  };
}

async function readIndex(source) {
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`cannot fetch index ${source}: HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(fs.readFileSync(source, 'utf-8'));
}

function parseArgs(argv) {
  const args = { out: 'stage-overrides.json', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--packages-dir') { args.packagesDir = value; i += 1; }
    else if (key === '--repository') { args.repository = value; i += 1; }
    else if (key === '--commit') { args.commit = value; i += 1; }
    else if (key === '--why') { args.why = value; i += 1; }
    else if (key === '--index') { args.index = value; i += 1; }
    else if (key === '--out') { args.out = value; i += 1; }
    else if (key === '--dry-run') { args.dryRun = true; }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.packagesDir) {
    console.log('usage: node scripts/generate-stage-overrides.js --packages-dir <dir> [--repository <repo>] [--commit <sha>] [--why <text>] [--index <url|file>] [--out <file>] [--dry-run]');
    return args.help ? 0 : 1;
  }
  const index = await readIndex(args.index);
  const { document, counts, errors, skipped } = generateStageOverrides({
    packagesDir: args.packagesDir,
    repository: args.repository || '',
    commit: args.commit || '',
    why: args.why || '',
    index,
  });
  for (const error of errors) console.warn(`skip: ${error}`);
  for (const note of skipped) console.warn(`skip: ${note}`);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (args.dryRun) {
    process.stdout.write(serialized);
    return 0;
  }
  fs.writeFileSync(args.out, serialized);
  console.log(`wrote ${args.out}: ${counts.total} override${counts.total === 1 ? '' : 's'} (${STAGES.map((stage) => `${stage}=${counts[stage]}`).join(', ')})`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(`generate-stage-overrides: ${err.message}`); process.exitCode = 1; });
}

module.exports = { generateStageOverrides, readStatus };
