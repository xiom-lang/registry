// XIOM Package Registry -- typed errors.
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

/**
 * Every failure path in the registry throws (or responds with) a typed error.
 * The HTTP layer is the only place that turns them into status codes, so the
 * semantics in SESSION.md section 2.5 live in exactly one file.
 */
class RegistryError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code stable machine-readable error code
   * @param {string} message human-readable message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.code = code;
  }
}

class BadRequestError extends RegistryError {
  constructor(message, code = 'bad_request') {
    super(400, code, message);
    this.name = 'BadRequestError';
  }
}

class UnauthorizedError extends RegistryError {
  constructor(message = 'missing or unknown token', code = 'unauthorized') {
    super(401, code, message);
    this.name = 'UnauthorizedError';
  }
}

class ForbiddenError extends RegistryError {
  constructor(message, code = 'forbidden') {
    super(403, code, message);
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends RegistryError {
  constructor(message, code = 'not_found') {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

class ConflictError extends RegistryError {
  constructor(message, code = 'version_exists') {
    super(409, code, message);
    this.name = 'ConflictError';
  }
}

class PayloadTooLargeError extends RegistryError {
  constructor(message, code = 'payload_too_large') {
    super(413, code, message);
    this.name = 'PayloadTooLargeError';
  }
}

class UnprocessableEntityError extends RegistryError {
  constructor(message, code = 'signature_invalid') {
    super(422, code, message);
    this.name = 'UnprocessableEntityError';
  }
}

class RateLimitedError extends RegistryError {
  constructor(message = 'too many requests', retryAfterSeconds = 60) {
    super(429, 'rate_limited', message);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class IndexLimitError extends RegistryError {
  constructor(message, code = 'index_limit') {
    super(507, code, message);
    this.name = 'IndexLimitError';
  }
}

module.exports = {
  RegistryError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UnprocessableEntityError,
  RateLimitedError,
  IndexLimitError,
};
