// XIOM Package Registry -- activity assembly (A5, SESSION.md 21).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Activity is derived at render time from data that is already public:
// published versions (the index itself), ratings, maintainer replies, the
// reviewer decision history, and verified maintainer claims. Nothing is
// stored twice, muted packages never reach it (callers pass the public
// index), and the feed is capped per package and per merge so a burst of
// events cannot turn a page into a log dump.

'use strict';

/** Per-package cap for the package page and each watched package. */
const ACTIVITY_PER_PACKAGE = 12;
/** Merge cap for the signed-in account feed. */
const ACTIVITY_FEED_LIMIT = 50;

const ACTIVITY_TYPES = Object.freeze(['release', 'review', 'reply', 'decision', 'claim']);

function newerFirst(events) {
  return events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Every published (and yanked) version of a package, from the index. */
function releaseEvents(name, pkg) {
  const versions = (pkg && pkg.versions) || {};
  return Object.entries(versions).map(([version, entry]) => ({
    type: 'release',
    package: name,
    version,
    at: entry.published || '',
    yanked: entry.yanked === true,
    repository: entry.publisher && entry.publisher.repository ? entry.publisher.repository : '',
  }));
}

/**
 * The public activity trail of one package, newest first.
 *
 * @param {{ name: string, pkg: object, reviews: object, ownership: object,
 *           limit?: number }} input
 * @returns {object[]}
 */
function packageActivity({
  name,
  pkg,
  reviews,
  ownership = null,
  limit = ACTIVITY_PER_PACKAGE,
}) {
  const events = releaseEvents(name, pkg);
  for (const rating of reviews.ratingsFor(name)) {
    events.push({
      type: 'review',
      package: name,
      at: rating.at || '',
      stars: rating.stars,
      login: rating.login,
      review: rating.review || '',
    });
  }
  for (const reply of reviews.repliesByPackage(name)) {
    events.push({
      type: 'reply',
      package: name,
      at: reply.at || '',
      login: reply.author.login,
      body: reply.body,
    });
  }
  const decision = reviews.decision(name);
  for (const item of (decision && decision.history) || []) {
    events.push({
      type: 'decision',
      package: name,
      at: item.at || '',
      action: item.action,
      actor: item.actor || '',
      note: item.note || '',
    });
  }
  for (const claim of (ownership && ownership.listClaims()) || []) {
    if (!claim || claim.package !== name || claim.status !== 'verified') continue;
    events.push({
      type: 'claim',
      package: name,
      at: claim.decidedAt || claim.claimedAt || '',
      login: claim.login,
    });
  }
  return newerFirst(events.filter((event) => event.at)).slice(0, Math.max(1, limit));
}

/**
 * Merge the activity of several packages into one feed, newest first.
 *
 * @param {{ packages: string[], index: object, reviews: object,
 *           ownership?: object, limit?: number }} input
 */
function watchedFeed({
  packages,
  index,
  reviews,
  ownership = null,
  limit = ACTIVITY_FEED_LIMIT,
}) {
  const merged = [];
  for (const name of packages) {
    const pkg = index.packages[name];
    if (!pkg) continue;
    merged.push(...packageActivity({
      name,
      pkg,
      reviews,
      ownership,
      limit: ACTIVITY_PER_PACKAGE,
    }));
  }
  return newerFirst(merged).slice(0, Math.max(1, limit));
}

module.exports = {
  packageActivity,
  watchedFeed,
  releaseEvents,
  ACTIVITY_PER_PACKAGE,
  ACTIVITY_FEED_LIMIT,
  ACTIVITY_TYPES,
};
