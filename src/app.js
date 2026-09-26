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
  UnauthorizedError,
  ForbiddenError,
  UnprocessableEntityError,
  RateLimitedError,
} = require('./errors');
const { loadConfig, loadTokens } = require('./config');
const { IndexStore, computeLatest, normalizeDependencies } = require('./index');
const { ArtifactStore } = require('./storage');
const { authenticate, assertPublishScope, safeEqual } = require('./tokens');
const { createJwksCache } = require('./oidc');
const { validatePackageName, isFirstPartyNamespace, assertNamespaceAllowed } = require('./names');
const oauth = require('./oauth');
const { SessionStore, parseCookies, serializeCookie, SESSION_COOKIE, DEFAULT_TTL_MS } = require('./sessions');
const { AccountStore } = require('./accounts');
const { RequestStore } = require('./requests');
const { ReviewStore } = require('./reviews');
const { PublisherStore } = require('./publisher-store');
const { Database } = require('./db');
const { NotificationStore } = require('./notifications');
const { createMailer, startOutbox } = require('./mailer');
const {
  verify: verifySignature,
  fingerprint,
  isValidSignatureHex,
  isValidPublicKeyHex,
} = require('./signatures');
const { extractManifest } = require('./manifest');
const { extractReadme } = require('./readme');
const { normalizePackageMetadata, categoryCounts, CATEGORIES, STAGES } = require('./categories');
const { wantsHtml } = require('./ui/negotiate');
const { escapeHtml } = require('./ui/layout');
const {
  homePage,
  packagesPage,
  searchPage,
  searchPackages,
  categoriesPage,
  packagePage,
  whatsNewPage,
  notFoundPage,
  paginatePackages,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
} = require('./ui/pages');
const {
  loginPage,
  accountOverviewPage,
  accountRequestsPage,
  accountNotificationsPage,
  accountSettingsPage,
} = require('./ui/account');
const {
  adminDashboardPage,
  adminRequestsPage,
  adminPackagesPage,
  adminReportsPage,
  adminUsersPage,
  adminUserPage,
  adminAuditPage,
} = require('./ui/admin');
const { AdminStore } = require('./admin');
const { reviewPage } = require('./ui/review');
const { renderMarkdown } = require('./ui/markdown');

const SERVICE_NAME = 'XIOM Package Registry';
const SERVICE_VERSION = require('../package.json').version;
// Stable identity for deployment checks (see scripts/live-check.js): the
// process start time survives restarts and lets two registries prove they
// are different instances without comparing uptime.
const SERVICE_STARTED_AT = new Date().toISOString();
// Read once: the UI stylesheet is static and small.
const REGISTRY_CSS = fs.readFileSync(path.join(__dirname, 'ui', 'registry.css'), 'utf-8');
// Community OIDC publish workflow, served so a beginner can copy it straight
// into .github/workflows/publish-registry.yml (registry 2.0 request flow).
const COMMUNITY_PUBLISH_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'ui', 'templates', 'community-publish.yml'),
  'utf-8',
);
// Release notes rendered at /whats-new (same escape-first markdown pipeline).
const CHANGELOG_MD = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8');
// Package status badge art: state x track matrix (see src/ui/pages.js).
// `trusted` exists only on the community track -- first-party/official
// publishes are org-controlled by definition. Keep this in sync with the
// states the UI can select.
const BADGE_TRACK_STATES = {
  official: ['flagged', 'yanked', 'deprecated', 'incubator', 'prerelease', 'verified', 'unsigned'],
  community: ['flagged', 'yanked', 'deprecated', 'incubator', 'prerelease', 'trusted', 'verified', 'unsigned'],
};
const BADGE_ASSETS = {};
for (const [track, states] of Object.entries(BADGE_TRACK_STATES)) {
  for (const state of states) {
    const file = `pgk_${state}_${track}.webp`;
    BADGE_ASSETS[file] = fs.readFileSync(path.join(__dirname, 'ui', 'assets', file));
  }
}

// Brand assets shipped with the UI; provenance in src/ui/assets/SOURCES.md.
const UI_ASSETS = {
  faviconIco: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'favicon.ico')),
  faviconPng: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'favicon.png')),
  icon: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'icon.png')),
  bannerRegistry: fs.readFileSync(path.join(__dirname, 'ui', 'assets', 'registry.webp')),
  badges: BADGE_ASSETS,
};

/**
 * Clamp `?page` / `?per_page` and read the listing facets (sort, category,
 * first_party, signed). Garbage and out-of-range values fall back to the
 * defaults instead of erroring: the listing is a browsing affordance, not a
 * protocol contract (SESSION.md section 13).
 */
function listingFromQuery(query) {
  const clamp = (value, fallback, max) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
  };
  const flag = (value) => value === '1' || value === 'true';
  return {
    page: clamp(query.page, 1, 1_000_000),
    perPage: clamp(query.per_page, DEFAULT_PER_PAGE, MAX_PER_PAGE),
    sort: query.sort === 'name' ? 'name' : 'updated',
    category: typeof query.category === 'string' ? query.category.trim().toLowerCase() : '',
    firstParty: flag(query.first_party),
    signed: flag(query.signed),
  };
}

/**
 * Build the Express application. Exported for tests; `src/server.js` owns
 * the listen call.
 */
function createApp(config = loadConfig()) {
  const app = express();
  const indexStore = new IndexStore(config);
  const artifacts = new ArtifactStore(config);
  // Registry 2.0: sign-in sessions, GitHub identities, and the request queue.
  // Sessions and the queue are display/audit data only; none of it can
  // publish (see SESSION.md section 15).
  const sessions = config.oauth.enabled
    ? new SessionStore({ key: oauth.deriveSessionKey(config.oauth.clientSecret) })
    : null;
  const accounts = new AccountStore({ path: config.accountsPath, maxBytes: config.maxAccountsBytes });
  const requests = new RequestStore({ path: config.requestsPath, maxBytes: config.maxRequestsBytes });
  const reviews = new ReviewStore({ path: config.reviewsPath, maxBytes: config.maxReviewsBytes });
  const publisherStore = new PublisherStore({
    path: config.storedPublishersPath,
    maxBytes: config.maxPublishersBytes,
  });
  // Approved trusted-publisher requests activate from boot; the read-only
  // operator file wins if the same repository+workflow is granted there.
  const filePublisherKeys = new Set(
    config.publishers.map((entry) => `${entry.repository}\u0000${entry.workflow}`),
  );
  const storedPublishers = publisherStore.list()
    .filter((entry) => !filePublisherKeys.has(`${entry.repository}\u0000${entry.workflow}`));
  if (storedPublishers.length > 0) {
    config.publishers = [...config.publishers, ...storedPublishers];
  }
  // SQLite platform layer: notification outbox + optional email sender
  // (SESSION.md section 18). In-app notices always work; email needs SMTP_URL.
  const db = new Database({ path: config.dbPath });
  const notifications = new NotificationStore({ db });
  // User administration (roles, suspension, audit) shares the platform
  // database. Config allowlists stay the bootstrap; stored grants add to them
  // and can never subtract (SESSION.md section 20).
  const admin = new AdminStore({ db });
  const configAdminLogins = new Set(config.oauth.adminLogins.map((login) => String(login).toLowerCase()));
  const configReviewerLogins = new Set(config.oauth.reviewerLogins.map((login) => String(login).toLowerCase()));
  const mailer = createMailer({ smtpUrl: config.smtpUrl, from: config.smtpFrom });
  const outbox = startOutbox({ notifications, mailer });

  // Token-file hot reload: the fulfiller worker mints into the mounted file
  // and the next publish sees it -- no force-recreate. Failures keep the
  // previous token set so a half-written file can never lock everyone out.
  if (config.tokensFile) {
    const watcher = fs.watchFile(config.tokensFile, { interval: 2000 }, () => {
      try {
        config.tokens = loadTokens();
        console.log(`tokens reloaded from ${config.tokensFile}: ${config.tokens.size}`);
      } catch (err) {
        console.error(`token reload failed (keeping previous tokens): ${err.message}`);
      }
    });
    watcher.unref?.();
  }
  const registryBaseUrl = config.registryUrl.replace(/\/+$/, '');
  const callbackUri = `${registryBaseUrl}${oauth.CALLBACK_PATH}`;
  const secureCookies = registryBaseUrl.startsWith('https://') || config.env === 'production';
  const sessionMaxAgeSeconds = Math.floor(DEFAULT_TTL_MS / 1000);
  const oauthStateMaxAgeMs = 10 * 60 * 1000;

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

  // ─── Registry 2.0 sessions (identity only; never a publish credential) ────

  // Resolve the signed session cookie once per request. A forged or expired
  // cookie simply leaves req.session null.
  app.use((req, _res, next) => {
    req.sessionId = null;
    req.session = null;
    if (sessions) {
      const cookies = parseCookies(req.headers.cookie);
      const value = cookies.get(SESSION_COOKIE);
      const found = value ? sessions.fromCookie(value) : null;
      if (found) {
        const sessionAccount = found.session.account;
        // A ban takes effect on the next request: the session is dropped
        // before any handler can see it.
        if (sessionAccount && admin.statusOf(sessionAccount.githubId) === 'banned') {
          sessions.destroy(found.id);
        } else {
          req.sessionId = found.id;
          req.session = found.session;
        }
      }
    }
    next();
  });

  const accountOf = (req) => (req.session && req.session.account) || null;
  const isConfigAdmin = (account) => Boolean(account)
    && configAdminLogins.has(String(account.login).toLowerCase());
  const isConfigReviewer = (account) => Boolean(account)
    && configReviewerLogins.has(String(account.login).toLowerCase());
  const isAdmin = (account) => Boolean(account)
    && (isConfigAdmin(account) || admin.roleOf(account.githubId) === 'admin');
  const isReviewer = (account) => Boolean(account)
    && (isAdmin(account) || isConfigReviewer(account) || admin.roleOf(account.githubId) === 'reviewer');
  const accountStatus = (account) => (account ? admin.statusOf(account.githubId) : 'active');

  /** Suspended accounts keep browsing but cannot create content. */
  function requireWriteAccess(req, _res, next) {
    const sessionAccount = accountOf(req);
    if (sessionAccount && accountStatus(sessionAccount) !== 'active') {
      return next(new ForbiddenError(
        'this account is suspended; requests, reports, and ratings are disabled',
        'account_suspended',
      ));
    }
    next();
  }

  /**
   * Sign-in state for the nav bar. Returns `{ primary, menu }`: the primary
   * action stays visible on phones, while role links (Review/Admin) render in
   * the mobile menu so they are never pushed off-screen. `''` when the
   * feature is off.
   */
  function accountNav(req) {
    if (!config.oauth.enabled) return { primary: '', menu: '' };
    const account = accountOf(req);
    if (!account) {
      // No self-link on the sign-in page: it reloads the same page and reads
      // as a dead control.
      if (req.path === '/login') return { primary: '', menu: '' };
      return {
        primary: '<a class="nav-account nav-button nav-button-primary" href="/login">Sign in</a>',
        menu: '',
      };
    }
    const menu = [
      isReviewer(account)
        ? `<a href="/review"${req.path.startsWith('/review') ? ' aria-current="page"' : ''}>Review queue</a>`
        : '',
      isAdmin(account)
        ? `<a href="/admin"${req.path.startsWith('/admin') ? ' aria-current="page"' : ''}>Admin console</a>`
        : '',
    ].filter(Boolean).join('\n        ');
    const current = req.path === '/account' || req.path.startsWith('/account/')
      ? ' aria-current="page"'
      : '';
    return {
      primary: `<a class="nav-account" href="/account"${current}>@${escapeHtml(account.login)}</a>`,
      menu,
    };
  }

  function setSessionCookie(res, id) {
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, sessions.cookieValue(id), {
      maxAgeSeconds: sessionMaxAgeSeconds,
      secure: secureCookies,
    }));
  }

  function clearSessionCookie(res) {
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
      maxAgeSeconds: 0,
      secure: secureCookies,
    }));
  }

  /** Only same-site paths are valid return targets (no open redirects). */
  function safeReturnTo(value) {
    if (typeof value !== 'string' || value.length > 300) return '/account';
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/account';
    if (/[\u0000-\u001f]/.test(value)) return '/account';
    return value;
  }

  function requireLogin(req, _res, next) {
    if (!accountOf(req)) {
      return next(new UnauthorizedError('sign in to continue', 'login_required'));
    }
    next();
  }

  function requireAdmin(req, _res, next) {
    const account = accountOf(req);
    if (!account) {
      return next(new UnauthorizedError('sign in to continue', 'login_required'));
    }
    if (!isAdmin(account)) {
      return next(new ForbiddenError('registry admin required', 'admin_required'));
    }
    next();
  }

  function requireReviewer(req, _res, next) {
    const account = accountOf(req);
    if (!account) {
      return next(new UnauthorizedError('sign in to continue', 'login_required'));
    }
    if (!isReviewer(account)) {
      return next(new ForbiddenError('registry reviewer required', 'reviewer_required'));
    }
    next();
  }

  /** In-app notice (and optional email) for the requester of an event. */
  function notifyRequester(request, kind, subject, body, link = '') {
    const stored = accounts.get(request.requester.githubId);
    notifications.enqueue({
      account: request.requester,
      kind,
      subject,
      body,
      link,
      email: stored ? stored.notifyEmail : '',
    });
    outbox.drain().catch(() => {});
  }

  /** View-model for the report controls on a package page. */
  function packageReviewContext(req, name) {
    const account = accountOf(req);
    const flash = req.session && req.session.flash ? req.session.flash : null;
    if (flash) delete req.session.flash;
    const decision = reviews.decision(name);
    const ratings = reviews.ratingsFor(name);
    return {
      canReport: Boolean(account),
      canReview: isReviewer(account),
      openReports: reviews.openReportCount(name),
      decision,
      history: decision ? decision.history : [],
      ratings,
      summary: reviews.ratingSummary(name),
      myRating: account
        ? ratings.find((entry) => entry.githubId === account.githubId) || null
        : null,
      csrf: req.session ? req.session.csrf : '',
      notice: typeof req.query.reported === 'string'
        ? 'Report submitted; a reviewer will take a look.'
        : (typeof req.query.decided === 'string'
          ? 'Review decision recorded.'
          : (typeof req.query.rated === 'string' ? 'Rating saved.' : '')),
      error: flash && flash.error ? flash.error : '',
    };
  }

  /** Double-submit CSRF check against the session's per-session token. */
  function requireCsrf(req, _res, next) {
    const expected = req.session && req.session.csrf ? req.session.csrf : '';
    const presented = String((req.body && req.body.csrf) || req.get('x-csrf-token') || '');
    if (!expected || !presented || !safeEqual(expected, presented)) {
      return next(new ForbiddenError(
        'missing or stale CSRF token; reload the page and retry',
        'csrf_failed',
      ));
    }
    next();
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
  // single byte of payload. One JWKS cache per process: keys are fetched
  // lazily and cached by kid (see src/oidc.js).
  const jwks = createJwksCache(config.oidcJwksUrl ? { url: config.oidcJwksUrl } : undefined);
  async function authenticated(req, res, next) {
    try {
      req.token = await authenticate(req, config.tokens, {
        publishers: config.publishers,
        audience: config.oidcAudience,
        jwks,
      });
      next();
    } catch (err) {
      cleanupAndNext(req, res, next, err);
    }
  }

  // ─── Read routes ──────────────────────────────────────────────────────────
  // Every read route carries the general limiter explicitly; the download
  // route adds the stricter download limiter on top.

  // Readmes are extracted from immutable stored artifacts; a small bounded
  // cache keeps repeated page views from re-inflating the same tarball. A
  // null result (no README.md) is cached too, so misses stay cheap.
  const README_CACHE_MAX = 128;
  const readmeCache = new Map();
  function cachedReadme(name, version, filePath) {
    const key = `${name}@${version}`;
    if (readmeCache.has(key)) return readmeCache.get(key);
    const value = extractReadme(filePath, { maxDecompressedBytes: config.maxDecompressedBytes });
    if (readmeCache.size >= README_CACHE_MAX) {
      readmeCache.delete(readmeCache.keys().next().value);
    }
    readmeCache.set(key, value);
    return value;
  }

  /** Lazy readme accessor for a package page (null when absent). */
  function readmeFor(pkg) {
    return (version) => {
      if (!pkg.versions[version]) return null;
      try {
        return cachedReadme(pkg.name, version, artifacts.require(pkg.name, version));
      } catch {
        return null;
      }
    };
  }

  /**
   * Index view for HTML rendering with reviewer decisions overlaid
   * (`flagged` / `reviewed` / `muted` marks). `/index.json` stays raw: review
   * state is display/audit data, not part of the publish protocol.
   */
  function reviewedIndex() {
    const index = indexStore.snapshot();
    const decisions = reviews.listDecisions();
    if (decisions.length === 0) return index;
    const packages = { ...index.packages };
    let changed = false;
    for (const { name, status } of decisions) {
      if (!status || !packages[name]) continue;
      packages[name] = {
        ...packages[name],
        ...(status === 'flagged' ? { flagged: true } : {}),
        ...(status === 'muted' ? { muted: true } : {}),
        ...(status === 'reviewed' ? { reviewed: true } : {}),
      };
      changed = true;
    }
    return changed ? { ...index, packages } : index;
  }

  /**
   * Listing view: like `reviewedIndex()`, but muted packages are removed
   * entirely. Muting only affects discovery (home, listing, search,
   * categories); the package page still resolves with a notice, downloads
   * keep working, and `/index.json` is untouched.
   */
  function publicIndex() {
    const index = reviewedIndex();
    const muted = Object.keys(index.packages)
      .filter((name) => index.packages[name].muted === true);
    if (muted.length === 0) return index;
    const packages = { ...index.packages };
    for (const name of muted) delete packages[name];
    return { ...index, packages };
  }

  app.get('/', generalLimit, (req, res) => {
    const index = indexStore.snapshot();
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(homePage(publicIndex(), { nav: accountNav(req) }));
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

  // Release notes: the changelog rendered with the readme pipeline, with the
  // deployed version first so "am I on the latest?" is one glance.
  app.get('/whats-new', generalLimit, (req, res) => {
    res.type('html').set('Cache-Control', 'public, max-age=300')
      .send(whatsNewPage({
        version: SERVICE_VERSION,
        changelogHtml: renderMarkdown(CHANGELOG_MD),
        nav: accountNav(req),
      }));
  });

  // Stylesheet for the read-only UI (module-level constant, no fs per request).
  app.get('/ui/registry.css', generalLimit, (req, res) => {
    res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(REGISTRY_CSS);
  });

  // Ready-to-copy workflow for community trusted publishing.
  app.get('/ui/templates/community-publish.yml', generalLimit, (req, res) => {
    res.type('text/yaml').set('Cache-Control', 'public, max-age=3600').send(COMMUNITY_PUBLISH_TEMPLATE);
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
  // Page banner artwork (same file the website serves on its banner pages).
  app.get('/ui/registry.webp', generalLimit, (req, res) => {
    res.type('image/webp').set('Cache-Control', 'public, max-age=604800')
      .send(UI_ASSETS.bannerRegistry);
  });
  // Package status badges (state x track matrix).
  for (const [file, bytes] of Object.entries(UI_ASSETS.badges)) {
    app.get(`/ui/${file}`, generalLimit, (req, res) => {
      res.type('image/webp').set('Cache-Control', 'public, max-age=604800').send(bytes);
    });
  }

  // Package listing: compact rows with sort/facets for the UI, JSON for API
  // consumers. `?page=` / `?per_page=` paginate both surfaces (defaults 1/50,
  // page size capped at 200); `/index.json` stays whole for the client.
  app.get('/packages', generalLimit, (req, res) => {
    const index = publicIndex();
    const listing = listingFromQuery(req.query);
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(packagesPage(index, { nav: accountNav(req), ...listing }));
    }
    const paged = paginatePackages(index, listing);
    res.json({
      packages: paged.names.map((name) => {
        const pkg = index.packages[name];
        return {
          name,
          description: pkg.description,
          latest: pkg.latest,
          versions: Object.keys(pkg.versions).length,
          categories: pkg.categories || [],
          keywords: pkg.keywords || [],
          license: pkg.license || '',
          repository: pkg.repository || '',
        };
      }),
      page: paged.page,
      per_page: paged.perPage,
      total: paged.total,
      total_pages: paged.totalPages,
      sort: paged.sort,
      category: paged.category,
      first_party: paged.firstParty,
      signed: paged.signed,
    });
  });

  // Category vocabulary with package counts: the browse/facet surface for
  // humans and agents (category names are registry-owned).
  app.get('/categories', generalLimit, (req, res) => {
    const index = publicIndex();
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(categoriesPage(index, { nav: accountNav(req) }));
    }
    res.json({ categories: categoryCounts(index) });
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
      const view = reviewedIndex();
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(packagePage(view.packages[name] || pkg, view.registry, '', {
          nav: accountNav(req),
          readme: readmeFor(pkg),
          review: packageReviewContext(req, pkg.name),
        }));
    }
    res.json(pkg);
  });

  app.get('/packages/:name/:version', generalLimit, (req, res) => {
    const { name, version } = req.params;
    if (wantsHtml(req)) {
      const view = reviewedIndex();
      const pkg = view.packages[name];
      const entry = pkg?.versions?.[version];
      if (!pkg || !entry) {
        return res.status(404).type('html')
          .send(notFoundPage(`Version "${version}" of "${name}" was not found.`));
      }
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(packagePage(pkg, view.registry, version, {
          nav: accountNav(req),
          readme: readmeFor(pkg),
          review: packageReviewContext(req, pkg.name),
        }));
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

  // Readme for one immutable version, extracted from the stored tarball
  // (SESSION.md section 13 phase 1). Bounded at 64 KB; a missing or
  // unreadable README.md is a 404, not an empty document.
  app.get('/packages/:name/:version/readme', generalLimit, (req, res) => {
    const { name, version } = req.params;
    indexStore.requireVersion(name, version);
    const file = artifacts.require(name, version);
    const readme = cachedReadme(name, version, file);
    if (readme === null) {
      throw new NotFoundError(
        `version ${version} of ${name} has no README.md`,
        'readme_not_found',
      );
    }
    res.type('text/markdown')
      .set('Cache-Control', 'public, max-age=604800, immutable')
      .send(readme);
  });

  app.get('/search', generalLimit, (req, res) => {
    const rawQuery = String(req.query.q || '');
    const category = String(req.query.category || '').trim().toLowerCase();
    const index = publicIndex();
    if (wantsHtml(req)) {
      return res.type('html').set('Cache-Control', 'public, max-age=60')
        .send(searchPage(index, rawQuery, category, { nav: accountNav(req) }));
    }
    const results = searchPackages(index, rawQuery, category).map(({ name, pkg }) => ({
      name,
      description: pkg.description,
      latest: pkg.latest,
      versions: Object.keys(pkg.versions).length,
      categories: pkg.categories || [],
      keywords: pkg.keywords || [],
      license: pkg.license || '',
      repository: pkg.repository,
    }));
    res.json({ query: rawQuery, category, results });
  });

  // ─── Accounts and requests (registry 2.0; UI-only, HTML responses) ────────
  // Sign-in links an identity to the request queue. Nothing here mints or
  // touches publish credentials: approved requests are fulfilled by the
  // operator on the host, and only the reference is recorded.

  app.get('/login', generalLimit, (req, res) => {
    if (accountOf(req)) return res.redirect(302, '/account');
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    res.type('html').send(loginPage({
      enabled: config.oauth.enabled,
      error,
      nav: accountNav(req),
    }));
  });

  app.get('/auth/github/start', writeLimit, (req, res) => {
    if (!config.oauth.enabled) return res.redirect(302, '/login');
    // A fresh session per attempt: single-use state, no fixation.
    if (req.session) sessions.destroy(req.sessionId);
    const state = oauth.randomState();
    const id = sessions.create({
      oauthState: state,
      oauthStateAt: Date.now(),
      returnTo: safeReturnTo(req.query.returnTo),
    });
    setSessionCookie(res, id);
    res.redirect(302, oauth.authorizeUrl(config.oauth, { redirectUri: callbackUri, state }));
  });

  app.get(oauth.CALLBACK_PATH, generalLimit, async (req, res, next) => {
    try {
      if (!config.oauth.enabled) {
        throw new NotFoundError('sign-in is not configured on this registry', 'oauth_not_configured');
      }
      const { code, state, error } = req.query;
      if (typeof error === 'string' && error) {
        return res.redirect(302, '/login?error=denied');
      }
      const session = req.session;
      const expected = session && typeof session.oauthState === 'string' ? session.oauthState : '';
      if (!session || typeof state !== 'string' || !state || !expected || !safeEqual(expected, state)) {
        throw new ForbiddenError('sign-in state check failed; start over', 'oauth_state_mismatch');
      }
      const startedAt = Number(session.oauthStateAt) || 0;
      const returnTo = safeReturnTo(session.returnTo);
      // Single-use state: the session is gone whether or not the exchange
      // succeeds, so a leaked callback URL cannot be replayed.
      sessions.destroy(req.sessionId);
      if (Date.now() - startedAt > oauthStateMaxAgeMs) {
        throw new ForbiddenError('sign-in took too long; start over', 'oauth_state_expired');
      }
      if (typeof code !== 'string' || code === '') {
        throw new BadRequestError('GitHub did not return a sign-in code', 'oauth_no_code');
      }
      const accessToken = await oauth.exchangeCode(config.oauth, {
        code,
        redirectUri: callbackUri,
        fetchImpl: config.oauth.fetchImpl,
      });
      const profile = await oauth.fetchUser(config.oauth, accessToken, config.oauth.fetchImpl);
      if (admin.statusOf(profile.id) === 'banned') {
        return res.redirect(302, '/login?error=banned');
      }
      const account = accounts.upsert(profile);
      admin.touch({ githubId: account.githubId, login: account.login });
      const id = sessions.create({
        account: { githubId: account.githubId, login: account.login },
      });
      setSessionCookie(res, id);
      res.redirect(302, returnTo);
    } catch (err) {
      if (err instanceof oauth.OAuthError) {
        // Upstream failure: retryable, and the detail stays in the log only.
        console.warn(`OAuth sign-in failed: ${err.code} (${err.message})`);
        return res.redirect(302, '/login?error=oauth');
      }
      next(err);
    }
  });

  /** Shared context for the /account* pages (identity, role, flash). */
  function accountContext(req) {
    const sessionAccount = accountOf(req);
    if (!sessionAccount) return null;
    const stored = accounts.get(sessionAccount.githubId) || sessionAccount;
    const flash = req.session.flash || null;
    if (flash) delete req.session.flash;
    return {
      account: stored,
      role: isAdmin(sessionAccount)
        ? 'admin'
        : (isReviewer(sessionAccount) ? 'reviewer' : 'member'),
      status: accountStatus(sessionAccount),
      csrf: req.session.csrf,
      error: flash && flash.error ? flash.error : '',
      form: flash && flash.form ? flash.form : {},
      nav: accountNav(req),
    };
  }

  function requireAccount(req, res, next) {
    if (!config.oauth.enabled) return res.redirect(302, '/login');
    if (!accountOf(req)) {
      return res.redirect(302, `/login?returnTo=${encodeURIComponent(req.originalUrl || '/account')}`);
    }
    next();
  }

  app.get('/account', generalLimit, requireAccount, (req, res) => {
    const context = accountContext(req);
    const notice = req.query.email === '1' ? 'Notification email saved.' : '';
    res.type('html').send(accountOverviewPage({
      ...context,
      requests: requests.list({ requesterId: context.account.githubId }),
      notifications: notifications.listFor(context.account.githubId, { limit: 20 }),
      notice,
    }));
  });

  app.get('/account/requests', generalLimit, requireAccount, (req, res) => {
    const context = accountContext(req);
    const created = typeof req.query.created === 'string' && /^req_[0-9a-f]{12}$/.test(req.query.created)
      ? req.query.created
      : '';
    res.type('html').send(accountRequestsPage({
      ...context,
      requests: requests.list({ requesterId: context.account.githubId }),
      notice: created ? `Request ${created} submitted for review.` : '',
    }));
  });

  app.get('/account/notifications', generalLimit, requireAccount, (req, res) => {
    const context = accountContext(req);
    const read = req.query.read === '1' ? 'All notifications marked as read.' : '';
    res.type('html').send(accountNotificationsPage({
      ...context,
      notifications: notifications.listFor(context.account.githubId, { limit: 50 }),
      notice: read,
    }));
  });

  app.post(
    '/account/notifications/read',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireCsrf,
    (req, res) => {
      notifications.markAllRead(accountOf(req).githubId);
      res.redirect(303, '/account/notifications?read=1');
    },
  );

  app.get('/account/settings', generalLimit, requireAccount, (req, res) => {
    const context = accountContext(req);
    const notice = req.query.email === '1' ? 'Notification email saved.' : '';
    res.type('html').send(accountSettingsPage({
      ...context,
      notifyEmail: context.account.notifyEmail || '',
      notice,
    }));
  });

  app.post(
    '/account/email',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireCsrf,
    (req, res, next) => {
      try {
        const raw = String(req.body.email || '');
        const saved = accounts.setNotifyEmail(accountOf(req).githubId, raw);
        if (raw.trim() !== '' && saved === '') {
          req.session.flash = { error: 'that email address does not look valid' };
          return res.redirect(303, '/account/settings');
        }
        return res.redirect(303, '/account/settings?email=1');
      } catch (err) {
        return next(err);
      }
    },
  );

  app.post(
    '/requests',
    writeLimit,
    express.urlencoded({ extended: false, limit: '64kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      try {
        const created = requests.create({
          kind: String(req.body.kind || 'token'),
          requester: accountOf(req),
          scopes: String(req.body.scopes || ''),
          repository: String(req.body.repository || ''),
          workflow: String(req.body.workflow || ''),
          refs: String(req.body.refs || ''),
          note: String(req.body.note || ''),
        });
          res.redirect(303, `/account/requests?created=${encodeURIComponent(created.id)}`);
        } catch (err) {
          if (err instanceof BadRequestError || err instanceof ConflictError) {
            // Keep the submission on the round trip so the user can fix it.
            req.session.flash = {
              error: err.message,
              form: {
                kind: String(req.body.kind || 'token'),
                scopes: String(req.body.scopes || ''),
                repository: String(req.body.repository || ''),
                workflow: String(req.body.workflow || ''),
                refs: String(req.body.refs || ''),
                note: String(req.body.note || ''),
              },
            };
            return res.redirect(303, '/account/requests');
          }
        return next(err);
      }
    },
  );

  app.post(
    '/logout',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireCsrf,
    (req, res) => {
      if (req.session) sessions.destroy(req.sessionId);
      clearSessionCookie(res);
      res.redirect(303, '/');
    },
  );

  // ─── Admin console (registry 2.1) ─────────────────────────────────────────
  // One console for requests, package moderation, reports, users, and audit.
  // Every mutation is admin-only, CSRF-checked, and lands an admin_audit row.

  function adminPageContext(req) {
    const account = accountOf(req);
    const flash = req.session.flash || null;
    if (flash) delete req.session.flash;
    return {
      account,
      csrf: req.session.csrf,
      error: flash && flash.error ? flash.error : '',
      notice: '',
      nav: accountNav(req),
    };
  }

  function requireAdminPage(req, res, next) {
    if (!config.oauth.enabled) return res.redirect(302, '/login');
    const account = accountOf(req);
    if (!account) {
      return res.redirect(302, `/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!isAdmin(account)) {
      return next(new ForbiddenError('registry admin required', 'admin_required'));
    }
    next();
  }

  function accountUserView(account) {
    const storedRole = admin.roleOf(account.githubId);
    const configAdmin = isConfigAdmin(account);
    const configReviewer = isConfigReviewer(account);
    const role = configAdmin || storedRole === 'admin'
      ? 'admin'
      : ((configReviewer || storedRole === 'reviewer') ? 'reviewer' : 'member');
    const state = admin.stateRecord(account.githubId);
    return {
      githubId: account.githubId,
      login: account.login,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      role,
      configAdmin,
      configReviewer,
      storedRole,
      status: state ? state.status : 'active',
      reason: state ? state.reason : '',
      changedBy: state ? state.changed_by : '',
      changedAt: state ? state.changed_at : '',
    };
  }

  app.get('/admin', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    const allRequests = requests.list();
    const decisions = reviews.listDecisions().filter((entry) => entry.status);
    res.type('html').send(adminDashboardPage({
      ...context,
      counts: {
        pendingRequests: allRequests.filter((record) => record.status === 'pending').length,
        awaitingFulfilment: allRequests.filter((record) => record.status === 'approved').length,
        openReports: reviews.listReports({ status: 'open' }).length,
        flagged: decisions.filter((entry) => entry.status === 'flagged').length,
        muted: decisions.filter((entry) => entry.status === 'muted').length,
        users: accounts.list().length,
      },
      recentAudit: admin.recentAudit(8),
    }));
  });

  app.get('/admin/requests', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    const updated = typeof req.query.updated === 'string' && /^req_[0-9a-f]{12}$/.test(req.query.updated)
      ? req.query.updated
      : '';
    const filter = ['pending', 'approved', 'closed'].includes(String(req.query.filter))
      ? String(req.query.filter)
      : '';
    res.type('html').send(adminRequestsPage({
      ...context,
      requests: requests.list(),
      activePublishers: publisherStore.list().map((entry) => entry.requestId),
      notice: updated ? `Request ${updated} updated.` : '',
      filter,
    }));
  });

  app.get('/admin/packages', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    const q = String(req.query.q || '').trim().toLowerCase();
    const filter = ['flagged', 'muted', 'yanked', 'undecided'].includes(String(req.query.filter))
      ? String(req.query.filter)
      : '';
    const updated = typeof req.query.updated === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(req.query.updated)
      ? req.query.updated
      : '';
    const index = reviewedIndex();
    const entries = Object.entries(index.packages)
      .filter(([name]) => !q || name.toLowerCase().includes(q))
      .map(([name, pkg]) => ({
        name,
        pkg,
        decision: reviews.decision(name),
      }))
      .filter(({ pkg, decision }) => {
        if (filter === 'flagged') return pkg.flagged === true;
        if (filter === 'muted') return pkg.muted === true;
        if (filter === 'undecided') return !decision || !decision.status;
        if (filter === 'yanked') {
          return Object.values(pkg.versions || {}).some((entry) => entry.yanked === true);
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
    res.type('html').send(adminPackagesPage({
      ...context,
      packages: entries,
      q,
      filter,
      notice: updated ? `Decision recorded for ${updated}.` : '',
    }));
  });

  app.post(
    '/admin/packages/:name/decision',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const action = String(req.body.action || '');
        const status = { review: 'reviewed', flag: 'flagged', mute: 'muted', clear: '' }[action];
        if (status === undefined) {
          throw new BadRequestError('action must be review, flag, mute, or clear', 'invalid_action');
        }
        const name = String(req.params.name).toLowerCase();
        reviews.setDecision(name, {
          status,
          actor: accountOf(req).login,
          note: String(req.body.note || ''),
        });
        admin.audit({
          actor: accountOf(req),
          action: `package.${action}`,
          subjectType: 'package',
          subjectId: name,
          detail: String(req.body.note || '').slice(0, 500),
        });
        res.redirect(303, `/admin/packages?updated=${encodeURIComponent(name)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/admin/packages?updated=${encodeURIComponent(String(req.params.name).toLowerCase())}`);
        }
        return next(err);
      }
    },
  );

  app.post(
    '/admin/packages/:name/yank',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const name = String(req.params.name).toLowerCase();
        const version = String(req.body.version || '');
        const reason = String(req.body.reason || '').trim();
        if (reason === '') {
          throw new BadRequestError('a reason is required when yanking a version', 'yank_reason_required');
        }
        indexStore.yankVersion(name, version, reason);
        admin.audit({
          actor: accountOf(req),
          action: 'package.yank',
          subjectType: 'package',
          subjectId: name,
          detail: `${version}: ${reason}`,
        });
        res.redirect(303, `/admin/packages?updated=${encodeURIComponent(name)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/admin/packages?updated=${encodeURIComponent(String(req.params.name).toLowerCase())}`);
        }
        return next(err);
      }
    },
  );

  app.get('/admin/reports', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    const filter = ['open', 'resolved', 'dismissed'].includes(String(req.query.filter))
      ? String(req.query.filter)
      : '';
    res.type('html').send(adminReportsPage({
      ...context,
      reports: reviews.listReports({ status: filter }),
      filter,
    }));
  });

  app.post(
    '/admin/reports/:id/resolve',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        reviews.resolveReport(String(req.params.id), {
          actor: accountOf(req).login,
          status: String(req.body.status || 'resolved'),
          resolution: String(req.body.resolution || ''),
        });
        admin.audit({
          actor: accountOf(req),
          action: 'report.resolve',
          subjectType: 'report',
          subjectId: String(req.params.id),
          detail: `${String(req.body.status || 'resolved')}: ${String(req.body.resolution || '').slice(0, 400)}`,
        });
        res.redirect(303, '/admin/reports');
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/admin/reports');
        }
        return next(err);
      }
    },
  );

  app.get('/admin/users', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    res.type('html').send(adminUsersPage({
      ...context,
      users: accounts.list().map(accountUserView),
      q: String(req.query.q || '').trim(),
    }));
  });

  app.get('/admin/users/:githubId', generalLimit, requireAdminPage, (req, res, next) => {
    const account = accounts.get(String(req.params.githubId));
    if (!account) {
      return next(new NotFoundError('account not found', 'account_not_found'));
    }
    const context = adminPageContext(req);
    res.type('html').send(adminUserPage({
      ...context,
      user: accountUserView(account),
      audit: admin.auditFor(account.githubId, 30),
    }));
  });

  app.post(
    '/admin/users/:githubId/role',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const target = accounts.get(String(req.params.githubId));
        if (!target) throw new NotFoundError('account not found', 'account_not_found');
        const actor = accountOf(req);
        const role = String(req.body.role || '');
        if (isConfigAdmin(target) && role === '') {
          throw new ConflictError(
            'this admin comes from the deployment config and cannot be demoted here',
            'config_admin_protected',
          );
        }
        if (isConfigAdmin(target) && role === 'reviewer') {
          throw new ConflictError(
            'this account is already a config admin; it cannot be reduced to reviewer here',
            'config_admin_protected',
          );
        }
        // Last-admin guard: never let the console remove the only admin.
        if (role === '' && isAdmin(target)) {
          const remaining = accounts.list()
            .filter((candidate) => candidate.githubId !== target.githubId)
            .some((candidate) => isAdmin(candidate));
          if (!remaining) {
            throw new ConflictError('at least one admin must remain', 'last_admin');
          }
        }
        admin.setRole({ account: target, role, actor });
        res.redirect(303, `/admin/users/${encodeURIComponent(target.githubId)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/admin/users/${encodeURIComponent(String(req.params.githubId))}`);
        }
        return next(err);
      }
    },
  );

  app.post(
    '/admin/users/:githubId/status',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const target = accounts.get(String(req.params.githubId));
        if (!target) throw new NotFoundError('account not found', 'account_not_found');
        const actor = accountOf(req);
        if (isConfigAdmin(target)) {
          throw new ConflictError(
            'this admin comes from the deployment config; change the state in the environment',
            'config_admin_protected',
          );
        }
        const status = String(req.body.status || '');
        admin.setStatus({
          account: target,
          status,
          reason: String(req.body.reason || ''),
          actor,
        });
        if (status === 'banned' && sessions) {
          sessions.destroyForAccount(target.githubId);
        }
        res.redirect(303, `/admin/users/${encodeURIComponent(target.githubId)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/admin/users/${encodeURIComponent(String(req.params.githubId))}`);
        }
        return next(err);
      }
    },
  );

  app.get('/admin/audit', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    res.type('html').send(adminAuditPage({
      ...context,
      entries: admin.recentAudit(100),
    }));
  });

  app.post(
    '/admin/requests/:id/decision',
    writeLimit,
    express.urlencoded({ extended: false, limit: '64kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const actor = accountOf(req).login;
        const action = String(req.body.action || '');
        const note = String(req.body.note || '');
        const request = requests.get(req.params.id);
        let updated;
        if (request.kind === 'publisher' && action === 'approve') {
          // Approving a trusted publisher *is* the host action: activate the
          // entry now and auto-fulfil, so the admin's job is one click.
          const entry = publisherStore.add({
            requestId: request.id,
            repository: request.repository,
            workflow: request.workflow,
            refs: request.refs,
            scopes: request.scopes,
            approvedBy: actor,
          });
          config.publishers = [...config.publishers, entry];
          requests.decide(request.id, { action, actor, note });
          updated = requests.fulfil(request.id, {
            actor,
            reference: `trusted publisher entry activated (${entry.repository} / ${entry.workflow})`,
          });
          notifyRequester(
            request,
            'publisher-approved',
            'Trusted publisher approved',
            `${request.repository} / ${request.workflow} is live. Run your publish workflow.`,
          );
          console.log(`Trusted publisher ${entry.repository} / ${entry.workflow} activated for ${request.id} by ${actor}`);
        } else {
          updated = requests.decide(request.id, { action, actor, note });
          if (action === 'approve') {
            notifyRequester(
              request,
              'request-approved',
              'Token request approved',
              'The maintainers will mint your token on the host and deliver it privately.',
            );
          } else if (action === 'deny') {
            notifyRequester(
              request,
              'request-denied',
              'Request denied',
              note ? `Reason: ${note}` : '',
            );
          }
          console.log(`Request ${updated.id} ${updated.status} by ${updated.decidedBy}`);
        }
        res.redirect(303, `/admin/requests?updated=${encodeURIComponent(updated.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          // Keep the admin on the queue with the reason visible.
          req.session.flash = { error: err.message };
          return res.redirect(303, '/admin/requests');
        }
        return next(err);
      }
    },
  );

  app.post(
    '/admin/requests/:id/revoke',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const request = requests.get(req.params.id);
        const actor = accountOf(req).login;
        publisherStore.remove(request.id);
        config.publishers = config.publishers.filter((entry) => entry.requestId !== request.id);
        requests.revoke(request.id, { actor, note: String(req.body.note || '') });
        notifyRequester(
          request,
          'publisher-revoked',
          'Trusted publisher revoked',
          `${request.repository} / ${request.workflow} is no longer accepted; contact the maintainers if this was unexpected.`,
        );
        console.log(`Trusted publisher entry for ${request.id} revoked by ${actor}`);
        res.redirect(303, `/admin/requests?updated=${encodeURIComponent(request.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/admin/requests');
        }
        return next(err);
      }
    },
  );

  app.post(
    '/admin/requests/:id/fulfil',
    writeLimit,
    express.urlencoded({ extended: false, limit: '64kb' }),
    requireAdmin,
    requireCsrf,
    (req, res, next) => {
      try {
        const updated = requests.fulfil(req.params.id, {
          actor: accountOf(req).login,
          reference: String(req.body.reference || ''),
        });
        notifyRequester(
          updated,
          'request-fulfilled',
          'Token request fulfilled',
          updated.mintReference ? `Reference: ${updated.mintReference}` : 'Your token was delivered.',
        );
        console.log(`Request ${updated.id} fulfilled by ${updated.fulfilledBy}`);
        res.redirect(303, `/admin/requests?updated=${encodeURIComponent(updated.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/admin/requests');
        }
        return next(err);
      }
    },
  );

  // ─── Reports, ratings, and the reviewer queue (registry 2.0 phase 3) ─────
  // Signed-in accounts can report a package and leave one star rating plus a
  // short review; reviewers and admins resolve or dismiss with a note.
  // Moderation data never alters artifacts, signatures, or the index.

  app.post(
    '/packages/:name/rating',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const { name } = req.params;
      try {
        if (!indexStore.getPackage(name)) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        const rating = reviews.rate(name, {
          user: accountOf(req),
          stars: req.body.stars,
          review: String(req.body.review || ''),
        });
        console.log(`Rating ${rating.stars}/5 on ${name} by ${rating.login}`);
        res.redirect(303, `/packages/${encodeURIComponent(name)}?rated=1#reviews`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/packages/${encodeURIComponent(name)}#reviews`);
        }
        return next(err);
      }
    },
  );

  app.post(
    '/packages/:name/report',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const { name } = req.params;
      try {
        if (!indexStore.snapshot().packages[name]) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        const report = reviews.createReport({
          packageName: name,
          reporter: accountOf(req),
          reason: String(req.body.reason || ''),
          note: String(req.body.note || ''),
        });
        console.log(`Report ${report.id} filed on ${report.package} by ${report.reporter.login}`);
        res.redirect(303, `/packages/${encodeURIComponent(name)}?reported=${encodeURIComponent(report.id)}#report`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/packages/${encodeURIComponent(name)}#report`);
        }
        return next(err);
      }
    },
  );

  app.get('/review', generalLimit, (req, res, next) => {
    if (!config.oauth.enabled) return res.redirect(302, '/login');
    const account = accountOf(req);
    if (!account) {
      return res.redirect(302, `/login?returnTo=${encodeURIComponent('/review')}`);
    }
    if (!isReviewer(account)) {
      return next(new ForbiddenError('registry reviewer required', 'reviewer_required'));
    }
    const updated = typeof req.query.updated === 'string' && /^rep_[0-9a-f]{12}$/.test(req.query.updated)
      ? req.query.updated
      : '';
    const flash = req.session.flash || null;
    if (flash) delete req.session.flash;
    res.type('html').send(reviewPage({
      account,
      reports: reviews.listReports(),
      decisions: reviews.listDecisions(),
      csrf: req.session.csrf,
      notice: updated ? `Report ${updated} updated.` : '',
      error: flash && flash.error ? flash.error : '',
      nav: accountNav(req),
    }));
  });

  app.post(
    '/review/packages/:name/decision',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireReviewer,
    requireCsrf,
    (req, res, next) => {
      const { name } = req.params;
      try {
        if (!indexStore.getPackage(name)) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        const action = String(req.body.action || '');
        const status = action === 'review' ? 'reviewed' : (action === 'flag' ? 'flagged' : (action === 'clear' ? '' : null));
        if (status === null) {
          throw new BadRequestError('action must be "review", "flag", or "clear"', 'invalid_action');
        }
        const record = reviews.setDecision(name, {
          status,
          actor: accountOf(req).login,
          note: String(req.body.note || ''),
        });
        console.log(`Package ${name} review decision: ${record.status || 'cleared'} by ${accountOf(req).login}`);
        res.redirect(303, `/packages/${encodeURIComponent(name)}?decided=1#review`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/packages/${encodeURIComponent(name)}#review`);
        }
        return next(err);
      }
    },
  );

  app.post(
    '/review/reports/:id/resolve',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireReviewer,
    requireCsrf,
    (req, res, next) => {
      try {
        const updated = reviews.resolveReport(req.params.id, {
          actor: accountOf(req).login,
          status: String(req.body.status || 'resolved'),
          resolution: String(req.body.resolution || ''),
        });
        console.log(`Report ${updated.id} ${updated.status} by ${updated.resolvedBy}`);
        res.redirect(303, `/review?updated=${encodeURIComponent(updated.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/review');
        }
        return next(err);
      }
    },
  );

  // ─── Internal fulfilment API (fulfiller worker only; secret-gated) ───────
  // The worker mints into the host token file and mails the token; these
  // routes let it read approved token requests and mark them fulfilled, which
  // raises the requester's notification. Disabled without FULFILLER_SECRET.

  function requireFulfiller(req, _res, next) {
    if (!config.fulfillerSecret) {
      return next(new NotFoundError('not found', 'not_found'));
    }
    const header = String(req.get('authorization') || '');
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, config.fulfillerSecret)) {
      return next(new ForbiddenError('invalid fulfiller secret', 'forbidden'));
    }
    next();
  }

  app.get('/internal/requests', generalLimit, requireFulfiller, (req, res) => {
    const status = String(req.query.status || 'approved');
    const tokenRequests = requests.list({ status }).filter((entry) => entry.kind === 'token');
    res.json({
      requests: tokenRequests.map((entry) => {
        const stored = accounts.get(entry.requester.githubId);
        return {
          id: entry.id,
          scopes: entry.scopes,
          requester: entry.requester,
          notifyEmail: stored ? stored.notifyEmail : '',
          createdAt: entry.createdAt,
        };
      }),
    });
  });

  app.post(
    '/internal/requests/:id/fulfilled',
    writeLimit,
    express.json({ limit: '16kb' }),
    requireFulfiller,
    (req, res, next) => {
      try {
        const reference = String((req.body && req.body.reference) || 'fulfilled by the worker');
        const updated = requests.fulfil(req.params.id, { actor: 'fulfiller', reference });
        notifyRequester(
          updated,
          'request-fulfilled',
          'Token request fulfilled',
          updated.mintReference ? `Reference: ${updated.mintReference}` : 'Your token was delivered.',
        );
        console.log(`Request ${updated.id} fulfilled by the fulfiller worker`);
        res.json({ ok: true, id: updated.id, status: updated.status });
      } catch (err) {
        next(err);
      }
    },
  );

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
        ...(result.publisher ? { publisher: result.publisher } : {}),
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
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
      return res.status(404).type('html')
        .send(notFoundPage('This page does not exist.', { nav: accountNav(req) }));
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
  app.locals.registry = {
    config,
    indexStore,
    artifacts,
    accounts,
    requests,
    reviews,
    publisherStore,
    db,
    notifications,
    admin,
  };
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
    // A registered key pins the publisher: a stolen token alone cannot
    // publish under a different key. Tokens without a registered key keep
    // the previous behavior (any internally consistent signature).
    if (token.publicKey && publicKey !== token.publicKey) {
      removeUpload();
      throw new UnprocessableEntityError(
        `token "${token.label}" is pinned to signing key fp ${fingerprint(token.publicKey)}; `
        + `the submitted key fp ${fingerprint(publicKey)} does not match`,
        'public_key_mismatch',
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

  // T3: package metadata (description, categories, keywords, license,
  // repository) and dependencies only exist inside package.xi.
  const manifest = extractManifest(staged, config);
  const packageMeta = normalizePackageMetadata(manifest);
  const metadata = {
    version,
    sha256,
    signature,
    publicKey,
    size: fileBuffer.length,
    published: new Date().toISOString(),
    dependencies: manifest.dependencies,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(packageMeta.license ? { license: packageMeta.license } : {}),
    ...(packageMeta.repository ? { repository: packageMeta.repository } : {}),
    ...(packageMeta.categories.length > 0 ? { categories: packageMeta.categories } : {}),
    ...(packageMeta.keywords.length > 0 ? { keywords: packageMeta.keywords } : {}),
    ...(packageMeta.stage ? { stage: packageMeta.stage } : {}),
  };
  if (typeof req.body?.compiler === 'string' && req.body.compiler) {
    metadata.compiler = req.body.compiler.slice(0, 64);
  }
  // OIDC provenance: repository/workflow/ref/run recorded per version. Static
  // tokens have no publisher and stay unchanged.
  if (token.publisher) metadata.publisher = token.publisher;
  const warnings = packageMeta.unknownCategories.map(
    (category) => `unknown category "${category}" ignored; valid categories: ${CATEGORIES.join(', ')}`,
  );
  // A package without categories is invisible on /categories and the category
  // facets. Warn at publish time so the gap is fixed at the source (the
  // packages lane owns the manifests); nothing blocks the publish.
  if (packageMeta.categories.length === 0) {
    warnings.push(
      `no categories declared; add 1-3 from the registry vocabulary in package.xi: ${CATEGORIES.join(', ')}`,
    );
  }
  // SESSION.md section 13 phase 4: the package page shows README.md from the
  // stored tarball; warn at publish time when it is missing. This walks the
  // archive a second time (the manifest pass just ran), but uploads are
  // bounded and publishes are rare, so the cost is acceptable.
  if (!extractReadme(staged, config)) {
    warnings.push('no README.md in the tarball; the package page will not show one');
  }
  if (packageMeta.unknownStage) {
    warnings.push(
      `unknown stage "${packageMeta.unknownStage}" ignored; valid stages: ${STAGES.join(', ')}`,
    );
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
    + `sha256:${sha256.slice(0, 12)}..., by ${token.label}`
    + `${token.publisher ? ` via ${token.publisher.repository}` : ''})`,
  );
  return { name, version, sha256, signature, publicKey, warnings, publisher: token.publisher };
}

module.exports = { createApp, publish, computeLatest };
