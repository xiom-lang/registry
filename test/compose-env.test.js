// XIOM Package Registry -- compose/env parity for operator knobs.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// A variable in .env / .env.staging only reaches the container when the
// service environment: block declares it (compose does not inherit undeclared
// host variables). The first staging capacity test measured the 300/min
// limiter instead of the app for exactly that reason, so the rate-limit
// family is guarded here: every knob the app reads must be declared in
// docker-compose.yml, overridable per staging, and documented in both env
// examples. Add the new var to all four places when the family grows.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const CONFIG = fs.readFileSync(path.join(REPO, 'src', 'config.js'), 'utf-8');
const COMPOSE = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf-8');
const ENV_EXAMPLE = fs.readFileSync(path.join(REPO, '.env.example'), 'utf-8');
const ENV_STAGING = fs.readFileSync(path.join(REPO, '.env.staging.example'), 'utf-8');

// The rate-limit values are read through the env helpers, not as raw
// process.env lookups.
const RATE_LIMIT_ENV = /(?:intFromEnv|boolFromEnv)\('((?:RATE_LIMIT|PUBLISH_RATE|DOWNLOAD_RATE)_[A-Z_]+)'/g;

test('every rate-limit knob is declared in compose and documented in both env examples', () => {
  const names = [...new Set([...CONFIG.matchAll(RATE_LIMIT_ENV)].map((match) => match[1]))].sort();
  assert.deepEqual(names, [
    'DOWNLOAD_RATE_MAX',
    'DOWNLOAD_RATE_WINDOW_MS',
    'PUBLISH_RATE_MAX',
    'PUBLISH_RATE_WINDOW_MS',
    'RATE_LIMIT_DISABLED',
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_WINDOW_MS',
  ], 'update this list, compose, and both env examples together when the family grows');

  for (const name of names) {
    assert.ok(
      COMPOSE.includes(`- ${name}=$\{${name}`),
      `${name} must be declared in the production service environment block`,
    );
    assert.match(
      COMPOSE,
      new RegExp(`XIOM_STAGING_${name}`),
      `${name} must have a staging override so load tests cannot weaken production`,
    );
    assert.match(
      ENV_EXAMPLE,
      new RegExp(`#\\s*${name}=`),
      `${name} must be documented in .env.example`,
    );
    assert.match(
      ENV_STAGING,
      new RegExp(`#\\s*XIOM_STAGING_${name}=`),
      `${name} must be documented in .env.staging.example`,
    );
  }
});
