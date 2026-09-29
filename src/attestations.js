// XIOM Package Registry -- GitHub build-attestation links (C2, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// A version published through a trusted publisher can carry the GitHub
// artifact-attestation URL for its tarball. The registry stores that link
// alongside the OIDC provenance (`publisher.attestation`) and renders it; it
// never verifies the attestation itself -- GitHub Sigstore bundles are the
// authority, and the link simply takes a reader there.
//
// Two ways in:
//   1. the publisher supplies `attestation` at publish time (validated), or
//   2. the registry asks GitHub's public attestations API by subject digest
//      (`GET /repos/{owner}/{repo}/attestations/sha256:<hex>`) right after a
//      provenance publish, best-effort, and stores what it finds.
// Discovery never blocks or fails a publish, and a token is optional: public
// repositories answer unauthenticated. `GITHUB_ATTESTATIONS_TOKEN` (falling
// back to `GITHUB_SPONSORS_TOKEN`) only raises rate limits and covers
// repositories that are private but still trusted publishers.
//
// Nothing here touches artifacts, signatures, or digests: the attestation is
// display metadata for an already-verified publisher identity.

'use strict';

const ATTESTATION_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/attestations\/([0-9]+)$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DISCOVERY_TIMEOUT_MS = 4000;

/** True for a canonical GitHub attestation link (the only shape stored). */
function isAttestationUrl(value) {
  return typeof value === 'string' && ATTESTATION_URL.test(value.trim());
}

/**
 * Ask GitHub for a provenance attestation on `sha256` in `repository`.
 * Any answer we cannot use -- no token, timeout, 404, an empty list, a
 * malformed body -- reads as "no attestation", never an error.
 *
 * @returns {Promise<string>} the attestation URL, or '' when none is found.
 */
async function discoverAttestation({
  repository,
  sha256,
  token = '',
  apiUrl = 'https://api.github.com',
  fetchImpl = null,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
}) {
  const repo = String(repository || '').trim();
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!SAFE_REPOSITORY.test(repo) || !/^[0-9a-f]{64}$/.test(digest)) return '';
  const doFetch = fetchImpl || fetch;
  const url = `${String(apiUrl).replace(/\/+$/, '')}/repos/${repo}/attestations/sha256:${digest}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xiom-registry',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await doFetch(url, { headers, signal: controller.signal });
    if (!response.ok) return '';
    const body = await response.json();
    const list = body && Array.isArray(body.attestations) ? body.attestations : [];
    for (const entry of list) {
      if (!entry || (typeof entry.id !== 'number' && typeof entry.id !== 'string')) continue;
      const id = String(entry.id);
      if (!/^[0-9]+$/.test(id)) continue;
      return `https://github.com/${repo}/attestations/${id}`;
    }
    return '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isAttestationUrl,
  discoverAttestation,
  DISCOVERY_TIMEOUT_MS,
};
