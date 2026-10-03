// XIOM Package Registry -- admin work assignments (registry 2.12+).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// A tiny assignment layer over the existing queues: one row per assigned
// item (kind + item id), never a second copy of the item itself. The queue
// stores (requests, reports, ownership claims) stay authoritative; this
// table answers "who owns this right now" for the admin inbox. Every
// mutation is audited by the route that calls it.

'use strict';

const WORK_KINDS = Object.freeze(['request', 'report', 'claim']);
const PRIORITIES = Object.freeze(['', 'normal', 'high']);

function toAssignment(row) {
  return {
    kind: row.kind,
    itemId: row.item_id,
    assigneeId: row.assignee_id,
    assigneeLogin: row.assignee_login,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    priority: row.priority,
  };
}

class WorkStore {
  /** @param {{ db: import('./db').Database }} options */
  constructor({ db }) {
    this.db = db;
  }

  /**
   * Create or replace one assignment. An empty assignee is rejected; use
   * `unassign` to clear a row.
   */
  assign(kind, itemId, { assignee, actor, priority = '' } = {}) {
    const k = String(kind || '');
    if (!WORK_KINDS.includes(k)) throw new Error(`unknown work kind "${kind}"`);
    const id = String(itemId || '');
    if (!id) throw new Error('work item id is required');
    if (!assignee || !assignee.githubId) throw new Error('work assignment needs an assignee');
    const pr = PRIORITIES.includes(String(priority)) ? String(priority) : '';
    this.db.run(
      `INSERT INTO work_assignments (kind, item_id, assignee_id, assignee_login, assigned_by, assigned_at, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, item_id) DO UPDATE SET
         assignee_id = excluded.assignee_id,
         assignee_login = excluded.assignee_login,
         assigned_by = excluded.assigned_by,
         assigned_at = excluded.assigned_at,
         priority = excluded.priority`,
      k,
      id,
      String(assignee.githubId),
      String(assignee.login || ''),
      actor ? String(actor.login || '') : '',
      new Date().toISOString(),
      pr,
    );
    return this.get(k, id);
  }

  unassign(kind, itemId) {
    this.db.run(
      'DELETE FROM work_assignments WHERE kind = ? AND item_id = ?',
      String(kind),
      String(itemId),
    );
  }

  get(kind, itemId) {
    const row = this.db.get(
      'SELECT * FROM work_assignments WHERE kind = ? AND item_id = ?',
      String(kind),
      String(itemId),
    );
    return row ? toAssignment(row) : null;
  }

  /** Every assignment as a Map keyed `${kind}\u0000${itemId}`. */
  all() {
    const out = new Map();
    for (const row of this.db.all('SELECT * FROM work_assignments')) {
      out.set(`${row.kind}\u0000${row.item_id}`, toAssignment(row));
    }
    return out;
  }
}

module.exports = { WorkStore, WORK_KINDS };
