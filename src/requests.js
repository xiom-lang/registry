// XIOM Package Registry -- token / trusted-publisher requests (registry 2.0).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The app only stores and displays requests: GitHub-OAuth identified, admin
// approved, and marked fulfilled after the host mints and mails the token
// (SESSION.md section 15). It never reads or writes the token store, never
// generates secrets, and never stores a credential.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { BadRequestError, ConflictError, NotFoundError } = require('./errors');
const { atomicWriteFile } = require('./index');
const { validatePackageName } = require('./names');
const { normalizePublishers, normalizeScope } = require('./publishers');

const REQUESTS_SCHEMA_VERSION = '1.0.0';
const MAX_REQUESTS_BYTES = 4 * 1024 * 1024;
const MAX_SCOPES = 8;
const MAX_NOTE = 500;
const MAX_PENDING_PER_REQUESTER = 20;
const REQUEST_KINDS = new Set(['token', 'publisher']);
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
  try {
    const [entry] = normalizePublishers([{
      label: 'request',
      repository: clean(repository, 200),
      workflow: clean(workflow, 200),
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
   * @param {{ path: string, maxBytes?: number }} options
   */
  constructor({ path, maxBytes = MAX_REQUESTS_BYTES }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.requests = this.#read();
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
      throw new BadRequestError('request kind must be "token" or "publisher"', 'invalid_kind');
    }
    const requester = normalizeRequester(input.requester);
    const scopes = parseScopeList(input.scopes);
    const note = clean(input.note, MAX_NOTE);
    const details = kind === 'token'
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

    const now = new Date().toISOString();
    const id = this.#newId();
    const record = {
      id,
      kind,
      status: 'pending',
      requester,
      ...details,
      ...(note ? { note } : {}),
      createdAt: now,
      history: [{ at: now, actor: requester.login, action: 'created' }],
    };
    this.#commit({ ...this.requests, [id]: record });
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
    this.#commit({ ...this.requests, [record.id]: updated });
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
    this.#commit({ ...this.requests, [record.id]: updated });
    return updated;
  }

  #newId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `req_${crypto.randomBytes(6).toString('hex')}`;
      if (!this.requests[id]) return id;
    }
    throw new Error('could not allocate a request id');
  }

  #commit(next) {
    const serialized = JSON.stringify({
      version: REQUESTS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      requests: next,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxBytes) {
      throw new Error(`requests file would exceed ${this.maxBytes} bytes`);
    }
    atomicWriteFile(this.path, serialized);
    this.requests = next;
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
  if (entry.kind === 'publisher') {
    const repository = clean(entry.repository, 200);
    const workflow = clean(entry.workflow, 200);
    const refs = Array.isArray(entry.refs) ? entry.refs.map((ref) => clean(ref, 200)).filter(Boolean) : [];
    if (!repository || !workflow || refs.length === 0) return null;
    record.repository = repository;
    record.workflow = workflow;
    record.refs = refs;
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
