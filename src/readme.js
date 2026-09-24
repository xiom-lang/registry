// XIOM Package Registry -- README extraction from a published tarball.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Readmes come from the stored artifact, never from a GitHub fetch at
// page-view time: the publisher controls the tarball, so it is the only
// immutable, non-SSRF source (SESSION.md section 13). Best-effort like the
// manifest reader: an absent, unreadable, or oversized member yields null.

'use strict';

const { readTarMember } = require('./manifest');

const README_BASENAME = 'readme.md';
const README_MAX_BYTES = 64 * 1024;

/**
 * Extract README.md from a gzipped tarball (any directory depth,
 * case-insensitive basename), bounded by `maxReadmeBytes`.
 *
 * @param {string} tarballPath
 * @param {{ maxReadmeBytes?: number, maxDecompressedBytes?: number }} [limits]
 * @returns {string|null}
 */
function extractReadme(tarballPath, limits = {}) {
  let buffer;
  try {
    buffer = readTarMember(tarballPath, {
      basenames: [README_BASENAME],
      maxBytes: limits.maxReadmeBytes || README_MAX_BYTES,
      maxDecompressedBytes: limits.maxDecompressedBytes,
    });
  } catch {
    // Corrupt gzip, oversized expansion, unreadable file: no readme.
    return null;
  }
  return buffer ? buffer.toString('utf-8') : null;
}

module.exports = { extractReadme, README_BASENAME, README_MAX_BYTES };
