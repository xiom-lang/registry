// XIOM Package Registry -- app-managed trusted-publisher entries.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Registry 2.0: when an admin approves a trusted-publisher request, the app
// writes the entry here and activates it immediately -- no host editing and
// no restart. The read-only TRUSTED_PUBLISHERS_FILE stays the operator's
// channel for first-party grants; this store is the community channel and
// carries request provenance (who approved what, when) for the audit.
//
// A3 phase 3 (SESSION.md 18.2): with the shared platform `db`, entries live in
// `stored_publishers`; publishers.json is imported once into an empty table
// and kept afterwards as a best-effort rollback mirror. SQLite is primary.

'use strict';

const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { normalizePublishers } = require('./publishers');

const PUBLISHERS_SCHEMA_VERSION = '1.0.0';
const MAX_PUBLISHERS_BYTES = 1024 * 1024;

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

class PublisherStore {
  /**
   * @param {{ path: string, maxBytes?: number, db?: import('./db').Database|null }} options
   */
  constructor({ path, maxBytes = MAX_PUBLISHERS_BYTES, db = null }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.db = db;
    this.entries = this.#read();
    if (db) {
      const imported = this.#importEntries();
      this.#loadFromDb();
      if (imported > 0) {
        console.log(`xiom-registry: imported ${imported} trusted-publisher entries into SQLite`);
      }
    }
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

  /** Import publishers.json into an empty table (one-time move). */
  #importEntries() {
    const row = this.db.get('SELECT COUNT(*) AS count FROM stored_publishers');
    if (row && Number(row.count) > 0) return 0;
    this.db.exec('BEGIN');
    try {
      for (const entry of this.entries) this.#insertEntry(entry);
      this.db.exec('COMMIT');
      return this.entries.length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`publisher import failed: ${err.message}`);
    }
  }

  #insertEntry(entry) {
    this.db.run(
      `INSERT OR REPLACE INTO stored_publishers
         (request_id, label, repository, workflow, refs, scopes, first_party, events, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.requestId,
      entry.label,
      entry.repository,
      entry.workflow,
      JSON.stringify(entry.refs || []),
      JSON.stringify(entry.scopes || []),
      entry.firstParty ? 1 : 0,
      JSON.stringify(entry.events || []),
      entry.approvedBy || '',
      entry.approvedAt || '',
    );
  }

  /** SQLite is primary: rebuild the in-memory set from the stored rows. */
  #loadFromDb() {
    this.entries = [];
    for (const row of this.db.all('SELECT * FROM stored_publishers ORDER BY request_id')) {
      const entry = {
        label: row.label,
        repository: row.repository,
        workflow: row.workflow,
        refs: parseJsonArray(row.refs),
        scopes: parseJsonArray(row.scopes),
        firstParty: row.first_party === 1,
        events: parseJsonArray(row.events),
        requestId: row.request_id,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
      };
      try {
        const [normalized] = normalizePublishers([entry], 'publishers state');
        this.entries.push({
          ...normalized,
          requestId: entry.requestId,
          approvedBy: entry.approvedBy,
          approvedAt: entry.approvedAt,
        });
      } catch {
        // A malformed row is dropped rather than refusing to boot.
      }
    }
  }

  /** Persist the current set: SQLite when present, then the JSON mirror. */
  #persist() {
    if (this.db) {
      this.db.exec('BEGIN');
      try {
        this.db.run('DELETE FROM stored_publishers');
        for (const entry of this.entries) this.#insertEntry(entry);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`publisher write failed: ${err.message}`);
      }
    }
    this.#write(this.entries);
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
    this.entries = [...this.entries, entry];
    this.#persist();
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
    this.entries = this.entries.filter((item) => item.requestId !== requestId);
    this.#persist();
    return entry;
  }

  #write(next) {
    const serialized = JSON.stringify({
      version: PUBLISHERS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      entries: next.map((entry) => serializable(entry)),
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`publishers state would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
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
