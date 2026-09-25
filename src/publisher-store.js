// XIOM Package Registry -- app-managed trusted-publisher entries.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Registry 2.0: when an admin approves a trusted-publisher request, the app
// writes the entry here and activates it immediately -- no host editing and
// no restart. The read-only TRUSTED_PUBLISHERS_FILE stays the operator's
// channel for first-party grants; this store is the community channel and
// carries request provenance (who approved what, when) for the audit.

'use strict';

const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { normalizePublishers } = require('./publishers');

const PUBLISHERS_SCHEMA_VERSION = '1.0.0';
const MAX_PUBLISHERS_BYTES = 1024 * 1024;

class PublisherStore {
  /**
   * @param {{ path: string, maxBytes?: number }} options
   */
  constructor({ path, maxBytes = MAX_PUBLISHERS_BYTES }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.entries = this.#read();
  }

  #read() {
    if (!fs.existsSync(this.path)) return [];
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read publishers state ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`publishers state ${this.path} is corrupt JSON: ${err.message}`);
    }
    const source = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    const entries = [];
    for (const entry of source) {
      try {
        const [normalized] = normalizePublishers([entry], 'publishers state');
        entries.push({
          ...normalized,
          requestId: typeof entry.requestId === 'string' ? entry.requestId : '',
          approvedBy: typeof entry.approvedBy === 'string' ? entry.approvedBy : '',
          approvedAt: typeof entry.approvedAt === 'string' ? entry.approvedAt : '',
        });
      } catch {
        // Malformed stored entry: drop it rather than refusing to boot.
      }
    }
    return entries;
  }

  /** Entries ready for `config.publishers` (normalized, with matchers). */
  list() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  find(requestId) {
    return this.entries.find((entry) => entry.requestId === requestId) || null;
  }

  /**
   * Activate a trusted-publisher entry for an approved request.
   *
   * @param {{ requestId: string, repository: string, workflow: string,
   *           refs: string[], scopes: string[], approvedBy: string }} input
   */
  add(input) {
    const raw = {
      label: `request-${input.requestId}`,
      repository: input.repository,
      workflow: input.workflow,
      refs: input.refs,
      scopes: input.scopes,
      // Community requests are never first-party: the operator grants that
      // through the read-only file, never through the request queue.
      firstParty: false,
      requestId: input.requestId,
      approvedBy: input.approvedBy,
      approvedAt: new Date().toISOString(),
    };
    const [normalized] = normalizePublishers([raw], 'publisher approval');
    if (this.find(input.requestId)) {
      throw new ConflictError(
        `request ${input.requestId} already has a live publisher entry`,
        'publisher_exists',
      );
    }
    const clash = this.entries.find((entry) => entry.repository === normalized.repository
      && entry.workflow === normalized.workflow);
    if (clash) {
      throw new ConflictError(
        `"${normalized.repository}" + "${normalized.workflow}" is already configured `
        + `(${clash.label}); revoke it first`,
        'publisher_conflict',
      );
    }
    const entry = {
      ...normalized,
      requestId: raw.requestId,
      approvedBy: raw.approvedBy,
      approvedAt: raw.approvedAt,
    };
    this.#commit([...this.entries, entry]);
    return entry;
  }

  /** Deactivate the entry created for a request. */
  remove(requestId) {
    const entry = this.find(requestId);
    if (!entry) {
      throw new NotFoundError(
        `no live publisher entry for request ${requestId}`,
        'publisher_not_found',
      );
    }
    this.#commit(this.entries.filter((item) => item.requestId !== requestId));
    return entry;
  }

  #commit(next) {
    const serialized = JSON.stringify({
      version: PUBLISHERS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      entries: next.map((entry) => serializable(entry)),
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`publishers state would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.entries = next;
  }
}

/** Only the durable fields; regexp matchers are rebuilt on load. */
function serializable(entry) {
  return {
    label: entry.label,
    repository: entry.repository,
    workflow: entry.workflow,
    refs: entry.refs,
    scopes: entry.scopes,
    firstParty: entry.firstParty,
    events: entry.events,
    requestId: entry.requestId,
    approvedBy: entry.approvedBy,
    approvedAt: entry.approvedAt,
  };
}

module.exports = {
  PublisherStore,
  PUBLISHERS_SCHEMA_VERSION,
  MAX_PUBLISHERS_BYTES,
};
