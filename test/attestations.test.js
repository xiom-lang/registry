// XIOM Package Registry -- C2 attestation link tests.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md 21 C2: the registry stores and renders a GitHub attestation URL
// per version when one is supplied or discoverable. Discovery is best-effort
// and must degrade to "no attestation" for every failure mode.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAttestationUrl, discoverAttestation } = require('../src/attestations');

const DIGEST = 'a'.repeat(64);

test('isAttestationUrl accepts only canonical GitHub attestation links', () => {
  assert.equal(isAttestationUrl('https://github.com/xiom-lang/stdlib/attestations/1234567'), true);
  assert.equal(isAttestationUrl('  https://github.com/xiom-lang/xiom/attestations/1  '), true);
  assert.equal(isAttestationUrl('https://github.com/xiom-lang/xiom/attestations/abc'), false);
  assert.equal(isAttestationUrl('https://github.com/xiom-lang/xiom/attestations/1/extra'), false);
  assert.equal(isAttestationUrl('https://evil.example/xiom-lang/xiom/attestations/1'), false);
  assert.equal(isAttestationUrl('http://github.com/xiom-lang/xiom/attestations/1'), false);
  assert.equal(isAttestationUrl('javascript:alert(1)'), false);
  assert.equal(isAttestationUrl(''), false);
  assert.equal(isAttestationUrl(null), false);
});

test('discoverAttestation reads the first numeric attestation id', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return {
      ok: true,
      json: async () => ({
        attestations: [
          { id: 77, bundle_url: 'https://example/bundle' },
          { id: 78 },
        ],
      }),
    };
  };
  const url = await discoverAttestation({
    repository: 'xiom-lang/registry',
    sha256: DIGEST,
    token: 'tok',
    apiUrl: 'https://api.github.test',
    fetchImpl,
  });
  assert.equal(url, 'https://github.com/xiom-lang/registry/attestations/77');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.github.test/repos/xiom-lang/registry/attestations/sha256:${DIGEST}`,
  );
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
});

test('discoverAttestation never sends a token it does not have', async () => {
  const calls = [];
  await discoverAttestation({
    repository: 'xiom-lang/registry',
    sha256: DIGEST,
    token: '',
    apiUrl: 'https://api.github.test',
    fetchImpl: async (url, options) => {
      calls.push(options.headers);
      return { ok: true, json: async () => ({ attestations: [] }) };
    },
  });
  assert.equal('Authorization' in calls[0], false);
});

test('discoverAttestation degrades to no attestation on every failure', async () => {
  const digestCases = [
    { name: 'empty list', body: { attestations: [] }, ok: true },
    { name: 'missing field', body: {}, ok: true },
    { name: 'non-numeric id', body: { attestations: [{ id: 'abc' }] }, ok: true },
    { name: 'http error', body: {}, ok: false },
  ];
  for (const testCase of digestCases) {
    const url = await discoverAttestation({
      repository: 'xiom-lang/registry',
      sha256: DIGEST,
      apiUrl: 'https://api.github.test',
      fetchImpl: async () => ({ ok: testCase.ok, json: async () => testCase.body }),
    });
    assert.equal(url, '', testCase.name);
  }

  // Network failures and timeouts read the same way.
  assert.equal(await discoverAttestation({
    repository: 'xiom-lang/registry',
    sha256: DIGEST,
    fetchImpl: async () => { throw new Error('down'); },
  }), '');
  const hang = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  assert.equal(await discoverAttestation({
    repository: 'xiom-lang/registry',
    sha256: DIGEST,
    fetchImpl: hang,
    timeoutMs: 30,
  }), '');

  // Garbage inputs never reach the network.
  let fetched = 0;
  const countFetch = async () => { fetched++; return { ok: true, json: async () => ({}) }; };
  assert.equal(await discoverAttestation({ repository: 'not a repo', sha256: DIGEST, fetchImpl: countFetch }), '');
  assert.equal(await discoverAttestation({ repository: 'owner/repo', sha256: 'nope', fetchImpl: countFetch }), '');
  assert.equal(await discoverAttestation({ repository: '', sha256: '', fetchImpl: countFetch }), '');
  assert.equal(fetched, 0);
});
