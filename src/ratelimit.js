// XIOM Package Registry -- in-memory sliding-window rate limiter.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const { RateLimitedError } = require('./errors');

/**
 * Sliding-window limiter keyed by an arbitrary string (IP, token label, or
 * both). Bounded: at most `maxKeys` tracked windows; least-recently-used
 * entries are evicted so a hostile client cannot grow memory without bound.
 */
class SlidingWindowLimiter {
  /**
   * @param {{ windowMs: number, max: number }} options
   * @param {number} [maxKeys]
   */
  constructor({ windowMs, max }, maxKeys = 10000) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /**
   * Record a hit; throws RateLimitedError when the window is exhausted.
   * @param {string} key
   */
  check(key) {
    if (this.max <= 0) return;
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.hits.get(key);
    if (!timestamps) {
      timestamps = [];
    }
    // Drop expired hits (array is chronological).
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) firstValid++;
    if (firstValid > 0) timestamps = timestamps.slice(firstValid);

    if (timestamps.length >= this.max) {
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.hits.set(key, timestamps);
      throw new RateLimitedError(
        `rate limit exceeded: max ${this.max} requests per ${Math.round(this.windowMs / 1000)}s`,
        retryAfterSeconds,
      );
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    if (this.hits.size > this.maxKeys) {
      // Evict the oldest inserted key (Map preserves insertion order).
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) this.hits.delete(oldestKey);
    }
  }

  /** Number of tracked keys (tests, metrics). */
  size() {
    return this.hits.size;
  }
}

/**
 * Simple keyed limiter that counts requests per key without a window
 * (used for absolute publish counters per token, e.g. abuse caps).
 */
class Counter {
  constructor(max = Infinity) {
    this.max = max;
    this.counts = new Map();
  }

  check(key) {
    const next = (this.counts.get(key) || 0) + 1;
    if (next > this.max) {
      throw new RateLimitedError(`limit exceeded: max ${this.max} total`);
    }
    this.counts.set(key, next);
  }
}

/** Express middleware factory. Key = client IP + optional token label. */
function rateLimitMiddleware(limiter) {
  return (req, res, next) => {
    if (!limiter || limiter.max <= 0) return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const tokenLabel = req.token ? req.token.label : 'anonymous';
    try {
      limiter.check(`${ip}\u0000${tokenLabel}`);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { SlidingWindowLimiter, Counter, rateLimitMiddleware };
