// XIOM Package Registry -- email delivery for the notification outbox.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// SESSION.md section 18: email is a pluggable sender on top of the outbox.
// With no SMTP_URL configured the registry runs in-app-notifications-only
// mode (nothing is silently sent, rows stay 'skipped'). Credentials live in
// the environment; the app still never mints or mails publish tokens.

'use strict';

const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * @param {{ smtpUrl?: string, from?: string, log?: Console }} options
 */
function createMailer({ smtpUrl = '', from = '', log = console } = {}) {
  if (!smtpUrl || !from) {
    return {
      enabled: false,
      async send() {
        return { status: 'skipped' };
      },
    };
  }
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    enabled: true,
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
      return { status: 'sent' };
    },
  };
}

/** Drain pending outbox emails on a timer (and on demand after events). */
function startOutbox({ notifications, mailer, intervalMs = DEFAULT_INTERVAL_MS, log = console }) {
  let draining = false;

  async function drain() {
    if (draining || !mailer.enabled) return 0;
    draining = true;
    let sent = 0;
    try {
      for (const row of notifications.pendingEmails()) {
        try {
          const text = [row.body, row.link].filter(Boolean).join('\n\n');
          await mailer.send({ to: row.email, subject: row.subject || 'XIOM registry notice', text });
          notifications.markEmail(row.id, 'sent');
          sent += 1;
        } catch (err) {
          log.warn(`notification email ${row.id} failed: ${err.message}`);
          notifications.markEmail(row.id, 'failed');
        }
      }
    } finally {
      draining = false;
    }
    return sent;
  }

  const timer = setInterval(() => {
    drain().catch((err) => log.warn(`outbox drain failed: ${err.message}`));
  }, intervalMs);
  timer.unref?.();

  return {
    drain,
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { createMailer, startOutbox, DEFAULT_INTERVAL_MS };
