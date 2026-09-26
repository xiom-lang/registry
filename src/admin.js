// XIOM Package Registry -- user administration store (registry 2.1).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// Roles and account states live in SQLite so they survive restarts and every
// change carries an audit row. The config allowlists remain the bootstrap:
// an effective admin is `REGISTRY_ADMIN_LOGINS` OR a stored grant, and a
// config-listed admin can never be demoted or suspended from the UI. Nothing
// here can publish: it is identity administration for the web surface only
// (SESSION.md section 20).

'use strict';

const { BadRequestError, ConflictError } = require('./errors');

const ROLE_VALUES = new Set(['reviewer', 'admin']);
const STATUS_VALUES = new Set(['active', 'suspended', 'banned']);

class AdminStore {
  /** @param {{ db: import('./db').Database }} options */
  constructor({ db }) {
    this.db = db;
  }

  /** Stored role grant: '' | 'reviewer' | 'admin'. Config roles are added by the caller. */
  roleOf(githubId) {
    const row = this.db.get('SELECT role FROM user_roles WHERE github_id = ?', String(githubId));
    return row ? row.role : '';
  }

  /** Stored account state; 'active' unless a restriction row exists. */
  statusOf(githubId) {
    const row = this.db.get('SELECT status FROM user_states WHERE github_id = ?', String(githubId));
    return row ? row.status : 'active';
  }

  stateRecord(githubId) {
    return this.db.get(
      'SELECT github_id, login, status, reason, changed_by, changed_at FROM user_states WHERE github_id = ?',
      String(githubId),
    ) || null;
  }

  listRoles() {
    return this.db.all('SELECT github_id, login, role, granted_by, granted_at FROM user_roles ORDER BY granted_at DESC');
  }

  listStates() {
    return this.db.all('SELECT github_id, login, status, reason, changed_by, changed_at FROM user_states ORDER BY changed_at DESC');
  }

  /** Keep the stored login in sync when GitHub logins change. */
  touch({ githubId, login }) {
    this.db.run('UPDATE user_roles SET login = ? WHERE github_id = ?', String(login), String(githubId));
    this.db.run('UPDATE user_states SET login = ? WHERE github_id = ?', String(login), String(githubId));
  }

  /**
   * Grant or revoke a stored role. `role === ''` removes the grant; the
   * config allowlist is never touched. Always audits.
   *
   * @param {{ account: { githubId: string, login: string }, role: string,
   *           actor: { githubId: string, login: string }, note?: string }} input
   */
  setRole({ account, role, actor, note = '' }) {
    const target = String(account.githubId);
    if (role !== '' && !ROLE_VALUES.has(role)) {
      throw new BadRequestError('role must be "reviewer", "admin", or empty', 'invalid_role');
    }
    if (String(actor.githubId) === target && role !== 'admin') {
      throw new ConflictError(
        'you cannot demote yourself; ask another admin to change your role',
        'self_demotion',
      );
    }
    const now = new Date().toISOString();
    if (role === '') {
      this.db.run('DELETE FROM user_roles WHERE github_id = ?', target);
    } else {
      this.db.run(
        `INSERT INTO user_roles (github_id, login, role, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET role = excluded.role,
           login = excluded.login, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
        target, String(account.login), role, String(actor.login), now,
      );
    }
    this.audit({
      actor,
      action: role === '' ? 'role.revoke' : 'role.grant',
      subjectType: 'user',
      subjectId: target,
      subjectLogin: String(account.login),
      detail: role === '' ? (note || 'stored grant removed') : `${role}${note ? ` - ${note}` : ''}`,
    });
    return { role };
  }

  /**
   * Set an account state. 'active' clears the restriction. Always audits.
   *
   * @param {{ account: { githubId: string, login: string }, status: string,
   *           reason?: string, actor: { githubId: string, login: string } }} input
   */
  setStatus({ account, status, reason = '', actor }) {
    const target = String(account.githubId);
    if (!STATUS_VALUES.has(status)) {
      throw new BadRequestError('status must be "active", "suspended", or "banned"', 'invalid_status');
    }
    const cleanReason = String(reason).trim().slice(0, 500);
    if (status !== 'active' && cleanReason === '') {
      throw new BadRequestError('a reason is required when suspending or banning', 'status_reason_required');
    }
    if (String(actor.githubId) === target) {
      throw new ConflictError('you cannot change the state of your own account', 'self_restriction');
    }
    const now = new Date().toISOString();
    if (status === 'active') {
      this.db.run('DELETE FROM user_states WHERE github_id = ?', target);
    } else {
      this.db.run(
        `INSERT INTO user_states (github_id, login, status, reason, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET status = excluded.status, login = excluded.login,
           reason = excluded.reason, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
        target, String(account.login), status, cleanReason, String(actor.login), now,
      );
    }
    this.audit({
      actor,
      action: status === 'active' ? 'user.restore' : `user.${status}`,
      subjectType: 'user',
      subjectId: target,
      subjectLogin: String(account.login),
      detail: cleanReason,
    });
    return { status };
  }

  /** Append an audit row; every console mutation goes through here. */
  audit({ actor, action, subjectType, subjectId, subjectLogin = '', detail = '' }) {
    this.db.run(
      `INSERT INTO admin_audit (at, actor_id, actor_login, action, subject_type, subject_id, subject_login, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      String(actor.githubId), String(actor.login), String(action),
      String(subjectType), String(subjectId), String(subjectLogin), String(detail).slice(0, 1000),
    );
  }

  recentAudit(limit = 50) {
    return this.db.all(
      'SELECT id, at, actor_id, actor_login, action, subject_type, subject_id, subject_login, detail '
      + 'FROM admin_audit ORDER BY id DESC LIMIT ?',
      Math.max(1, Math.min(Number(limit) || 50, 200)),
    );
  }

  auditFor(githubId, limit = 20) {
    return this.db.all(
      'SELECT id, at, actor_id, actor_login, action, subject_type, subject_id, subject_login, detail '
      + 'FROM admin_audit WHERE subject_type = ? AND subject_id = ? ORDER BY id DESC LIMIT ?',
      'user', String(githubId), Math.max(1, Math.min(Number(limit) || 20, 100)),
    );
  }
}

module.exports = { AdminStore, ROLE_VALUES, STATUS_VALUES };
