// XIOM Package Registry -- HTTP API.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Protocol contract (normative): registry/SESSION.md section 2. The client
// is `crates/xiom-pkg` in the xiom compiler repo; this file exists to serve
// exactly what that client sends and expects.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const semver = require('semver');

const {
  RegistryError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableEntityError,
  RateLimitedError,
} = require('./errors');
const { loadConfig } = require('./config');
const { IndexStore, computeLatest, normalizeDependencies } = require('./index');
const { ArtifactStore } = require('./storage');
const { authenticate, assertPublishScope } = require('./tokens');
const { validatePackageName, isFirstPartyNamespace, assertNamespaceAllowed } = require('./names');
const {
  verify: verifySignature,
  fingerprint,
  isValidSignatureHex,
  isValidPublicKeyHex,
} = require('./signatures');
const { extractManifest } = require('./manifest');
const { wantsHtml } = require('./ui/negotiate');
const {
  homePage,
  searchPage,
  packagePage,
  notFoundPage,
} = require('./ui/pages');

const SERVICE_NAME = 'XIOM Package Registry';
const SERVICE_VERSION = require('../package.json').version;
// Stable identity for deployment checks (see scripts/live-check.js): the
// process start time survives restarts and lets two registries prove they
// are different instances without comparing uptime.
const SERVICE_STARTED_AT = new Date().toISOString();
// Read once: the UI stylesheet is static and small.
const REGISTRY_CSS = fs.readFileSync(path.join(__dirname, 'ui', 'registry.css'), 'utf-8');
// Brand assets shipped with the UI; provenance in src/ui/assets/SOURCES.md.
const UI_ASSETS = {
  faviconIco: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'favicon.ico')),
  faviconPng: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'favicon.png')),
  icon: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'icon.png')),
  logo: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'logo.png')),
};

/**
 * Build the Express application. Exported for tests; `src/server.js` owns
 * the listen call.
 */
function createApp(config = loadConfig()) {
  const app = express();
  const indexStore = new IndexStore(config);
  const artifacts = new ArtifactStore(config);

  fs.mkdirSync(config.uploadTmpDir, { recursive: true });

  /**
   * Rate limiting uses express-rate-limit, the standard Express middleware
   * for this job. The publish and download routes get stricter budgets than
   * the general read surface, and every route carries a limiter explicitly
   * (also what CodeQL's js/missing-rate-limiting query recognizes).
   */
  const disabled = config.rateLimit.disabled;
  const limiterOptions = (bucket) => ({
    windowMs: bucket.windowMs,
    limit: bucket.max,
    standardHeaders: 'draft-7',
    legacyHeaders: true,
    skip: () => disabled,
    handler: (req, res, next) => next(new RateLimitedError(
      `rate limit exceeded: max ${bucket.max} requests per ${Math.round(bucket.windowMs / 1000)}s`,
      Math.max(1, Math.ceil(bucket.windowMs / 1000)),
    )),
  });
  const generalLimit = rateLimit(limiterOptions(config.rateLimit.general));
  const writeLimit = rateLimit(limiterOptions(config.rateLimit.publish));
  const downloadLimit = rateLimit(limiterOptions(config.rateLimit.download));

  if (config.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(cors({ maxAge: 3600 }));
  app.use(express.json({ limit: '12mb' }));

  // Request logging: one line per request, skipped in tests.
  if (config.env !== 'test') {
    app.use((req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        console.log(
          `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`,
        );
      });
      next();
    });
  }

  // ─── Multipart upload handling ────────────────────────────────────────────

  const uploader = multer({
    dest: config.uploadTmpDir,
    limits: {
      fileSize: config.maxTarballBytes,
      files: 1,
      fields: 12,
      fieldSize: 4096,
    },
  }).single('package');

  /**
   * Resolve a staged upload to its canonical location inside UPLOAD_TMP_DIR.
   * multer controls the generated name, but re-deriving the path from
   * path.basename keeps the only path component a caller can influence from
   * ever containing a separator. (CodeQL js/path-injection.)
   */
  function stagedUploadPath(req) {
    if (!req.file || typeof req.file.path !== 'string') return null;
    return path.join(config.uploadTmpDir, path.basename(req.file.path));
  }

  /**
   * Wrap multer so its errors become typed registry errors. Runs only after
   * authentication succeeded (no anonymous byte hits the disk).
   */
  function handleUpload(req, res, next) {
    uploader(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_PART_COUNT') {
          return next(new PayloadTooLargeError(
            `package tarball exceeds the ${config.maxTarballBytes} byte limit`,
          ));
        }
        return next(new BadRequestError(`multipart error: ${err.message}`, 'bad_multipart'));
      }
      return next(err);
    });
  }

  /**
   * Respond with a typed error AFTER draining any unread request body.
   * Without the drain, Node destroys the keep-alive connection when the
   * client is still sending (or waiting to send) bytes, and ureq surfaces
   * ECONNRESET instead of the real 401/413.
   */
  function failRequest(req, res, next, err) {
    const finish = () => next(err);
    if (!req.complete && !req.readableEnded) {
      req.resume();
      req.once('end', finish);
      req.once('error', finish);
      return;
    }
    finish();
  }

  /** Remove a staged upload before forwarding an error to the handler. */
  function cleanupAndNext(req, res, next, err) {
    const staged = stagedUploadPath(req);
    if (staged) {
      try { fs.rmSync(staged, { force: true }); } catch { /* best effort */ }
    }
    failRequest(req, res, next, err);
  }

  // Authentication is a header check, so it runs BEFORE the body is read:
  // unauthenticated or forbidden publishes are rejected without buffering a
  // single byte of payload.
  function authenticated(req, res, next) {
    try {
      req.token = authenticate(req, config.tokens);
      next();
    } catch (err) {
      cleanupAndNext(req, res, next, err);
    }
  }

  // ─── Read routes ──────────────────────────────────────────────────────────
  // Every read route carries the general limiter explicitly; the download
  // route adds the stricter download limiter on top.

  app.get('/', generalLimit, (req, res) => {
    const index = indexStore.snapshot();
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60').send(homePage(index));
    }
    res.json({
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      packages: Object.keys(index.packages).length,
      status: 'operational',
      // Reviewers and scripts read this raw; point them at both surfaces.
      web: index.registry || null,
      docs: 'https://xiom-lang.org/docs/registry',
      protocol: index.version,
    });
  });

  app.get('/health', generalLimit, (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      started_at: SERVICE_STARTED_AT,
      version: SERVICE_VERSION,
    });
  });

  app.get('/index.json', generalLimit, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(indexStore.snapshot());
  });

  // Stylesheet for the read-only UI (module-level constant, no fs per request).
  app.get('/ui/registry.css', generalLimit, (req, res) => {
    res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(REGISTRY_CSS);
  });

  // Brand marks, served from memory (same files the website uses).
  app.get('/favicon.ico', generalLimit, (req, res) => {
    res.type('image/x-icon').set('Cache-Control', 'public, max-age=604800')
      .send(UI_ASSETS.faviconIco);
  });
  app.get('/ui/favicon.png', generalLimit, (req, res) => {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800')
      .send(UI_ASSETS.faviconPng);
  });
  app.get('/ui/icon.png', generalLimit, (req, res) => {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800')
      .send(UI_ASSETS.icon);
  });
  app.get('/ui/logo.png', generalLimit, (req, res) => {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800')
      .send(UI_ASSETS.logo);
  });

  // Package listing: JSON for API consumers, the same list the UI shows.
  app.get('/packages', generalLimit, (req, res) => {
    const index = indexStore.snapshot();
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60').send(homePage(index));
    }
    res.json({
      packages: Object.entries(index.packages).map(([name, pkg]) => ({
        name,
        description: pkg.description,
        latest: pkg.latest,
        versions: Object.keys(pkg.versions).length,
      })),
    });
  });

  app.get('/packages/:name', generalLimit, (req, res) => {
    const name = req.params.name;
    const pkg = indexStore.getPackage(name);
    if (!pkg) {
      if (wantsHtml(req)) {
        return res.status(404).type('html').send(notFoundPage(`Package "${name}" was not found.`));
      }
      throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
    }
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(packagePage(pkg, indexStore.snapshot().registry));
    }
    res.json(pkg);
  });

  app.get('/packages/:name/:version', generalLimit, (req, res) => {
    const { name, version } = req.params;
    if (wantsHtml(req)) {
      const pkg = indexStore.getPackage(name);
      const entry = pkg?.versions?.[version];
      if (!pkg || !entry) {
        return res.status(404).type('html')
          .send(notFoundPage(`Version "${version}" of "${name}" was not found.`));
      }
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(packagePage(pkg, indexStore.snapshot().registry, version));
    }
    res.json(indexStore.requireVersion(name, version));
  });

  // T1: the exact path the client builds (registry.rs install_from_registry),
  // with the legacy `/download` suffix kept as an alias.
  app.get(
    ['/packages/:name/:version/package.tar.gz', '/packages/:name/:version/download'],
    downloadLimit,
    (req, res) => {
      const { name, version } = req.params;
      // Both index and artifact must agree: no serving files the index does
      // not know about.
      indexStore.requireVersion(name, version);
      const file = artifacts.require(name, version);
      const stat = fs.statSync(file);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${name}-${version}.tar.gz"`,
      );
      const stream = fs.createReadStream(file);
      stream.on('error', (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'artifact read failed', code: 'artifact_read_failed' });
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
    },
  );

  app.get('/search', generalLimit, (req, res) => {
    const rawQuery = String(req.query.q || '');
    const query = rawQuery.toLowerCase();
    const index = indexStore.snapshot();
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(searchPage(index, rawQuery));
    }
    const results = [];
    for (const [name, pkg] of Object.entries(index.packages)) {
      if (
        !query
        || name.toLowerCase().includes(query)
        || (pkg.description || '').toLowerCase().includes(query)
      ) {
        results.push({
          name,
          description: pkg.description,
          latest: pkg.latest,
          versions: Object.keys(pkg.versions).length,
          repository: pkg.repository,
        });
      }
    }
    res.json({ query: rawQuery, results });
  });

  // ─── Publish ──────────────────────────────────────────────────────────────

  app.post('/publish', writeLimit, authenticated, handleUpload, (req, res, next) => {
    try {
      const result = publish(req, { config, indexStore, artifacts, token: req.token });
      res.status(201).json({
        ok: true,
        package: result.name,
        version: result.version,
        sha256: result.sha256,
        signature: result.signature || undefined,
        publicKey: result.publicKey || undefined,
        message: `Successfully published ${result.name}@${result.version}`,
      });
    } catch (err) {
      cleanupAndNext(req, res, next, err);
    }
  });

  // ─── Yank ─────────────────────────────────────────────────────────────────

  app.post(
    '/packages/:name/:version/yank',
    writeLimit,
    authenticated,
    express.json({ limit: '64kb' }),
    (req, res, next) => {
      try {
        const { name, version } = req.params;
        assertPublishScope(req.token, name);
        indexStore.yankVersion(name, version, req.body?.reason || '');
        console.log(`Yanked: ${name}@${version} by ${req.token.label}`);
        res.json({
          ok: true,
          package: name,
          version,
          yanked: true,
          latest: indexStore.getPackage(name).latest,
          message: `Yanked ${name}@${version}; pinned installs still work`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── Batch sync (seed/import; not part of the client protocol) ───────────

  app.post(
    '/sync',
    writeLimit,
    authenticated,
    express.json({ limit: '12mb' }),
    (req, res, next) => {
      try {
        const token = req.token;
        const { packages } = req.body || {};
        if (!Array.isArray(packages)) {
          throw new BadRequestError('expected a "packages" array', 'invalid_sync');
        }
        let added = 0;
        let skipped = 0;
        for (const pkg of packages) {
          if (!pkg || typeof pkg !== 'object') { skipped++; continue; }
          let name;
          try {
            name = validatePackageName(String(pkg.name || ''));
          } catch { skipped++; continue; }
          if (isFirstPartyNamespace(name) && !token.firstParty) { skipped++; continue; }
          const version = String(pkg.version || '');
          if (!semver.valid(version)) { skipped++; continue; }
          if (!token.scopes.includes('*')
            && !token.scopes.some((s) => name === s || name.startsWith(`${s}.`))) {
            skipped++;
            continue;
          }
          const existing = indexStore.getPackage(name);
          if (existing?.versions?.[version]) { skipped++; continue; }
          const deps = normalizeDependencies(pkg.dependencies);
          indexStore.publishVersion(name, {
            version,
            sha256: typeof pkg.sha256 === 'string' ? pkg.sha256.toLowerCase() : '',
            signature: typeof pkg.signature === 'string' ? pkg.signature.toLowerCase() : '',
            publicKey: typeof (pkg.publicKey || pkg.publickey) === 'string'
              ? String(pkg.publicKey || pkg.publickey).toLowerCase()
              : '',
            size: Number.isFinite(pkg.size) ? pkg.size : 0,
            published: typeof pkg.published === 'string' ? pkg.published : new Date().toISOString(),
            dependencies: deps,
            description: typeof pkg.description === 'string' ? pkg.description : '',
            repository: typeof pkg.repository === 'string' ? pkg.repository : '',
            ...(typeof pkg.download_url === 'string' ? { download_url: pkg.download_url } : {}),
          });
          added++;
        }
        res.json({
          ok: true,
          added,
          skipped,
          total: Object.keys(indexStore.snapshot().packages).length,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── Errors ───────────────────────────────────────────────────────────────

  // 404 for unknown paths: HTML for browsers, JSON for API consumers. The
  // negotiation rule means a navigation from a browser renders the UI 404
  // while every CLI/protocol request keeps the JSON contract.
  app.use((req, res) => {
    if (wantsHtml(req)) {
      return res.status(404).type('html').send(notFoundPage('This page does not exist.'));
    }
    res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}`, code: 'no_route' });
  });

  // Final error handler: the single place errors become HTTP responses.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof RegistryError) {
      if (err instanceof RateLimitedError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
      }
      if (wantsHtml(req)) {
        return res.status(err.status).type('html').send(notFoundPage(err.message));
      }
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err && err.type === 'entity.too.large') {
      if (wantsHtml(req)) {
        return res.status(413).type('html')
          .send(notFoundPage('That upload is too large for this registry.'));
      }
      return res.status(413).json({ error: 'request body too large', code: 'payload_too_large' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      if (wantsHtml(req)) {
        return res.status(400).type('html').send(notFoundPage('Malformed request body.'));
      }
      return res.status(400).json({ error: 'malformed JSON body', code: 'bad_json' });
    }
    console.error('unhandled error:', err);
    if (wantsHtml(req)) {
      return res.status(500).type('html')
        .send(notFoundPage('Something went wrong handling this request.'));
    }
    return res.status(500).json({ error: 'internal server error', code: 'internal' });
  });

  // Expose for tests / graceful shutdown.
  app.locals.registry = { config, indexStore, artifacts };
  return app;
}

/**
 * The publish pipeline. Steps are ordered cheapest-first so hostile traffic
 * is rejected before any hashing or disk writes.
 *
 * @returns {{ name: string, version: string, sha256: string, signature: string, publicKey: string }}
 */
function publish(req, { config, indexStore, artifacts, token }) {
  // Re-derive the staged path from its basename: the only path component a
  // caller could influence cannot carry a separator. (CodeQL js/path-injection.)
  const staged = req.file && typeof req.file.path === 'string'
    ? path.join(config.uploadTmpDir, path.basename(req.file.path))
    : null;
  const removeUpload = () => {
    if (staged) {
      try { fs.rmSync(staged, { force: true }); } catch { /* best effort */ }
    }
  };

  if (!req.file) {
    throw new BadRequestError(
      'no tarball uploaded: use multipart/form-data with field "package"',
      'missing_file',
    );
  }

  const name = validatePackageName(String(req.body?.name || ''));
  const version = String(req.body?.version || '');
  if (!semver.valid(version)) {
    removeUpload();
    throw new BadRequestError(
      `invalid version "${version}": must be valid semver`,
      'invalid_version',
    );
  }
  assertPublishScope(token, name);
  assertNamespaceAllowed(name, token);

  const index = indexStore.snapshot();
  if (index.packages[name]?.versions?.[version]) {
    removeUpload();
    throw new ConflictError(
      `version ${version} of ${name} already exists; versions are immutable `
      + `(yank it instead: POST /packages/${name}/${version}/yank)`,
      'version_exists',
    );
  }

  const signature = String(req.body?.signature || '').trim().toLowerCase();
  const publicKey = String(req.body?.publicKey || req.body?.publickey || '').trim().toLowerCase();

  // Validity gate: malformed hex must not be stored as if it were a signature.
  if (signature && !isValidSignatureHex(signature)) {
    removeUpload();
    throw new BadRequestError('signature must be 64 bytes of hex (128 characters)', 'invalid_signature');
  }
  if (publicKey && !isValidPublicKeyHex(publicKey)) {
    removeUpload();
    throw new BadRequestError('publicKey must be 32 bytes of hex (64 characters)', 'invalid_public_key');
  }
  if (Boolean(signature) !== Boolean(publicKey)) {
    removeUpload();
    throw new BadRequestError(
      'signature and publicKey must be provided together',
      'incomplete_signature',
    );
  }

  // Compute the digest over the exact uploaded bytes BEFORE moving the file.
  const fileBuffer = fs.readFileSync(staged);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // T4: trusted tokens must present a signature that verifies over the exact
  // tarball bytes. A present-but-tampered signature always fails for any
  // token; a missing signature fails only for trusted tokens.
  if (token.trusted) {
    if (!signature) {
      removeUpload();
      throw new UnprocessableEntityError(
        `token "${token.label}" is trusted and must sign artifacts; `
        + 'no signature/publicKey supplied',
        'signature_required',
      );
    }
    let valid;
    try {
      valid = verifySignature(publicKey, fileBuffer, signature);
    } catch (err) {
      removeUpload();
      throw new BadRequestError(
        `cannot verify signature: ${err.message}`,
        err.code || 'signature_invalid',
      );
    }
    if (!valid) {
      removeUpload();
      throw new UnprocessableEntityError(
        `signature verification failed for ${name}@${version} `
        + `(key fp ${fingerprint(publicKey)})`,
        'signature_invalid',
      );
    }
  }

  // T3: description/repository/dependencies only exist inside package.xi.
  const manifest = extractManifest(staged, config);
  const metadata = {
    version,
    sha256,
    signature,
    publicKey,
    size: fileBuffer.length,
    published: new Date().toISOString(),
    dependencies: manifest.dependencies,
    ...(manifest.description ? { description: manifest.description } : {}),
  };
  if (typeof req.body?.compiler === 'string' && req.body.compiler) {
    metadata.compiler = req.body.compiler.slice(0, 64);
  }

  // Move the artifact into place, then index it. If indexing fails (e.g. a
  // race lost to a concurrent publish), remove the artifact again.
  artifacts.store(name, version, staged);
  try {
    indexStore.publishVersion(name, metadata);
  } catch (err) {
    artifacts.remove(name, version);
    throw err;
  }

  console.log(
    `Published: ${name}@${version} (${(fileBuffer.length / 1024).toFixed(1)} KB, `
    + `sha256:${sha256.slice(0, 12)}..., by ${token.label})`,
  );
  return { name, version, sha256, signature, publicKey };
}

module.exports = { createApp, publish, computeLatest };
