// XIOM Package Registry -- category vocabulary and metadata normalization.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Categories are a controlled, registry-owned vocabulary so browsing and
// agent queries stay predictable; anything niche belongs in the free-form
// `keywords` list (search-only). Publishers declare both in package.xi and
// the server extracts them from the uploaded tarball, so no client change is
// needed to publish them.

'use strict';

const CATEGORIES = Object.freeze([
  'core',
  'data',
  'database',
  'web',
  'network',
  'graphics',
  'media',
  'ai-ml',
  'science',
  'crypto-security',
  'cloud-infra',
  'observability',
  'concurrency',
  'systems',
  'tooling',
  'testing',
  'text-nlp',
]);

/** Accepted spellings that map onto the canonical vocabulary. */
const ALIASES = Object.freeze({
  ai: 'ai-ml',
  ml: 'ai-ml',
  'machine-learning': 'ai-ml',
  graphics2d: 'graphics',
  gpu: 'graphics',
  crypto: 'crypto-security',
  security: 'crypto-security',
  db: 'database',
  databases: 'database',
  cloud: 'cloud-infra',
  infra: 'cloud-infra',
  infrastructure: 'cloud-infra',
  logging: 'observability',
  metrics: 'observability',
  monitoring: 'observability',
  iot: 'systems',
  embedded: 'systems',
  os: 'systems',
  nlp: 'text-nlp',
  text: 'text-nlp',
  i18n: 'text-nlp',
  l10n: 'text-nlp',
  multimedia: 'media',
  audio: 'media',
  video: 'media',
});

const MAX_CATEGORIES = 3;
const MAX_KEYWORDS = 10;
const MAX_KEYWORD_LENGTH = 32;
const KEYWORD_PATTERN = /^[a-z0-9][a-z0-9.+#-]*$/;

/** Package maturity stages a manifest may declare (drives UI badges). */
const STAGES = Object.freeze(['incubating', 'stable', 'deprecated']);

/**
 * Normalize the manifest's optional `stage:` value. Unknown values are
 * ignored and surfaced to the publisher as a warning, like categories.
 *
 * @param {unknown} raw
 * @returns {{ stage: string, unknown: string }}
 */
function normalizeStage(raw) {
  if (typeof raw !== 'string') return { stage: '', unknown: '' };
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === '') return { stage: '', unknown: '' };
  if (STAGES.includes(cleaned)) return { stage: cleaned, unknown: '' };
  return { stage: '', unknown: cleaned };
}

/** True when `name` is a canonical category. */
function isCategory(name) {
  return CATEGORIES.includes(name);
}

/**
 * Normalize the manifest's `categories:` array.
 *
 * @param {unknown} raw
 * @returns {{ categories: string[], unknown: string[] }} canonical, deduped,
 *   capped at MAX_CATEGORIES; `unknown` lists entries that were not in the
 *   vocabulary (surfaced to the publisher as a publish warning).
 */
function normalizeCategories(raw) {
  const values = toStringArray(raw);
  const categories = [];
  const unknown = [];
  for (const value of values) {
    const cleaned = value.trim().toLowerCase();
    if (cleaned === '') continue;
    const canonical = isCategory(cleaned) ? cleaned : ALIASES[cleaned];
    if (!canonical) {
      if (!unknown.includes(cleaned)) unknown.push(cleaned);
      continue;
    }
    if (!categories.includes(canonical)) categories.push(canonical);
  }
  return { categories: categories.slice(0, MAX_CATEGORIES), unknown };
}

/**
 * Normalize the manifest's `keywords:` array: lowercase, search-safe
 * characters, deduped, capped. Keywords never affect the vocabulary.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeKeywords(raw) {
  const values = toStringArray(raw);
  const keywords = [];
  for (const value of values) {
    const cleaned = value.trim().toLowerCase()
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9.+#-]+$/, '');
    if (cleaned === '' || cleaned.length > MAX_KEYWORD_LENGTH) continue;
    if (!KEYWORD_PATTERN.test(cleaned)) continue;
    if (!keywords.includes(cleaned)) keywords.push(cleaned);
  }
  return keywords.slice(0, MAX_KEYWORDS);
}

/** Package-level metadata extracted from a manifest and normalized. */
function normalizePackageMetadata(manifest) {
  const { categories, unknown } = normalizeCategories(manifest.categories);
  const { stage, unknown: unknownStage } = normalizeStage(manifest.stage);
  return {
    categories,
    unknownCategories: unknown,
    keywords: normalizeKeywords(manifest.keywords),
    license: stringOrEmpty(manifest.license).slice(0, 64),
    repository: stringOrEmpty(manifest.repository).slice(0, 512),
    stage,
    unknownStage,
  };
}

/** Category list with package counts, highest count first then alphabetical. */
function categoryCounts(index) {
  const counts = new Map(CATEGORIES.map((name) => [name, 0]));
  for (const pkg of Object.values(index.packages || {})) {
    for (const category of pkg.categories || []) {
      if (counts.has(category)) counts.set(category, counts.get(category) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
}

function toStringArray(raw) {
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string');
  if (typeof raw === 'string' && raw.trim() !== '') return [raw];
  return [];
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  CATEGORIES,
  ALIASES,
  STAGES,
  isCategory,
  normalizeCategories,
  normalizeKeywords,
  normalizeStage,
  normalizePackageMetadata,
  categoryCounts,
  MAX_CATEGORIES,
  MAX_KEYWORDS,
};
