// XIOM Package Registry -- HTML negotiation.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// The registry serves both an HTTP API (JSON) and a read-only web UI (HTML)
// on the same paths. The rule is deliberately strict: render HTML only when
// the client's FIRST Accept entry is text/html.
//
// Why not req.accepts(['html','json']): with `Accept: */*` or no Accept
// header (curl, fetch, the xiom-pkg client) the accepts library returns the
// first offered type -- it would hand JSON clients HTML. Browsers always put
// text/html first, so this rule serves them the UI and never surprises an
// API consumer.

'use strict';

/** True when the request asks for HTML as its top preference. */
function wantsHtml(req) {
  const accept = req.headers.accept;
  if (typeof accept !== 'string' || accept.trim() === '') return false;
  const first = accept.split(',')[0].trim().toLowerCase();
  return first.startsWith('text/html');
}

module.exports = { wantsHtml };
