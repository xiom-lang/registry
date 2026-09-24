// XIOM Package Registry -- package.xi metadata extraction from a published tarball.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// `xiom pkg publish` uploads only name/version/signature/publicKey as form
// fields; description and dependencies exist solely in the tarball's
// `package.xi`. The parser below mirrors the client's tolerant parser
// (crates/xiom-pkg/src/main.rs) without its `deps:` block-state complexity --
// enough for index metadata, and everything is best-effort: an unparseable
// manifest yields empty fields, never a failed publish.
//
// Reading strategy: the tarball is already a bounded upload (<=50 MiB by
// default), so it is decompressed in one shot with an explicit output cap --
// a gzip bomb cannot exceed MAX_DECOMPRESSED_BYTES, and the tar member list
// is walked header-by-header without extracting anything to disk.

'use strict';

const fs = require('fs');
const zlib = require('zlib');

const MANIFEST_BASENAME = 'package.xi';
const TAR_BLOCK_SIZE = 512;

const EMPTY_MANIFEST = Object.freeze({
  name: '',
  version: '',
  description: '',
  dependencies: {},
  categories: [],
  keywords: [],
  license: '',
  repository: '',
});

/**
 * Extract and parse the manifest from a gzipped tarball.
 * Never throws on malformed archives: returns empty metadata instead.
 *
 * @param {string} tarballPath
 * @param {{ maxManifestBytes: number, maxDecompressedBytes: number }} limits
 * @returns {{ name: string, version: string, description: string,
 *   dependencies: Record<string,string>, categories: string[],
 *   keywords: string[], license: string, repository: string }}
 */
function extractManifest(tarballPath, limits) {
  let buffer;
  try {
    buffer = readManifestMember(tarballPath, limits);
  } catch (err) {
    // Corrupt gzip, oversized expansion, unreadable file: metadata is
    // optional, the artifact itself is validated by digest/signature.
    return { ...EMPTY_MANIFEST };
  }
  if (!buffer) return { ...EMPTY_MANIFEST };
  return parseManifest(buffer.toString('utf-8'));
}

/**
 * Return the first `package.xi` member's contents (bounded), or null.
 * @returns {Buffer|null}
 */
function readManifestMember(tarballPath, { maxManifestBytes, maxDecompressedBytes }) {
  const compressed = fs.readFileSync(tarballPath);
  const tar = zlib.gunzipSync(compressed, { maxOutputLength: maxDecompressedBytes });

  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = parseTarHeader(tar.subarray(offset, offset + TAR_BLOCK_SIZE));
    if (!header) return null; // end-of-archive or unreadable header
    offset += TAR_BLOCK_SIZE;

    const dataLength = header.size;
    const paddedLength = Math.ceil(dataLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const isManifest = header.type === 'file'
      && header.name.split('/').pop() === MANIFEST_BASENAME;
    if (isManifest) {
      const take = Math.min(dataLength, maxManifestBytes);
      return Buffer.from(tar.subarray(offset, offset + take));
    }
    offset += paddedLength;
    if (offset > tar.length) return null;
  }
  return null;
}

/** Parse a 512-byte ustar header; null for the zero end-of-archive block. */
function parseTarHeader(block) {
  if (block.length < TAR_BLOCK_SIZE) return null;
  // Any all-zero header terminates the archive.
  let allZero = true;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    if (block[i] !== 0) { allZero = false; break; }
  }
  if (allZero) return null;

  const rawName = readCString(block.subarray(0, 100));
  const prefix = readCString(block.subarray(345, 500));
  const name = prefix ? `${prefix}/${rawName}` : rawName;
  const size = parseOctal(block.subarray(124, 136));
  const typeByte = block[156];
  const type = typeByte === 0 || typeByte === 0x30 /* '0' */
    ? 'file'
    : typeByte === 0x35 /* '5' */ ? 'directory' : 'other';
  return { name, size, type };
}

function readCString(buffer) {
  const end = buffer.indexOf(0);
  return (end === -1 ? buffer : buffer.subarray(0, end)).toString('utf-8');
}

function parseOctal(buffer) {
  const text = readCString(buffer).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Parse the textual manifest. Mirrors the client's tolerance:
 * - outer `package x { ... }` / `{ ... }` wrapper
 * - `//` comments and blank lines
 * - `name: "x";` single-line fields
 * - `deps: { "a": "1.0", ... }` inline or multiline blocks
 *
 * @param {string} text
 */
function parseManifest(text) {
  const source = stripOuterBlock(text);
  const lines = source.split(/\r?\n/);

  const fields = {
    name: '',
    version: '',
    description: '',
    dependencies: {},
    categories: [],
    keywords: [],
    license: '',
    repository: '',
    stage: '',
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('//')) continue;

    const name = readField(line, 'name:');
    if (name !== null) { fields.name = name; continue; }
    const version = readField(line, 'version:');
    if (version !== null) { fields.version = version; continue; }
    const description = readField(line, 'description:');
    if (description !== null) { fields.description = description; continue; }
    const license = readField(line, 'license:');
    if (license !== null) { fields.license = license; continue; }
    const repository = readField(line, 'repository:');
    if (repository !== null) { fields.repository = repository; continue; }
    const stage = readField(line, 'stage:');
    if (stage !== null) { fields.stage = stage; continue; }

    // Array-valued metadata: inline (`categories: ["graphics"];`) or
    // multiline blocks. Values are normalized by src/categories.js.
    const arrayField = /^(categories|keywords)\s*[:=]/.exec(line);
    if (arrayField) {
      const { values, consumed } = parseStringList(lines, i);
      fields[arrayField[1]] = values;
      i += consumed;
      continue;
    }

    if (/^deps\s*[:=]/.test(line)) {
      const { deps, consumed } = parseDepsBlock(lines, i);
      fields.dependencies = deps;
      i += consumed;
    }
  }
  return fields;
}

/**
 * Collect the quoted strings of an array literal starting on `lines[start]`
 * (`key: ["a", "b"];` on one line, or a multiline block ending with `]`).
 * Returns `consumed` = how many extra lines the caller must skip.
 */
function parseStringList(lines, start) {
  let block = '';
  let i = start;
  let consumed = 0;
  for (; i < lines.length; i++) {
    block += `\n${lines[i]}`;
    if (block.includes(']')) break;
  }
  if (i > start) consumed = i - start;

  const open = block.indexOf('[');
  const close = block.lastIndexOf(']');
  if (open === -1 || close <= open) return { values: [], consumed };

  const inner = block.slice(open + 1, close);
  const values = [];
  const re = /["']([^"']*)["']/g;
  let match;
  while ((match = re.exec(inner)) !== null) values.push(match[1]);
  return { values, consumed };
}

/**
 * Extract a `key: "value"` / `key: value` field from a trimmed line.
 * Returns null when the line is not that field (so `name:` never matches
 * `filename:`). Trailing `;`/`,` and surrounding quotes are stripped.
 */
function readField(line, key) {
  if (!line.startsWith(key)) return null;
  return stripQuotes(stripTrailingSeparators(line.slice(key.length)));
}

function stripTrailingSeparators(value) {
  let out = value.trim();
  while (out.endsWith(';') || out.endsWith(',')) out = out.slice(0, -1).trim();
  return out;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Collect a deps block (inline or multiline) and extract "name": "spec" pairs. */
function parseDepsBlock(lines, start) {
  let block = '';
  let depth = 0;
  let i = start;
  let consumed = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    block += `\n${line}`;
    depth += braceDelta(line);
    const done = depth <= 0 && (i > start || block.includes('{'));
    if (done) break;
  }
  if (i > start) consumed = i - start;

  const deps = {};
  const pairRe = /["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']([^"']+)["']/g;
  const braceStart = block.indexOf('{');
  const inner = braceStart === -1 ? '' : block.slice(braceStart + 1);
  let match;
  while ((match = pairRe.exec(inner)) !== null) {
    deps[match[1]] = match[2];
  }
  return { deps, consumed };
}

function braceDelta(line) {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

/**
 * Strip a leading `{ ... }` or `package name { ... }` wrapper when the first
 * meaningful line starts the block. Mirrors the client's `strip_outer_block`.
 */
function stripOuterBlock(text) {
  let firstMeaningful = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    firstMeaningful = trimmed;
    break;
  }
  if (!firstMeaningful) return text;
  const openBrace = text.indexOf('{');
  if (openBrace === -1) return text;
  const looksLikePackageBlock = /^(\{|package\s+[A-Za-z_][A-Za-z0-9_]*)/.test(firstMeaningful);
  if (!looksLikePackageBlock) return text;
  const closeBrace = text.lastIndexOf('}');
  if (closeBrace <= openBrace) return text;
  return text.slice(openBrace + 1, closeBrace).trim();
}

module.exports = {
  extractManifest,
  parseManifest,
  parseTarHeader,
  stripOuterBlock,
  MANIFEST_BASENAME,
};
