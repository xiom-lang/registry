// XIOM Package Registry -- role capability matrix (registry 2.12+).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// One place that answers "what may this role do". Roles are cumulative:
// member -> reviewer -> supervisor -> admin -> founding admin. `founding`
// is the deployment-config administrator (cannot be demoted or changed from
// the console) and holds every capability. Routes call `hasCapability`
// instead of growing more ad-hoc role checks.

'use strict';

const MATRIX = Object.freeze({
  member: Object.freeze([]),
  reviewer: Object.freeze([
    'review.claim', 'review.flag', 'work.claim',
  ]),
  // Supervisors coordinate: everything a reviewer does, plus assignment of
  // work to any staff member. Decisions, moderation, and user management
  // stay with admins (owner, 2026-10-03).
  supervisor: Object.freeze([
    'review.claim', 'review.flag', 'work.claim', 'work.assign',
  ]),
  admin: Object.freeze([
    'review.claim', 'review.flag', 'work.claim', 'work.assign',
    'request.decide', 'report.resolve', 'package.moderate',
    'publisher.manage', 'user.manage', 'role.grant',
  ]),
  founding: Object.freeze(['*']),
});

const ROLES = Object.freeze(['member', 'reviewer', 'supervisor', 'admin', 'founding']);

function capabilitiesFor(role) {
  return new Set(MATRIX[role] || MATRIX.member);
}

function hasCapability(role, capability) {
  const set = capabilitiesFor(role);
  return set.has('*') || set.has(String(capability));
}

module.exports = { capabilitiesFor, hasCapability, ROLES };
