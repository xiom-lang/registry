// XIOM Package Registry -- token / trusted-publisher requests (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The app only stores and displays requests: GitHub-OAuth identified, admin
// approved, and marked fulfilled after the host mints and mails the token
// (SESSION.md section 15). It never reads or writes the token store, never
// generates secrets, and never stores a credential.
//
// A3 phase 3 (SESSION.md 18.2): with the shared platform `db`, records live in
// `stored_requests` (record JSON in `data`, extracted columns for the queue);
// requests.json is imported once into an empty table and kept afterwards as a
// best-effort rollback mirror. SQLite is primary.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { validatePackageName } = require('./names');
const { normalizePublishers, normalizeScope, normalizeWorkflow, isWorkflowFile } = require('./publishers');

const REQUESTS_SCHEMA_VERSION = '1.0.0';
const MAX_REQUESTS_BYTES = 4 * 1024 * 1024;
const MAX_SCOPES = 8;
const MAX_NOTE = 500;
const MAX_PENDING_PER_REQUESTER = 20;
const REQUEST_KINDS = new Set([
  'token',
  'publisher',
  // B4/B5 (SESSION.md 21): owner-facing changes to something already
  // granted. They carry `targetRequestId` -- the approved/fulfilled request
  // they want changed -- and are executed by an admin, never by the owner.
  'publisher-edit',
  'publisher-revoke',
  'token-rotation',
]);
const TARGET_KINDS = new Set(['publisher-edit', 'publisher-revoke', 'token-rotation']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'denied', 'fulfilled']);

function clean(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
    : '';
}

/** Normalized scope list: package names / namespaces, never "*". */
function parseScopeList(raw) {
  const items = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const scopes = [];
  for (const item of items) {
    const scope = normalizeScope(clean(item, 128));
    if (scope === '') continue;
    if (scope === '*') {
      throw new BadRequestError(
        'scope "*" cannot be requested; list package names or namespaces',
        'invalid_scope',
      );
    }
    validatePackageName(scope);
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  if (scopes.length === 0) {
    throw new BadRequestError(
      'at least one package name or namespace is required',
      'invalid_scope',
    );
  }
  if (scopes.length > MAX_SCOPES) {
    throw new BadRequestError(`at most ${MAX_SCOPES} scopes per request`, 'invalid_scope');
  }
  return scopes;
}

function normalizeRequester(requester) {
  const githubId = String(requester && requester.githubId ? requester.githubId : '');
  const login = clean(requester && requester.login, 64);
  if (!/^\d{1,32}$/.test(githubId) || !login) {
    throw new BadRequestError('a signed-in GitHub account is required', 'invalid_requester');
  }
  return { githubId, login };
}

/** Validate a trusted-publisher request with the loader's own rules. */
function normalizePublisherRequest({ repository, workflow, refs, scopes }) {
  const refList = Array.isArray(refs)
    ? refs
    : String(refs || '').split(/[\s,]+/).filter(Boolean);
  const workflowValue = normalizeWorkflow(clean(workflow, 200));
  if (!isWorkflowFile(workflowValue)) {
    throw new BadRequestError(
      'workflow must be a file name like "publish-registry.yml" (the refs go in the refs field)',
      'invalid_workflow',
    );
  }
  try {
    const [entry] = normalizePublishers([{
      label: 'request',
      repository: clean(repository, 200),
      workflow: workflowValue,
      refs: refList.map((ref) => clean(ref, 200)),
      scopes,
    }], 'request');
    return {
      repository: entry.repository,
      workflow: entry.workflow,
      refs: entry.refs,
      scopes: entry.scopes,
    };
  } catch (err) {
    throw new BadRequestError(err.message, 'invalid_publisher_request');
  }
}

/**
 * JSON-file request queue with an audit trail per request. Every transition is
 * appended to the record's `history`; nothing is ever deleted.
 */
class RequestStore {
  /**
   * @param {{ path: string, maxBytes?: number, db?: import('./db').Database|null }} options
   */
  constructor({ path, maxBytes = MAX_REQUESTS_BYTES, db = null }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.db = db;
    this.requests = this.#read();
    if (db) {
      const imported = this.#importRequests();
      this.#loadFromDb();
      if (imported > 0) {
        console.log(`xiom-registry: imported ${imported} requests into SQLite`);
      }
    }
  }

  /** Import requests.json into an empty table (one-time move). */
  #importRequests() {
    const row = this.db.get('SELECT COUNT(*) AS count FROM stored_requests');
    if (row && Number(row.count) > 0) return 0;
    this.db.exec('BEGIN');
    try {
      for (const record of Object.values(this.requests)) this.#insertRecord(record);
      this.db.exec('COMMIT');
      return Object.keys(this.requests).length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`request import failed: ${err.message}`);
    }
  }

  #insertRecord(record) {
    this.db.run(
      `INSERT OR REPLACE INTO stored_requests
         (id, kind, status, requester_id, requester_login, created_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.kind,
      record.status,
      record.requester.githubId,
      record.requester.login,
      record.createdAt,
      JSON.stringify(record),
    );
  }

  /** SQLite is primary: rebuild the in-memory map, re-validating every row. */
  #loadFromDb() {
    this.requests = {};
    for (const row of this.db.all('SELECT * FROM stored_requests ORDER BY created_at, id')) {
      try {
        const record = normalizeRecord(row.id, JSON.parse(row.data));
        if (record) this.requests[row.id] = record;
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
        this.db.run('DELETE FROM stored_requests');
        for (const record of Object.values(this.requests)) this.#insertRecord(record);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`request write failed: ${err.message}`);
      }
    }
    this.#write(this.requests);
  }

  #read() {
    if (!fs.existsSync(this.path)) return {};
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read requests ${this.path}: ${err.message}`);
    }
    if (raw.trim() === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`requests ${this.path} is corrupt JSON: ${err.message}`);
    }
    const source = parsed && typeof parsed === 'object' && parsed.requests && typeof parsed.requests === 'object'
      ? parsed.requests
      : {};
    const requests = {};
    for (const [id, entry] of Object.entries(source)) {
      const record = normalizeRecord(id, entry);
      if (record) requests[id] = record;
    }
    return requests;
  }

  /**
   * Create a pending request.
   *
   * @param {{ kind: string, requester: { githubId: string, login: string },
   *           scopes: string|string[], repository?: string, workflow?: string,
   *           refs?: string|string[], note?: string }} input
   */
  create(input) {
    const kind = String(input.kind || '');
    if (!REQUEST_KINDS.has(kind)) {
      throw new BadRequestError(
        'request kind must be "token", "publisher", "publisher-edit", '
        + '"publisher-revoke", or "token-rotation"',
        'invalid_kind',
      );
    }
    const requester = normalizeRequester(input.requester);
    const scopes = parseScopeList(input.scopes);
    const note = clean(input.note, MAX_NOTE);
    const targetRequestId = clean(input.targetRequestId, 32);
    if (TARGET_KINDS.has(kind) && !/^req_[0-9a-f]{12}$/.test(targetRequestId)) {
      throw new BadRequestError(
        'this request must target an existing request id',
        'invalid_target',
      );
    }
    const details = kind === 'token' || kind === 'token-rotation'
      ? { scopes }
      : normalizePublisherRequest({ ...input, scopes });

    const pending = Object.values(this.requests)
      .filter((entry) => entry.status === 'pending' && entry.requester.githubId === requester.githubId);
    if (pending.length >= MAX_PENDING_PER_REQUESTER) {
      throw new ConflictError(
        `you already have ${pending.length} pending requests; wait for an admin decision`,
        'request_limit',
      );
    }
    if (TARGET_KINDS.has(kind)) {
      const duplicate = pending.find((entry) => entry.targetRequestId === targetRequestId);
      if (duplicate) {
        throw new ConflictError(
          `you already have a pending change for ${targetRequestId} (${duplicate.id}); `
          + 'wait for a decision',
          'duplicate_pending_change',
        );
      }
    }

    const now = new Date().toISOString();
    const id = this.#newId();
    const record = {
      id,
      kind,
      status: 'pending',
      requester,
      ...details,
      ...(TARGET_KINDS.has(kind) ? { targetRequestId } : {}),
      ...(note ? { note } : {}),
      createdAt: now,
      history: [{ at: now, actor: requester.login, action: 'created' }],
    };
    this.requests = { ...this.requests, [id]: record };
    this.#persist();
    return record;
  }

  get(id) {
    const record = this.requests[String(id)];
    if (!record) throw new NotFoundError(`request "${id}" not found`, 'request_not_found');
    return record;
  }

  /** Newest first; optionally filtered by status and/or requester id. */
  list({ status = '', requesterId = '' } = {}) {
    let all = Object.values(this.requests);
    if (status) all = all.filter((entry) => entry.status === status);
    if (requesterId) all = all.filter((entry) => entry.requester.githubId === String(requesterId));
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Approve or deny a pending request. */
  decide(id, { action, actor, note = '' }) {
    const record = this.get(id);
    if (record.status !== 'pending') {
      throw new ConflictError(
        `request ${id} is already ${record.status}`,
        'request_not_pending',
      );
    }
    if (action !== 'approve' && action !== 'deny') {
      throw new BadRequestError('action must be "approve" or "deny"', 'invalid_action');
    }
    const status = action === 'approve' ? 'approved' : 'denied';
    const now = new Date().toISOString();
    const decisionNote = clean(note, MAX_NOTE);
    if (action === 'deny' && !decisionNote) {
      // A denial without a reason is not auditable; ask for one.
      throw new BadRequestError('a reason is required when denying a request', 'deny_reason_required');
    }
    const updated = {
      ...record,
      status,
      decidedAt: now,
      decidedBy: clean(actor, 64),
      history: [...record.history, {
        at: now,
        actor: clean(actor, 64),
        action: status,
        ...(decisionNote ? { note: decisionNote } : {}),
      }],
    };
    this.requests = { ...this.requests, [record.id]: updated };
    this.#persist();
    return updated;
  }

  /** Mark an approved request fulfilled after the host minted/mailed it. */
  fulfil(id, { actor, reference = '' }) {
    const record = this.get(id);
    if (record.status !== 'approved') {
      throw new ConflictError(
        `request ${id} is ${record.status}; only approved requests can be fulfilled`,
        'request_not_approved',
      );
    }
    const now = new Date().toISOString();
    const mintReference = clean(reference, MAX_NOTE);
    if (!mintReference) {
      // The reference is what makes "fulfilled" auditable later.
      throw new BadRequestError('a fulfilment reference is required', 'reference_required');
    }
    const updated = {
      ...record,
      status: 'fulfilled',
      fulfilledAt: now,
      fulfilledBy: clean(actor, 64),
      ...(mintReference ? { mintReference } : {}),
      history: [...record.history, {
        at: now,
        actor: clean(actor, 64),
        action: 'fulfilled',
        ...(mintReference ? { note: mintReference } : {}),
      }],
    };
    this.requests = { ...this.requests, [record.id]: updated };
    this.#persist();
    return updated;
  }

  /** Record that a live trusted-publisher entry was revoked. */
  revoke(id, { actor, note = '' }) {
    const record = this.get(id);
    if (record.kind !== 'publisher') {
      throw new BadRequestError('only trusted-publisher requests can be revoked', 'not_publisher_request');
    }
    const now = new Date().toISOString();
    const revokeNote = clean(note, MAX_NOTE);
    const updated = {
      ...record,
      history: [...record.history, {
        at: now,
        actor: clean(actor, 64),
        action: 'revoked',
        ...(revokeNote ? { note: revokeNote } : {}),
      }],
    };
    this.requests = { ...this.requests, [record.id]: updated };
    this.#persist();
    return updated;
  }

  #newId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `req_${crypto.randomBytes(6).toString('hex')}`;
      const exists = this.db
        ? this.db.get('SELECT id FROM stored_requests WHERE id = ?', id)
        : this.requests[id];
      if (!exists) return id;
    }
    throw new Error('could not allocate a request id');
  }

  #write(next) {
    const serialized = JSON.stringify({
      version: REQUESTS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      requests: next,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`requests file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
  }
}

/** Allowlist-normalize one on-disk record; malformed records are dropped. */
function normalizeRecord(id, entry) {
  if (!/^req_[0-9a-f]{12}$/.test(id) || !entry || typeof entry !== 'object') return null;
  if (!REQUEST_KINDS.has(entry.kind) || !REQUEST_STATUSES.has(entry.status)) return null;
  const requester = entry.requester;
  const githubId = String(requester && requester.githubId ? requester.githubId : '');
  const login = clean(requester && requester.login, 64);
  if (!/^\d{1,32}$/.test(githubId) || !login) return null;
  const scopes = Array.isArray(entry.scopes)
    ? entry.scopes.map((scope) => clean(scope, 128)).filter(Boolean).slice(0, MAX_SCOPES)
    : [];
  if (scopes.length === 0) return null;
  const record = {
    id,
    kind: entry.kind,
    status: entry.status,
    requester: { githubId, login },
    scopes,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    history: Array.isArray(entry.history)
      ? entry.history
        .filter((item) => item && typeof item === 'object' && typeof item.action === 'string')
        .map((item) => ({
          at: clean(item.at, 40),
          actor: clean(item.actor, 64),
          action: clean(item.action, 32),
          ...(clean(item.note, MAX_NOTE) ? { note: clean(item.note, MAX_NOTE) } : {}),
        }))
      : [],
  };
  if (entry.kind.startsWith('publisher')) {
    const repository = clean(entry.repository, 200);
    const workflow = clean(entry.workflow, 200);
    const refs = Array.isArray(entry.refs) ? entry.refs.map((ref) => clean(ref, 200)).filter(Boolean) : [];
    if (!repository || !workflow || refs.length === 0) return null;
    record.repository = repository;
    record.workflow = workflow;
    record.refs = refs;
  }
  if (/^req_[0-9a-f]{12}$/.test(String(entry.targetRequestId || ''))) {
    record.targetRequestId = String(entry.targetRequestId);
  }
  if (clean(entry.note, MAX_NOTE)) record.note = clean(entry.note, MAX_NOTE);
  for (const field of ['decidedAt', 'decidedBy', 'fulfilledAt', 'fulfilledBy', 'mintReference']) {
    if (clean(entry[field], field === 'mintReference' ? MAX_NOTE : 64)) {
      record[field] = clean(entry[field], field === 'mintReference' ? MAX_NOTE : 64);
    }
  }
  return record;
}

module.exports = {
  RequestStore,
  REQUESTS_SCHEMA_VERSION,
  MAX_REQUESTS_BYTES,
  MAX_SCOPES,
  MAX_NOTE,
  MAX_PENDING_PER_REQUESTER,
  parseScopeList,
};
