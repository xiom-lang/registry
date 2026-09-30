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
  setStageOverrides,
  effectiveStage,
  isPrereleaseLatest,
  STAGE_FACETS,
  PRERELEASE_FACETS,
  DEFAULT_STAGE,
  DEFAULT_PRERELEASE,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
} = require('./ui/pages');
const {
  ContributorStore,
  checkSponsorListing,
  contributorScore,
  maintainerCounts,
  CONTRIBUTORS_LIMIT,
} = require('./contributors');
const { profilePage, contributorsPage } = require('./ui/profile');
const { WatchStore } = require('./watches');
const { DownloadStats } = require('./stats');
const { isAttestationUrl, discoverAttestation } = require('./attestations');
const { indexDigest, createIndexSigner } = require('./index-digest');
const { packageActivity, watchedFeed } = require('./activity');
const {
  loginPage,
  accountOverviewPage,
  accountRequestsPage,
  accountNotificationsPage,
  accountSettingsPage,
  accountFeedPage,
} = require('./ui/account');
const {
  adminDashboardPage,
  adminRequestsPage,
  adminPackagesPage,
  adminClaimsPage,
  adminReportsPage,
  adminUsersPage,
  adminUserPage,
  adminAuditPage,
} = require('./ui/admin');
const { AdminStore } = require('./admin');
const { loadStageOverrides } = require('./stage-overrides');
const { OwnershipStore, maintainerView, maintainedPackages } = require('./ownership');
const { SupportStore, SUPPORT_REASONS } = require('./support');
const { publishGuidePage } = require('./ui/publish');
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
// The publishing guide: /publish refreshes it from GitHub with a short TTL and
// falls back to the bundled copy. The bundle is read lazily (never at module
// load) so a minimal image without PUBLISHING.md still boots; if both sources
// are unavailable the page renders a short signpost instead of failing.
const PUBLISHING_DOC_DEFAULT_URL = 'https://raw.githubusercontent.com/xiom-lang/registry/main/PUBLISHING.md';
const PUBLISHING_DOC_TTL_MS = 10 * 60 * 1000;
const PUBLISHING_DOC_FALLBACK = [
  '# Publishing to XIOM',
  '',
  'The bundled publishing guide is missing from this deployment and the live',
  'copy could not be fetched. Read the full guide at',
  '[github.com/xiom-lang/registry](https://github.com/xiom-lang/registry/blob/main/PUBLISHING.md),',
  'or grab the workflow template at `/ui/templates/community-publish.yml`.',
].join('\n');
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
 * first_party, signed, stage, prerelease). Garbage and out-of-range values
 * fall back to the defaults instead of erroring: the listing is a browsing
 * affordance, not a protocol contract (SESSION.md section 13). Lifecycle
 * facets (A10) default to all stages with pre-releases hidden.
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
    sort: ['name', 'downloads', 'rating'].includes(query.sort) ? query.sort : 'updated',
    category: typeof query.category === 'string' ? query.category.trim().toLowerCase() : '',
    firstParty: flag(query.first_party),
    signed: flag(query.signed),
    ...lifecycleFromQuery(query),
  };
}

/**
 * Admin console paging (D3): `?page` / `?per_page`, clamped like the public
 * listing (default 50, cap 200) so a deep link can never ask for a huge scan.
 */
function adminPaging(query) {
  const clamp = (value, fallback, max) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
  };
  return {
    page: clamp(query.page, 1, 1_000_000),
    perPage: clamp(query.per_page, 50, 200),
  };
}

/** Lifecycle facet params shared by /packages and /search (A10). */
function lifecycleFromQuery(query) {
  const pick = (value, allowed, fallback) => {
    const cleaned = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return allowed.includes(cleaned) ? cleaned : fallback;
  };
  return {
    stage: pick(query.stage, STAGE_FACETS, DEFAULT_STAGE),
    prerelease: pick(query.prerelease, PRERELEASE_FACETS, DEFAULT_PRERELEASE),
  };
}

/** One package as the listing JSON exposes it (A10 adds stage/prerelease). */
function listingEntry(name, pkg) {
  const latest = pkg.latest && pkg.versions[pkg.latest] ? pkg.versions[pkg.latest] : null;
  return {
    name,
    description: pkg.description,
    latest: pkg.latest,
    versions: Object.keys(pkg.versions).length,
    categories: pkg.categories || [],
    keywords: pkg.keywords || [],
    license: pkg.license || '',
    repository: pkg.repository || '',
    stage: effectiveStage(name, pkg, latest) || '',
    prerelease: isPrereleaseLatest(pkg),
  };
}

/**
 * Build the Express application. Exported for tests; `src/server.js` owns
 * the listen call.
 */
function createApp(config = loadConfig()) {
  const app = express();
  // Every HTML page renders the signed-in account in the nav, so dynamic
  // responses must never be publicly cached: a browser or shared cache that
  // keeps the anonymous page would still show "Sign in" right after a
  // successful sign-in (owner report 2026-09-29). This default is private
  // and revalidates; genuinely public surfaces (index.json, assets, readme)
  // opt back in with their own Cache-Control.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-cache');
    next();
  });
  const indexStore = new IndexStore(config);
  // C5: built once at boot. A malformed INDEX_SIGNING_KEY throws here, on
  // purpose: a broken security configuration must not boot quietly.
  const indexSigner = createIndexSigner(config.indexSigningKey);
  if (indexSigner) {
    console.log(`xiom-registry: index digest signing enabled (key fp ${indexSigner.fingerprint})`);
  }
  const artifacts = new ArtifactStore(config);
  // Registry 2.0: sign-in sessions, GitHub identities, and the request queue.
  // Sessions and the queue are display/audit data only; none of it can
  // publish (see SESSION.md section 15).
  const sessions = config.oauth.enabled
    ? new SessionStore({ key: oauth.deriveSessionKey(config.oauth.clientSecret) })
    : null;
  // SQLite platform layer (SESSION.md section 18 / A3): notifications, roles,
  // audit, and now rating storage live here; JSON stores stay for identity and
  // queue data that has not moved yet.
  const db = new Database({ path: config.dbPath });
  const accounts = new AccountStore({
    path: config.accountsPath,
    maxBytes: config.maxAccountsBytes,
    db,
  });
  const requests = new RequestStore({
    path: config.requestsPath,
    maxBytes: config.maxRequestsBytes,
    db,
  });
  const reviews = new ReviewStore({
    path: config.reviewsPath,
    maxBytes: config.maxReviewsBytes,
    db,
  });
  const publisherStore = new PublisherStore({
    path: config.storedPublishersPath,
    maxBytes: config.maxPublishersBytes,
    db,
  });
  // Package ownership claims: display-only maintainer identity derived from
  // provenance/approved requests plus verified claims (SESSION.md 21 A1).
  const ownership = new OwnershipStore({ path: config.ownershipPath });
  // Community -> maintainer support messages (A7): stored, rate-limited, and
  // notified as the `support` kind; separate from the report queue.
  const support = new SupportStore({ path: config.supportPath });
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
  const notifications = new NotificationStore({ db });
  // User administration (roles, suspension, audit) shares the platform
  // database. Config allowlists stay the bootstrap; stored grants add to them
  // and can never subtract (SESSION.md section 20).
  const admin = new AdminStore({ db });
  const configAdminLogins = new Set(config.oauth.adminLogins.map((login) => String(login).toLowerCase()));
  const configReviewerLogins = new Set(config.oauth.reviewerLogins.map((login) => String(login).toLowerCase()));
  // A4: the opt-in Sponsors badge state and the profile/board queries.
  const contributors = new ContributorStore({ db });
  // A5: package watches (account feed + release notices).
  const watches = new WatchStore({ db });
  // C1: artifact download counts (aggregated per version/day; no per-user
  // tracking). The salt is per-process: markers cannot be correlated across
  // restarts or days, which is the point.
  const stats = new DownloadStats({ db });

  // Audited display-stage overrides (SESSION.md 21.4): generated from the
  // publisher repo's STATUS.json files at a pinned commit and reviewed as a
  // PR, then applied here. Display-only -- never publish authorization,
  // scopes, readiness, or the index protocol. A real published stage always
  // wins; the override only fills entries that have none.
  const stageOverrideFile = loadStageOverrides({ path: config.stageOverridesPath });
  setStageOverrides(stageOverrideFile.overrides);
  for (const warning of stageOverrideFile.warnings) {
    console.warn(`xiom-registry: ${warning}`);
  }
  if (stageOverrideFile.overrides.size > 0) {
    const source = stageOverrideFile.source || {};
    const summary = `commit=${source.commit || 'unknown'} entries=${stageOverrideFile.overrides.size}`;
    const lastApplied = admin.recentAudit(50)
      .find((row) => row.action === 'stage.override.applied');
    if (!lastApplied || !String(lastApplied.detail).startsWith(summary)) {
      admin.audit({
        actor: { githubId: '0', login: 'system' },
        action: 'stage.override.applied',
        subjectType: 'config',
        subjectId: 'stage-overrides.json',
        detail: `${summary}${source.why ? ` - ${source.why}` : ''}`,
      });
    }
    console.log(`xiom-registry: stage overrides applied: ${summary}`);
  }
  const mailer = createMailer({ smtpUrl: config.smtpUrl, from: config.smtpFrom });
  const outbox = startOutbox({ notifications, mailer, registryUrl: config.registryUrl });
  console.log(
    mailer.enabled
      ? `xiom-registry: notification email enabled (from ${config.smtpFrom})`
      : 'xiom-registry: notification email disabled (SMTP_URL/SMTP_FROM unset) - in-app notices only',
  );

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

  // Hop count or allowlist, never `true`: a blanket trust lets clients spoof
  // X-Forwarded-For and rotate rate-limit buckets (ERR_ERL_PERMISSIVE_TRUST_PROXY).
  if (config.trustProxy !== false && config.trustProxy !== undefined) {
    app.set('trust proxy', config.trustProxy);
  }
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
  const roleFor = (account) => (isAdmin(account) ? 'admin' : (isReviewer(account) ? 'reviewer' : 'member'));

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
      // One click into GitHub, like the playground: the nav link starts the
      // OAuth round-trip directly (the /login page stays for explanations,
      // errors, and returnTo redirects) and comes back to where the user was.
      const returnTo = encodeURIComponent(req.originalUrl || req.path);
      return {
        primary: `<a class="nav-account nav-button nav-button-primary" href="/auth/github/start?returnTo=${returnTo}">Sign in</a>`,
        menu: '',
      };
    }
    // The session carries identity only (githubId + login); the avatar and
    // display name live in the stored account, so refresh from there. A
    // missing profile still renders the initial fallback.
    const stored = accounts.get(account.githubId) || account;
    const login = stored.login || account.login;
    const label = typeof stored.name === 'string' && stored.name.trim() !== ''
      ? stored.name.trim()
      : `@${login}`;
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
    const panel = [
      '<a href="/account">Overview</a>',
      '<a href="/account/feed">Feed</a>',
      '<a href="/account/requests">Requests</a>',
      '<a href="/account/notifications">Notifications</a>',
      '<a href="/account/settings">Settings</a>',
      isReviewer(account) ? '<a href="/review">Review queue</a>' : '',
      isAdmin(account) ? '<a href="/admin">Admin console</a>' : '',
      `<form method="post" action="/logout">
        <input type="hidden" name="csrf" value="${escapeHtml(req.session ? req.session.csrf : '')}">
        <button class="nav-account-signout" type="submit">Sign out</button>
      </form>`,
    ].filter(Boolean).join('\n        ');
    const avatarUrl = typeof stored.avatarUrl === 'string' && stored.avatarUrl.startsWith('https://')
      ? stored.avatarUrl
      : '';
    const avatar = avatarUrl
      ? `<img class="nav-avatar" src="${escapeHtml(avatarUrl)}" alt="" width="24" height="24" referrerpolicy="no-referrer">`
      : `<span class="nav-avatar nav-avatar--fallback" aria-hidden="true">${escapeHtml(login.slice(0, 1).toUpperCase())}</span>`;
    return {
      primary: `<details class="nav-account">
      <summary>${avatar}<span${current}>${escapeHtml(label)}</span></summary>
      <nav class="nav-account-panel" aria-label="Account">${panel}</nav>
    </details>`,
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

  /**
   * In-app notice (and optional email) for one account. Best-effort by
   * design: a notification failure must never fail the action that triggered
   * it (SESSION.md 22.4 A2). Structured kinds honour the account's per-kind
   * prefs; a muted kind writes no row and queues no email.
   *
   * @returns {boolean} true when a row was enqueued
   */
  function notifyAccount({ account, kind, subject, body = '', link = '', ref = '' }) {
    try {
      const stored = account && account.githubId ? accounts.get(account.githubId) : null;
      const prefs = stored ? stored.notifyKinds : null;
      if (prefs && prefs[kind] === false) return false;
      notifications.enqueue({
        account,
        kind,
        subject,
        body,
        link,
        ref,
        // D7 gate (SESSION.md 21.9.1): only a verified address may receive
        // notification email; in-app notices are unaffected.
        email: stored && stored.notifyEmailVerifiedAt ? stored.notifyEmail : '',
      });
      outbox.drain().catch(() => {});
      return true;
    } catch (err) {
      console.warn(
        `notification (${kind}) for ${account && account.login ? account.login : '?'} failed: ${err.message}`,
      );
      return false;
    }
  }

  /** In-app notice (and optional email) for the requester of an event. */
  function notifyRequester(request, kind, subject, body, link = '') {
    notifyAccount({ account: request.requester, kind, subject, body, link });
  }

  // Package-decision actions that notify the package's maintainers. `clear`
  // stays store-only: the console exposes the six independent toggles, which
  // is the A2 scope (SESSION.md 22.4); every decision is still audited.
  const DECISION_NOTIFY_SUBJECTS = Object.freeze({
    review: 'Package marked reviewed',
    unreview: 'Review mark removed',
    flag: 'Package flagged',
    unflag: 'Package unflagged',
    mute: 'Package muted',
    unmute: 'Package unmuted',
  });

  /**
   * Stored accounts of every maintainer of a package (derived + verified
   * claims), deduped by GitHub id. Maintainers without an account are
   * skipped: they cannot receive in-app notices.
   */
  function maintainerAccounts(name) {
    const pkg = indexStore.getPackage(name);
    if (!pkg) return [];
    const view = maintainerView({
      packageName: name,
      pkg,
      requests: requests.list(),
      publishers: publisherStore.list(),
      claims: ownership.claimsFor(name),
    });
    const seen = new Set();
    const result = [];
    for (const maintainer of view.maintainers) {
      const stored = accounts.getByLogin(maintainer.login);
      if (!stored || seen.has(stored.githubId)) continue;
      seen.add(stored.githubId);
      result.push(stored);
    }
    return result;
  }

  /**
   * A5: every watcher of a package learns about a new version. Best-effort
   * and bounded (watchersOf caps at 10k recipients); the per-account
   * `release` kind can be muted from settings. Bulk `/sync` imports
   * deliberately do not call this -- backfills are not releases.
   */
  function notifyWatchersOfRelease(result) {
    try {
      const stored = indexStore.getPackage(result.name) || {};
      const body = String(stored.description || '').slice(0, 200);
      for (const watcher of watches.watchersOf(result.name)) {
        notifyAccount({
          account: watcher,
          kind: 'release',
          subject: `New release: ${result.name} ${result.version}`,
          body,
          link: `/packages/${encodeURIComponent(result.name)}`,
          ref: `${result.name}@${result.version}`,
        });
      }
    } catch (err) {
      console.warn(`release notification for ${result.name} failed: ${err.message}`);
    }
  }

  /**
   * Notify every maintainer of a package who has a registry account after a
   * moderation decision. Best-effort, like every A2 notice.
   */
  function notifyPackageMaintainers(name, action, note = '') {
    const label = DECISION_NOTIFY_SUBJECTS[action];
    if (!label) return;
    try {
      for (const stored of maintainerAccounts(name)) {
        notifyAccount({
          account: stored,
          kind: 'review',
          subject: `${label}: ${name}`,
          body: note,
          link: `/packages/${encodeURIComponent(name)}`,
        });
      }
    } catch (err) {
      console.warn(`package decision notification for ${name} failed: ${err.message}`);
    }
  }

  const SUPPORT_TOPIC_LABELS = Object.freeze({
    question: 'Question',
    bug: 'Bug report',
    security: 'Security concern',
    other: 'Message',
  });

  // Error codes for the contact form round trip (the package page consumes the
  // flash, so this form reports through a query code instead).
  const SUPPORT_ERRORS = Object.freeze({
    invalid_reason: `topic must be one of: ${SUPPORT_REASONS.join(', ')}`,
    support_body_required: 'describe your question or issue before sending',
    support_rate_package: 'you already messaged the maintainers of this package today; wait for their reply',
    support_rate_account: 'you reached the daily limit for maintainer messages; try again tomorrow',
    invalid_package_name: 'that package name is not valid',
    no_maintainers: 'no maintainer of this package has a registry account yet; '
      + 'you can report the package to the moderators instead',
    support_failed: 'the message could not be sent; try again',
  });

  /** View-model for the contact-maintainers block on a package page (A7). */
  function packageSupportContext(req, name) {
    const account = accountOf(req);
    const recipients = account
      ? maintainerAccounts(name).filter((stored) => stored.githubId !== account.githubId)
      : maintainerAccounts(name);
    const errorCode = String(req.query.contact_error || '');
    return {
      signedIn: Boolean(account),
      recipients: recipients.length,
      reasons: SUPPORT_REASONS,
      csrf: req.session ? req.session.csrf : '',
      notice: typeof req.query.contacted === 'string'
        ? 'Message sent. The maintainers received a notification.'
        : '',
      error: SUPPORT_ERRORS[errorCode] || '',
    };
  }

  /** View-model for the report controls on a package page. */
  function packageReviewContext(req, name) {
    const account = accountOf(req);
    const flash = req.session && req.session.flash ? req.session.flash : null;
    if (flash) delete req.session.flash;
    const decision = reviews.decision(name);
    // A9 list UX: newest or most-helpful, text-only filter, 10 per page.
    const REVIEWS_PER_PAGE = 10;
    const page = reviews.ratingsPage(name, {
      sort: req.query.reviews_sort === 'helpful' ? 'helpful' : 'newest',
      textOnly: req.query.reviews_filter === 'text',
      page: Number(req.query.reviews_page) || 1,
      perPage: REVIEWS_PER_PAGE,
    });
    const viewerId = account ? account.githubId : '';
    const reviewIds = page.items.map((entry) => entry.githubId);
    const tallies = reviews.votesForPage(name, reviewIds, viewerId);
    const replies = reviews.repliesForPage(name, reviewIds);
    const ratings = page.items.map((entry) => ({
      ...entry,
      votes: tallies.get(entry.githubId) || { up: 0, down: 0, mine: 0 },
      reply: replies.get(entry.githubId) || null,
    }));
    const myRating = account
      ? reviews.ratingsFor(name).find((entry) => entry.githubId === account.githubId) || null
      : null;
    const canReply = Boolean(account) && (
      isAdmin(account)
      || maintainerAccounts(name).some((stored) => stored.githubId === account.githubId)
    );
    return {
      canReport: Boolean(account),
      canReview: isReviewer(account),
      canVote: Boolean(account),
      canReply,
      openReports: reviews.openReportCount(name),
      decision,
      history: decision ? decision.history : [],
      ratings,
      reviewList: {
        total: page.total,
        page: page.page,
        pages: page.pages,
        perPage: page.perPage,
        sort: page.sort,
        textOnly: page.textOnly,
      },
      summary: reviews.ratingSummary(name),
      myRating,
      csrf: req.session ? req.session.csrf : '',
      notice: typeof req.query.reported === 'string'
        ? 'Report submitted; a reviewer will take a look.'
        : (typeof req.query.decided === 'string'
          ? 'Review decision recorded.'
          : (typeof req.query.rated === 'string'
            ? 'Rating saved.'
            : (typeof req.query.claimed === 'string'
              ? 'Maintainer claim submitted; a reviewer will verify it.'
              : (typeof req.query.voted === 'string'
                ? 'Vote recorded.'
                : (typeof req.query.replied === 'string' ? 'Reply posted.' : ''))))),
      error: flash && flash.error ? flash.error : '',
    };
  }

  /**
   * View-model for the maintainers block on a package page. Derived entries
   * come from provenance and approved requests; stored claims add verified
   * names and (to the claimant/reviewers) pending ones. Display only: nothing
   * here can publish.
   */
  function packageOwnershipContext(req, name) {
    const account = accountOf(req);
    const pkg = indexStore.getPackage(name) || { versions: {} };
    return maintainerView({
      packageName: name,
      pkg,
      requests: requests.list(),
      publishers: publisherStore.list(),
      claims: ownership.claimsFor(name),
      viewer: account,
      reviewer: isReviewer(account),
    });
  }

  /** View-model for the watch control on a package page (A5). */
  function packageWatchContext(req, name) {
    const account = accountOf(req);
    const notice = typeof req.query.watched === 'string'
      ? (req.query.watched === '1'
        ? 'You are watching this package; new releases notify you.'
        : 'Stopped watching this package.')
      : '';
    return {
      signedIn: Boolean(account),
      watching: account ? watches.isWatching(account.githubId, name) : false,
      watchers: watches.countFor(name),
      csrf: req.session ? req.session.csrf : '',
      notice,
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
    for (const { name, reviewed, flagged, muted } of decisions) {
      if (!packages[name]) continue;
      const flags = {};
      if (flagged === true) flags.flagged = true;
      if (muted === true) flags.muted = true;
      if (reviewed === true && flagged !== true) flags.reviewed = true;
      if (Object.keys(flags).length === 0) continue;
      packages[name] = { ...packages[name], ...flags };
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

  /**
   * Exact bytes of the served index document (C5): /index.json sends them
   * and /index-digest.json signs them, so both must come from one source.
   */
  function indexDocumentBytes() {
    try {
      return fs.readFileSync(indexStore.indexPath);
    } catch {
      return Buffer.from(JSON.stringify(indexStore.snapshot(), null, 2), 'utf-8');
    }
  }

  // ─── Contributor profiles and Sponsors badge (A4) ─────────────────────────
  // The board and profiles read public data only: contribution counters from
  // the platform DB, maintainership from the index overlay. Ranking is the
  // capped, weighted score in src/contributors.js -- never raw volume.

  /**
   * C1: attach the aggregates a requested sort needs and nothing more. The
   * maps are computed once per request (single aggregate query each) and the
   * UI stays a pure function of them.
   */
  function withListingAggregates(listing) {
    if (listing.sort === 'downloads') {
      return { ...listing, downloadTotals: stats.totalsFor() };
    }
    if (listing.sort === 'rating') {
      return { ...listing, ratingSummaries: reviews.ratingSummaries() };
    }
    return listing;
  }

  /** Suspended and banned accounts are not ranked on the board. */
  function contributorBoard(limit = CONTRIBUTORS_LIMIT) {
    const maintainers = maintainerCounts(indexStore.snapshot(), {
      requests: requests.list(),
      publishers: publisherStore.list(),
      claims: ownership.listClaims(),
    });
    const rows = [];
    for (const counter of reviews.contributionCounts()) {
      const account = counter.login ? accounts.getByLogin(counter.login) : null;
      if (!account || accountStatus(account) !== 'active') continue;
      const counts = {
        reviews: counter.reviews,
        ratings: counter.ratings,
        replies: counter.replies,
        decisions: counter.decisions,
        packages: maintainers.get(account.login.toLowerCase()) || 0,
      };
      const score = contributorScore(counts);
      if (score <= 0) continue;
      const sponsor = contributors.sponsorOf(account.githubId);
      rows.push({
        login: account.login,
        score,
        counts,
        sponsor: sponsor.optedIn && sponsor.state === 'sponsor',
      });
    }
    rows.sort((a, b) => b.score - a.score || a.login.localeCompare(b.login));
    const capped = Math.max(1, Math.min(Number(limit) || CONTRIBUTORS_LIMIT, CONTRIBUTORS_LIMIT));
    return rows.slice(0, capped);
  }

  /** Everything the public profile renders, scoped to public data. */
  function profileData(account) {
    const maintained = maintainedPackages({
      login: account.login,
      githubId: account.githubId,
      index: publicIndex(),
      requests: requests.list(),
      publishers: publisherStore.list(),
      claims: ownership.listClaims(),
    }).filter((entry) => entry.sources.length > 0 || entry.claimStatus === 'verified');

    const ratings = reviews.ratingsBy(account.githubId, { limit: 100 });
    const written = ratings.filter((entry) => entry.review !== '').slice(0, 20);
    const counter = reviews.contributionCounts()
      .find((row) => row.githubId === account.githubId
        || (row.login && row.login.toLowerCase() === account.login.toLowerCase()));

    const decisions = reviews.decisionsBy(account.login, { limit: 20 })
      .map((entry) => ({ ...entry, action: `package ${entry.action}` }));
    // Verified claim decisions are already public on the package page;
    // rejected claims stay private to the claimant and reviewers.
    for (const claim of ownership.listClaims()) {
      if (!claim || claim.status !== 'verified') continue;
      if (String(claim.decidedBy || '').toLowerCase() !== account.login.toLowerCase()) continue;
      decisions.push({
        package: claim.package,
        action: 'claim verified',
        note: '',
        at: claim.decidedAt || '',
      });
    }
    decisions.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    return {
      maintained,
      reviews: written,
      ratingsTotal: counter ? counter.ratings : ratings.length,
      replies: reviews.repliesBy(account.githubId, { limit: 20 }),
      decisions: decisions.slice(0, 20),
    };
  }

  app.get('/', generalLimit, (req, res) => {
    const index = indexStore.snapshot();
    if (wantsHtml(req)) {
      return res.type('html').send(homePage(publicIndex(), { nav: accountNav(req) }));
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
      // D7: lets ops confirm the SMTP configuration without shell access.
      email: mailer.enabled ? 'enabled' : 'disabled',
    });
  });

  app.get('/index.json', generalLimit, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    // The exact bytes of the index document: /index-digest.json signs these,
    // so ops can compare `sha256sum data/index.json` with the published
    // digest. A missing file (freak deletion) falls back to the serialized
    // in-memory document so the two endpoints always agree.
    res.type('application/json').send(indexDocumentBytes());
  });

  // C5: the sidecar digest of the exact /index.json bytes, signed when
  // INDEX_SIGNING_KEY is configured. /index.json gains no fields.
  app.get('/index-digest.json', generalLimit, (req, res) => {
    res.set('Cache-Control', 'public, max-age=60').json(indexDigest({
      bytes: indexDocumentBytes(),
      registry: indexStore.snapshot().registry || config.registryUrl,
      signer: indexSigner,
    }));
  });

  // Release notes: the changelog rendered with the readme pipeline, with the
  // deployed version first so "am I on the latest?" is one glance.
  app.get('/whats-new', generalLimit, (req, res) => {
    res.type('html')
      .send(whatsNewPage({
        version: SERVICE_VERSION,
        changelogHtml: renderMarkdown(CHANGELOG_MD),
        nav: accountNav(req),
      }));
  });

  // ─── Publishing guide (registry 2.1) ──────────────────────────────────────
  // Nav "Publish" is registry-hosted: the guide is fetched from the repository
  // with a short cache and a bundled fallback, then rendered by the same
  // markdown pipeline as READMEs. git remains the source of truth via the
  // "View the source on GitHub" link (SESSION.md section 20).
  let publishingDocCache = { at: 0, markdown: '', source: 'bundled' };

  /** Read the bundled guide lazily; a missing file must never kill a request. */
  function readBundledGuide() {
    try {
      return fs.readFileSync(config.publishingBundledPath, 'utf-8');
    } catch {
      return '';
    }
  }

  async function publishingDoc() {
    if (publishingDocCache.markdown && Date.now() - publishingDocCache.at < PUBLISHING_DOC_TTL_MS) {
      return publishingDocCache;
    }
    const url = config.publishingDocUrl || PUBLISHING_DOC_DEFAULT_URL;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/plain', 'User-Agent': 'xiom-registry' },
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) {
        const markdown = await response.text();
        if (markdown.length > 50 && markdown.length < 512 * 1024) {
          publishingDocCache = { at: Date.now(), markdown, source: 'github', fetchedAt: new Date().toISOString() };
          return publishingDocCache;
        }
      }
    } catch {
      // Network, DNS, timeout: the bundled guide is authoritative enough.
    }
    const bundled = readBundledGuide();
    publishingDocCache = bundled.trim().length > 0
      ? { at: Date.now(), markdown: bundled, source: 'bundled', fetchedAt: '' }
      : { at: Date.now(), markdown: PUBLISHING_DOC_FALLBACK, source: 'fallback', fetchedAt: '' };
    return publishingDocCache;
  }

  app.get('/publish', generalLimit, async (req, res, next) => {
    try {
      const doc = await publishingDoc();
      res.type('html')
        .send(publishGuidePage({ ...doc, nav: accountNav(req) }));
    } catch (err) {
      next(err);
    }
  });

  // The old backlog path stays a valid link.
  app.get('/help/publishing', generalLimit, (req, res) => {
    res.redirect(301, '/publish');
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
    const listing = withListingAggregates(listingFromQuery(req.query));
    if (wantsHtml(req)) {
      return res.type('html')
        .send(packagesPage(index, { nav: accountNav(req), ...listing }));
    }
    const paged = paginatePackages(index, listing);
    res.json({
      packages: paged.names.map((name) => listingEntry(name, index.packages[name])),
      page: paged.page,
      per_page: paged.perPage,
      total: paged.total,
      total_pages: paged.totalPages,
      sort: paged.sort,
      category: paged.category,
      first_party: paged.firstParty,
      signed: paged.signed,
      stage: paged.stage,
      prerelease: paged.prerelease,
    });
  });

  // Category vocabulary with package counts: the browse/facet surface for
  // humans and agents (category names are registry-owned).
  app.get('/categories', generalLimit, (req, res) => {
    const index = publicIndex();
    if (wantsHtml(req)) {
      return res.type('html')
        .send(categoriesPage(index, { nav: accountNav(req) }));
    }
    res.json({ categories: categoryCounts(index) });
  });

  // Top-contributors board (A4): capped, weighted public contribution counts.
  app.get('/contributors', generalLimit, (req, res) => {
    const entries = contributorBoard();
    if (wantsHtml(req)) {
      return res.type('html')
        .send(contributorsPage({ entries, nav: accountNav(req) }));
    }
    res.json({
      contributors: entries.map(({ login, score, counts, sponsor }) => ({ login, score, counts, sponsor })),
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
    // C1: explicit stats request -> JSON regardless of Accept, so scripts and
    // badges have one stable endpoint. Counts only; no per-user data exists.
    if (req.query.stats === '1') {
      return res.set('Cache-Control', 'public, max-age=60')
        .json({ package: name, downloads: stats.forPackage(name) });
    }
    if (wantsHtml(req)) {
      const view = reviewedIndex();
      return res.type('html')
        .send(packagePage(view.packages[name] || pkg, view.registry, '', {
          nav: accountNav(req),
          readme: readmeFor(pkg),
          review: packageReviewContext(req, pkg.name),
          ownership: packageOwnershipContext(req, pkg.name),
          support: packageSupportContext(req, pkg.name),
          watch: packageWatchContext(req, pkg.name),
          activity: packageActivity({
            name: pkg.name,
            pkg: view.packages[name] || pkg,
            reviews,
            ownership,
          }),
          stats: stats.forPackage(pkg.name),
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
      return res.type('html')
        .send(packagePage(pkg, view.registry, version, {
          nav: accountNav(req),
          readme: readmeFor(pkg),
          review: packageReviewContext(req, pkg.name),
          ownership: packageOwnershipContext(req, pkg.name),
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
      // C1: count best-effort -- statistics must never break a download.
      try {
        stats.record({ package: name, version, ip: req.ip });
      } catch (err) {
        console.warn(`download stats for ${name}@${version} failed: ${err.message}`);
      }
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
    const facets = lifecycleFromQuery(req.query);
    const index = publicIndex();
    if (wantsHtml(req)) {
      return res.type('html')
        .send(searchPage(index, rawQuery, category, { nav: accountNav(req), ...facets }));
    }
    const results = searchPackages(index, rawQuery, category, facets)
      .map(({ name, pkg }) => listingEntry(name, pkg));
    res.json({
      query: rawQuery,
      category,
      stage: facets.stage,
      prerelease: facets.prerelease,
      results,
    });
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
      watches.rename(account.githubId, account.login);
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
      // The reverse view of the package Maintainers list: which packages this
      // account is listed for (provenance, approved requests, claims).
      maintained: maintainedPackages({
        login: context.account.login,
        githubId: context.account.githubId,
        index: indexStore.snapshot(),
        requests: requests.list(),
        publishers: publisherStore.list(),
        claims: ownership.listClaims(),
      }),
      // A4: the Sponsors badge state for the overview hero.
      sponsor: contributors.sponsorOf(context.account.githubId),
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
    const notice = req.query.read === '1'
      ? 'All notifications marked as read.'
      : (req.query.abuse === '1' ? 'Thank you. The moderators will review that message.' : '');
    res.type('html').send(accountNotificationsPage({
      ...context,
      notifications: notifications.listFor(context.account.githubId, { limit: 50 }),
      notice,
    }));
  });

  // Signed-in feed (A5): the merged public activity of watched packages.
  app.get('/account/feed', generalLimit, requireAccount, (req, res) => {
    const context = accountContext(req);
    const names = watches.packagesFor(context.account.githubId);
    res.type('html').send(accountFeedPage({
      ...context,
      entries: watchedFeed({ packages: names, index: publicIndex(), reviews, ownership }),
      watches: names,
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

  // A maintainer can flag a support message to the moderators (A7). The mark
  // on the message is idempotent; the first flag files one report into the
  // existing queue, so abuse handling stays in one place.
  app.post(
    '/account/notifications/:id/abuse',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireCsrf,
    (req, res, next) => {
      try {
        const actor = accountOf(req);
        const row = notifications.get(Number(req.params.id));
        if (!row || row.githubId !== actor.githubId || row.kind !== 'support' || !row.ref) {
          return res.redirect(303, '/account/notifications');
        }
        const flagged = support.markAbuse(row.ref, { actor });
        if (!flagged) return res.redirect(303, '/account/notifications');
        if (!flagged.alreadyReported) {
          try {
            reviews.createReport({
              packageName: flagged.message.package,
              reporter: actor,
              reason: 'spam',
              note: `Contact-channel abuse by @${flagged.message.requester.login}: ${flagged.message.body.slice(0, 300)}`,
            });
          } catch (err) {
            // The abuse mark is the record; a full report queue must not undo it.
            console.warn(`abuse report for ${flagged.message.id} not filed: ${err.message}`);
          }
        }
        return res.redirect(303, '/account/notifications?abuse=1');
      } catch (err) {
        return next(err);
      }
    },
  );

  app.get('/account/settings', generalLimit, requireAccount, (req, res) => {
    const context = accountContext(req);
    const { account } = context;
    const sponsorState = contributors.sponsorOf(account.githubId);
    const sponsorNotices = {
      on: 'Sponsors badge saved. When GitHub confirms a public sponsors listing, the badge appears on your profile.',
      off: 'Sponsors badge turned off and the cached check cleared.',
      sponsor: 'GitHub confirmed a public sponsors listing: the badge is live on your profile.',
      not: 'GitHub reports no public sponsors listing for your account yet. Create one at github.com/sponsors, then refresh.',
      unknown: 'The GitHub Sponsors check did not answer; the badge stays unverified. Try again later.',
      disabled: 'Sponsors checks are not configured on this registry, so the badge stays unverified.',
    };
    const notice = typeof req.query.sponsors === 'string' && sponsorNotices[req.query.sponsors]
      ? sponsorNotices[req.query.sponsors]
      : (req.query.prefs === '1'
        ? 'Notification preferences saved.'
        : (req.query.email === '1'
          ? (account.notifyEmail && !account.notifyEmailVerifiedAt
            ? 'Notification email saved. Open the confirmation link we sent it before email delivery starts.'
            : 'Notification email saved.')
          : (req.query.verified === '1'
            ? 'Notification email verified.'
            : (req.query.verified === '0'
              ? 'That confirmation link is not valid or has expired. Save the address again for a new link.'
              : ''))));
    res.type('html').send(accountSettingsPage({
      ...context,
      notifyEmail: account.notifyEmail || '',
      notifyEmailVerified: Boolean(account.notifyEmail && account.notifyEmailVerifiedAt),
      notifyEmailPending: Boolean(
        account.notifyEmail && !account.notifyEmailVerifiedAt
        && account.notifyEmailTokenHash && account.notifyEmailTokenExpires,
      ),
      notifyKinds: account.notifyKinds,
      sponsor: sponsorState,
      sponsorCheckEnabled: Boolean(config.sponsors.token),
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
        const actor = accountOf(req);
        const saved = accounts.setNotifyEmail(actor.githubId, raw);
        if (raw.trim() !== '' && saved === '') {
          req.session.flash = { error: 'that email address does not look valid' };
          return res.redirect(303, '/account/settings');
        }
        if (saved !== '') {
          // D7 double opt-in (SESSION.md 21.9.1): queue the confirmation link.
          // This is the one pending email allowed to an unverified address --
          // it is the proof of control, and ordinary notices stay gated until
          // the link is opened. Best-effort: saving the address must succeed
          // even when the outbox cannot record the notice.
          try {
            const verification = accounts.ensureEmailVerification(actor.githubId);
            if (verification.created) {
              notifications.enqueue({
                account: actor,
                kind: 'verify-email',
                subject: 'Confirm your notification email',
                body: `Open the link within 24 hours to start receiving notification email at ${saved}.`,
                link: `/account/verify-email?token=${encodeURIComponent(verification.token)}`,
                email: saved,
              });
              outbox.drain().catch(() => {});
            }
          } catch (err) {
            console.warn(`email verification notice for @${actor.login} failed: ${err.message}`);
          }
        }
        return res.redirect(303, '/account/settings?email=1');
      } catch (err) {
        return next(err);
      }
    },
  );

  // Confirmation link target for the notification email (D7). The token is
  // bound to the signed-in account, single-use, and expires after 24 hours.
  app.get('/account/verify-email', generalLimit, requireAccount, (req, res, next) => {
    try {
      const result = accounts.verifyEmail(accountOf(req).githubId, String(req.query.token || ''));
      return res.redirect(303, `/account/settings?verified=${result === 'verified' ? '1' : '0'}`);
    } catch (err) {
      return next(err);
    }
  });

  // Public contributor profile (A4). Registered after every static /account
  // route so `/account/requests` & co. keep winning; unknown logins are a
  // plain 404. Renders public data only.
  app.get('/account/:login', generalLimit, (req, res) => {
    const requested = String(req.params.login || '').trim();
    const account = /^[A-Za-z0-9-]{1,64}$/.test(requested) ? accounts.getByLogin(requested) : null;
    if (!account) {
      if (wantsHtml(req)) {
        return res.status(404).type('html')
          .send(notFoundPage(`No account "@${requested}" was found.`, { nav: accountNav(req) }));
      }
      throw new NotFoundError(`account "@${requested}" not found`, 'account_not_found');
    }
    const viewer = accountOf(req);
    const sponsorState = contributors.sponsorOf(account.githubId);
    const sponsor = sponsorState.optedIn && sponsorState.state === 'sponsor';
    const data = profileData(account);
    if (wantsHtml(req)) {
      return res.type('html').send(profilePage({
        account,
        role: roleFor(account),
        sponsor,
        isSelf: Boolean(viewer && viewer.githubId === account.githubId),
        ...data,
        nav: accountNav(req),
      }));
    }
    res.json({
      login: account.login,
      name: account.name,
      joined: account.createdAt,
      sponsor,
      maintained: data.maintained.map((entry) => entry.name),
      reviews: data.reviews,
      replies: data.replies,
      decisions: data.decisions,
    });
  });

  // Per-kind notification preferences (SESSION.md 22.4 A2, extended by A5).
  // Checkboxes: a present field means on, an absent one means muted; the
  // store re-applies the allowlist so only known kinds are stored. In-app
  // rows and emails for a muted kind are both suppressed.
  app.post(
    '/account/notify-kinds',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireCsrf,
    (req, res, next) => {
      try {
        accounts.setNotifyKinds(accountOf(req).githubId, {
          claim: Boolean(req.body.claim),
          report: Boolean(req.body.report),
          review: Boolean(req.body.review),
          support: Boolean(req.body.support),
          'review-reply': Boolean(req.body['review-reply']),
          release: Boolean(req.body.release),        });
        return res.redirect(303, '/account/settings?prefs=1');
      } catch (err) {
        return next(err);
      }
    },
  );

  // Opt-in GitHub Sponsors badge (A4). The registry stores only the opt-in
  // and the cached public `hasSponsorsListing` answer; it handles no money.
  // `refresh=1` re-runs the check for an already opted-in account.
  app.post(
    '/account/sponsors',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    async (req, res, next) => {
      try {
        const actor = accountOf(req);
        const stored = accounts.get(actor.githubId) || actor;
        if (req.body.badge !== '1') {
          contributors.setSponsorOptIn(stored.githubId, stored.login, false);
          return res.redirect(303, '/account/settings?sponsors=off');
        }
        contributors.setSponsorOptIn(stored.githubId, stored.login, true);
        if (!config.sponsors.token) {
          return res.redirect(303, '/account/settings?sponsors=disabled');
        }
        const state = await checkSponsorListing({
          login: stored.login,
          token: config.sponsors.token,
          apiUrl: config.sponsors.apiUrl,
        });
        if (state === 'unknown') {
          return res.redirect(303, '/account/settings?sponsors=unknown');
        }
        contributors.recordSponsorCheck(stored.githubId, state);
        return res.redirect(303, `/account/settings?sponsors=${state === 'sponsor' ? 'sponsor' : 'not'}`);
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

  // B4/B5: owner-facing changes to something already granted. The owner
  // asks; an admin executes from the queue, so these routes create requests
  // only. Ownership is checked against the target request -- never trusted
  // from the URL -- and the store refuses a target that already has a
  // pending change.
  function ownGrant(req, requestId, kind, statuses = ['approved', 'fulfilled']) {
    const account = accountOf(req);
    let record = null;
    try {
      record = requests.get(String(requestId));
    } catch {
      return null;
    }
    if (!record || record.kind !== kind) return null;
    if (record.requester.githubId !== account.githubId) return null;
    if (!statuses.includes(record.status)) return null;
    return record;
  }

  function changeTargetOrRedirect(req, res, kind, statuses) {
    const target = ownGrant(req, req.params.id, kind, statuses);
    if (!target) {
      req.session.flash = {
        error: 'No grant of yours matches that request id, or it is not in a changeable state.',
      };
      res.redirect(303, '/account/requests');
      return null;
    }
    return target;
  }

  app.post(
    '/account/publishers/:id/edit',
    writeLimit,
    express.urlencoded({ extended: false, limit: '64kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const target = changeTargetOrRedirect(req, res, 'publisher');
      if (!target) return;
      try {
        const account = accountOf(req);
        const created = requests.create({
          kind: 'publisher-edit',
          requester: { githubId: account.githubId, login: account.login },
          targetRequestId: target.id,
          repository: String(req.body.repository || ''),
          workflow: String(req.body.workflow || ''),
          refs: String(req.body.refs || ''),
          scopes: String(req.body.scopes || ''),
          note: String(req.body.note || ''),
        });
        return res.redirect(303, `/account/requests?created=${encodeURIComponent(created.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/account/requests');
        }
        return next(err);
      }
    },
  );

  app.post(
    '/account/publishers/:id/revoke',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const target = changeTargetOrRedirect(req, res, 'publisher');
      if (!target) return;
      try {
        const account = accountOf(req);
        const created = requests.create({
          kind: 'publisher-revoke',
          requester: { githubId: account.githubId, login: account.login },
          targetRequestId: target.id,
          // Copied from the grant so the queue row shows exactly what goes.
          repository: target.repository,
          workflow: target.workflow,
          refs: target.refs,
          scopes: target.scopes,
          note: String(req.body.note || ''),
        });
        return res.redirect(303, `/account/requests?created=${encodeURIComponent(created.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/account/requests');
        }
        return next(err);
      }
    },
  );

  app.post(
    '/account/tokens/:id/rotate',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      // Rotation only makes sense once a token exists (fulfilled), not for a
      // still-pending approval.
      const target = changeTargetOrRedirect(req, res, 'token', ['fulfilled']);
      if (!target) return;
      try {
        const account = accountOf(req);
        const created = requests.create({
          kind: 'token-rotation',
          requester: { githubId: account.githubId, login: account.login },
          targetRequestId: target.id,
          scopes: target.scopes,
          note: String(req.body.note || ''),
        });
        return res.redirect(303, `/account/requests?created=${encodeURIComponent(created.id)}`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError) {
          req.session.flash = { error: err.message };
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
        ownershipClaims: ownership.pendingCount(),
      },
      email: {
        enabled: mailer.enabled,
        counts: notifications.outboxCounts(),
        failures: notifications.recentEmailFailures(3),
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
        if (filter === 'undecided') {
          return !decision
            || (decision.reviewed !== true && decision.flagged !== true && decision.muted !== true);
        }
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
        const name = String(req.params.name).toLowerCase();
        reviews.setDecision(name, {
          action,
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
        notifyPackageMaintainers(name, action, String(req.body.note || ''));
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

  app.get('/admin/claims', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    const decided = ownership.listClaims().filter((claim) => claim.status !== 'pending').slice(0, 20);
    res.type('html').send(adminClaimsPage({
      ...context,
      pending: ownership.listClaims({ status: 'pending' }),
      decided,
    }));
  });

  app.get('/admin/reports', generalLimit, requireAdminPage, (req, res) => {
    const context = adminPageContext(req);
    const filter = ['open', 'resolved', 'dismissed'].includes(String(req.query.filter))
      ? String(req.query.filter)
      : '';
    const paged = reviews.reportsPage({ status: filter, ...adminPaging(req.query) });
    res.type('html').send(adminReportsPage({
      ...context,
      reports: paged.reports,
      paged,
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
        const updated = reviews.resolveReport(String(req.params.id), {
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
        notifyAccount({
          account: updated.reporter,
          kind: 'report',
          subject: updated.status === 'resolved' ? 'Your report was resolved' : 'Your report was dismissed',
          body: `Your report on ${updated.package} was ${updated.status}: ${updated.resolution}`,
          link: `/packages/${encodeURIComponent(updated.package)}`,
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
      viewerIsConfigAdmin: isConfigAdmin(accountOf(req)),
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
      viewerIsConfigAdmin: isConfigAdmin(accountOf(req)),
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
        // Hierarchy (owner, 2026-09-27): the founding administrators come from
        // the deployment config and sit above granted admins; only they may
        // change an admin or grant the role, so a granted admin can never
        // demote or ban a peer or the founder.
        const actorIsConfigAdmin = isConfigAdmin(accountOf(req));
        if (!actorIsConfigAdmin && target.githubId !== actor.githubId && isAdmin(target)) {
          throw new ConflictError(
            'only a founding administrator can change an admin account',
            'admin_peer_protected',
          );
        }
        if (!actorIsConfigAdmin && role === 'admin') {
          throw new ConflictError(
            'only a founding administrator can grant admin',
            'admin_grant_protected',
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
        if (!isConfigAdmin(actor) && target.githubId !== actor.githubId && isAdmin(target)) {
          throw new ConflictError(
            'only a founding administrator can change an admin account',
            'admin_peer_protected',
          );
        }
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
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const paged = admin.auditPage({ ...adminPaging(req.query), action, actor: q });
    res.type('html').send(adminAuditPage({
      ...context,
      entries: paged.entries,
      paged,
      action,
      q,
      actions: admin.auditActions(),
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
        if (request.kind === 'publisher-revoke' && action === 'approve') {
          // B4: execute the owner's revocation request against the live entry
          // it targets, then close both records with the audit trail.
          const target = requests.get(request.targetRequestId);
          publisherStore.remove(target.id);
          config.publishers = config.publishers.filter((entry) => entry.requestId !== target.id);
          requests.revoke(target.id, { actor, note: `revoked via request ${request.id}` });
          requests.decide(request.id, { action, actor, note });
          updated = requests.fulfil(request.id, {
            actor,
            reference: `trusted publisher revoked (${target.repository} / ${target.workflow})`,
          });
          notifyRequester(
            request,
            'publisher-revoked',
            'Trusted publisher revoked',
            `${target.repository} / ${target.workflow} is no longer accepted.`,
          );
          console.log(`Trusted publisher ${target.repository} / ${target.workflow} revoked via ${request.id} by ${actor}`);
        } else if (request.kind === 'publisher-edit' && action === 'approve') {
          // B4: apply the approved change to the live entry and to the running
          // config. PublisherStore.update keeps the original approval and
          // refuses a clash with another entry.
          const target = requests.get(request.targetRequestId);
          const entry = publisherStore.update(target.id, {
            repository: request.repository,
            workflow: request.workflow,
            refs: request.refs,
            scopes: request.scopes,
          });
          config.publishers = config.publishers
            .map((existing) => (existing.requestId === target.id ? entry : existing));
          requests.decide(request.id, { action, actor, note });
          updated = requests.fulfil(request.id, {
            actor,
            reference: `trusted publisher updated (${entry.repository} / ${entry.workflow})`,
          });
          notifyRequester(
            request,
            'publisher-approved',
            'Trusted publisher updated',
            `${entry.repository} / ${entry.workflow} is live with the new settings.`,
          );
          console.log(`Trusted publisher entry for ${target.id} updated via ${request.id} by ${actor}`);
        } else if (request.kind === 'publisher' && action === 'approve') {
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
              request.kind === 'token-rotation' ? 'Token rotation approved' : 'Token request approved',
              request.kind === 'token-rotation'
                ? 'The maintainers will mint the replacement token on the host and deliver it privately.'
                : 'The maintainers will mint your token on the host and deliver it privately.',
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

  // A9: one vote per account per review, toggled by casting the same value
  // again; the review author cannot vote on their own review.
  app.post(
    '/packages/:name/reviews/:githubId/vote',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const { name, githubId } = req.params;
      try {
        if (!indexStore.getPackage(name)) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        reviews.vote(name, githubId, {
          voter: accountOf(req),
          value: req.body.value === 'down' ? -1 : 1,
        });
        res.redirect(303, `/packages/${encodeURIComponent(name)}?voted=1#reviews`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/packages/${encodeURIComponent(name)}#reviews`);
        }
        return next(err);
      }
    },
  );

  // A9: one flat maintainer reply per review; posting it notifies the review
  // author on the new muteable `review-reply` kind.
  app.post(
    '/packages/:name/reviews/:githubId/reply',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const name = String(req.params.name).toLowerCase();
      const back = `/packages/${encodeURIComponent(name)}`;
      try {
        if (!indexStore.getPackage(name)) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        const actor = accountOf(req);
        const allowed = isAdmin(actor)
          || maintainerAccounts(name).some((stored) => stored.githubId === actor.githubId);
        if (!allowed) {
          throw new ForbiddenError('only the package maintainers can reply here', 'reply_forbidden');
        }
        const review = reviews.ratingsFor(name)
          .find((entry) => entry.githubId === String(req.params.githubId));
        if (!review) {
          throw new NotFoundError('that review was not found', 'review_not_found');
        }
        const reply = reviews.replyTo(name, req.params.githubId, {
          author: actor,
          body: String(req.body.message || ''),
        });
        console.log(`Maintainer reply on ${name} review by ${review.login} (${reply.author.login})`);
        if (review.githubId !== actor.githubId) {
          notifyAccount({
            account: { githubId: review.githubId, login: review.login },
            kind: 'review-reply',
            subject: `Maintainer replied to your review of ${name}`,
            body: reply.body,
            link: `${back}#reviews`,
          });
        }
        res.redirect(303, `${back}?replied=1#reviews`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError
          || err instanceof ForbiddenError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `${back}#reviews`);
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

  // Community -> maintainer contact (A7, SESSION.md 21.9.2): package-scoped,
  // signed-in, and rate-limited. Deliberately separate from the report queue:
  // reports are unverified allegations handled by moderators and never routed
  // to the maintainer they may be about.
  app.post(
    '/packages/:name/contact',
    writeLimit,
    express.urlencoded({ extended: false, limit: '32kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const name = String(req.params.name).toLowerCase();
      const back = `/packages/${encodeURIComponent(name)}`;
      try {
        if (!indexStore.getPackage(name)) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        const sender = accountOf(req);
        const recipients = maintainerAccounts(name)
          .filter((stored) => stored.githubId !== sender.githubId);
        if (recipients.length === 0) {
          return res.redirect(303, `${back}?contact_error=no_maintainers#contact`);
        }
        const message = support.create({
          packageName: name,
          requester: sender,
          reason: String(req.body.reason || ''),
          body: String(req.body.message || ''),
        });
        console.log(`Support message ${message.id} on ${name} by ${message.requester.login}`);
        for (const stored of recipients) {
          notifyAccount({
            account: stored,
            kind: 'support',
            subject: `Support request: ${name}`,
            body: `${SUPPORT_TOPIC_LABELS[message.reason] || 'Message'}: ${message.body}`,
            link: `${back}#contact`,
            ref: message.id,
          });
        }
        return res.redirect(303, `${back}?contacted=1#contact`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
          const code = SUPPORT_ERRORS[err.code] ? err.code : 'support_failed';
          return res.redirect(303, `${back}?contact_error=${encodeURIComponent(code)}#contact`);
        }
        return next(err);
      }
    },
  );

  // Follow/unfollow a package (A5). Toggle semantics: the same action flips
  // the state, so one button is enough. The count is public; the watch itself
  // only powers the personal feed and release notices.
  app.post(
    '/packages/:name/watch',
    writeLimit,
    express.urlencoded({ extended: false, limit: '8kb' }),
    requireLogin,
    requireWriteAccess,
    requireCsrf,
    (req, res, next) => {
      const name = String(req.params.name).toLowerCase();
      const back = `/packages/${encodeURIComponent(name)}`;
      try {
        if (!indexStore.getPackage(name)) {
          throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
        }
        const account = accounts.get(accountOf(req).githubId) || accountOf(req);
        if (watches.isWatching(account.githubId, name)) {
          watches.unwatch(account.githubId, name);
          console.log(`Unwatch: ${account.login} stopped following ${name}`);
          return res.redirect(303, `${back}?watched=0#watch`);
        }
        try {
          watches.watch(account.githubId, account.login, name);
        } catch (err) {
          if (err && err.code === 'watch_limit') {
            throw new BadRequestError(err.message, 'watch_limit');
          }
          throw err;
        }
        console.log(`Watch: ${account.login} follows ${name}`);
        return res.redirect(303, `${back}?watched=1#watch`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `${back}#watch`);
        }
        return next(err);
      }
    },
  );

  // Maintainer claim: identity for display only; a reviewer verifies or
  // rejects it from the review queue. Never grants publish power.
  app.post(
    '/packages/:name/claim',
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
        const claim = ownership.claim(name, { user: accountOf(req) });
        console.log(`Ownership claim on ${name} by ${claim.login}`);
        res.redirect(303, `/packages/${encodeURIComponent(name)}?claimed=1#maintainers`);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, `/packages/${encodeURIComponent(name)}#maintainers`);
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
      claims: ownership.listClaims({ status: 'pending' }),
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
        const record = reviews.setDecision(name, {
          action,
          actor: accountOf(req).login,
          note: String(req.body.note || ''),
        });
        console.log(`Package ${name} decision: ${action} by ${accountOf(req).login}`);
        notifyPackageMaintainers(String(name).toLowerCase(), action, String(req.body.note || ''));
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
        notifyAccount({
          account: updated.reporter,
          kind: 'report',
          subject: updated.status === 'resolved' ? 'Your report was resolved' : 'Your report was dismissed',
          body: `Your report on ${updated.package} was ${updated.status}: ${updated.resolution}`,
          link: `/packages/${encodeURIComponent(updated.package)}`,
        });
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

  // Reviewer decision on a maintainer claim (verify or reject with a reason).
  app.post(
    '/review/claims/:name/:githubId/decision',
    writeLimit,
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireReviewer,
    requireCsrf,
    (req, res, next) => {
      try {
        const name = String(req.params.name).toLowerCase();
        const claim = ownership.decide(name, req.params.githubId, {
          actor: accountOf(req).login,
          status: String(req.body.status || ''),
          note: String(req.body.note || ''),
        });
        console.log(`Ownership claim for ${name} ${claim.status} by ${claim.decidedBy}`);
        notifyAccount({
          account: { githubId: claim.githubId, login: claim.login },
          kind: 'claim',
          subject: claim.status === 'verified' ? 'Maintainer claim verified' : 'Maintainer claim rejected',
          body: claim.status === 'verified'
            ? `You are listed as a verified maintainer of ${name}.`
            : `Your maintainer claim for ${name} was rejected.${claim.note ? ` Reason: ${claim.note}` : ''}`,
          link: `/packages/${encodeURIComponent(name)}#maintainers`,
        });
        const back = req.body.next === '/admin/claims'
          ? `/admin/claims?claim=${encodeURIComponent(req.params.githubId)}`
          : `/review?claim=${encodeURIComponent(req.params.githubId)}#ownership`;
        res.redirect(303, back);
      } catch (err) {
        if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
          req.session.flash = { error: err.message };
          return res.redirect(303, '/review#ownership');
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

  app.post('/publish', writeLimit, authenticated, handleUpload, async (req, res, next) => {
    try {
      const result = publish(req, { config, indexStore, artifacts, token: req.token });
      // C2: no publisher-supplied attestation? Ask GitHub by subject digest,
      // best-effort. A miss, a timeout, or a missing token never affects the
      // publish; a hit is stored next to the provenance and rendered.
      let attestation = result.attestation;
      if (!attestation && result.publisher && config.attestations) {
        attestation = await discoverAttestation({
          repository: result.publisher.repository,
          sha256: result.sha256,
          token: config.attestations.token,
          apiUrl: config.attestations.apiUrl,
        });
        if (attestation) {
          try {
            indexStore.setAttestation(result.name, result.version, attestation);
          } catch (err) {
            console.warn(`attestation for ${result.name}@${result.version} not stored: ${err.message}`);
            attestation = '';
          }
        }
      }
      notifyWatchersOfRelease(result);
      res.status(201).json({
        ok: true,
        package: result.name,
        version: result.version,
        sha256: result.sha256,
        signature: result.signature || undefined,
        publicKey: result.publicKey || undefined,
        ...(result.publisher ? { publisher: result.publisher } : {}),
        ...(attestation ? { attestation } : {}),
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        message: `Successfully published ${result.name}@${result.version}`,
      });
    } catch (err) {
      cleanupAndNext(req, res, next, err);
    }
  });

  // Read-only preflight (Track B3, registry side): the exact publish checks
  // -- name, semver, scope, namespace, version conflicts, signature rules,
  // manifest, and every publish warning -- with no artifact store and no
  // index write. The upload is always removed. Status codes and the body
  // shape mirror /publish (minus `ok`), so a client dry-run can treat this
  // exactly like the real thing.
  app.post('/validate', writeLimit, authenticated, handleUpload, (req, res, next) => {
    try {
      const prepared = preparePublish(req, { config, indexStore, token: req.token });
      prepared.removeUpload();
      res.json({
        ok: true,
        package: prepared.name,
        version: prepared.version,
        sha256: prepared.sha256,
        size: prepared.size,
        signature: prepared.signature || undefined,
        publicKey: prepared.publicKey || undefined,
        ...(prepared.publisher ? { publisher: prepared.publisher } : {}),
        ...(prepared.attestation ? { attestation: prepared.attestation } : {}),
        ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
        message: `${prepared.name}@${prepared.version} would publish; nothing was written`,
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
    ownership,
    support,
    contributors,
    watches,
    stats,
    sessions,
  };
  return app;
}

/**
 * The shared publish pipeline: every validation, cheapest-first, so hostile
 * traffic is rejected before any hashing or disk writes. It stops before the
 * writes: `publish()` completes it; the read-only `POST /validate` dry-run
 * ends here. The caller owns the staged upload; on success paths it must
 * call `removeUpload()` unless it stores the artifact.
 *
 * @returns {{ name: string, version: string, sha256: string, signature: string,
 *             publicKey: string, size: number, metadata: object, warnings: string[],
 *             publisher: object|undefined, attestation: string,
 *             staged: string, removeUpload: Function }}
 */
function preparePublish(req, { config, indexStore, token }) {
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
  // C2: a publisher may hand us the GitHub attestation URL for the tarball.
  // Validate hard -- this lands in /index.json and is rendered as a link --
  // and only attach it when there is provenance to attach it to.
  const suppliedAttestation = typeof req.body?.attestation === 'string'
    ? req.body.attestation.trim()
    : '';
  if (suppliedAttestation) {
    if (!token.publisher) {
      throw new BadRequestError(
        'attestation requires OIDC provenance; publish with a trusted publisher instead',
        'attestation_without_provenance',
      );
    }
    if (!isAttestationUrl(suppliedAttestation)) {
      throw new BadRequestError(
        'attestation must be a https://github.com/<owner>/<repo>/attestations/<id> URL',
        'bad_attestation',
      );
    }
    metadata.publisher = { ...metadata.publisher, attestation: suppliedAttestation };
  }
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
  // Maturity backstop (packages-lane relay, 2026-09-28): the packages pipeline
  // now writes the real stage from STATUS.json (incubating|stable), and the
  // registry shows maturity from this field. Warn at the source when it is
  // missing or contradicts a pre-release version; nothing blocks the publish.
  if (!packageMeta.stage) {
    warnings.push(
      'no stage declared; set "stage": "incubating" or "stable" in package.xi '
      + '(the registry shows maturity from this field)',
    );
  } else if (packageMeta.stage === 'stable' && semver.prerelease(version) !== null) {
    warnings.push(
      `stage "stable" with the pre-release version ${version}; `
      + 'use stage "incubating" or publish a stable version',
    );
  }

  return {
    name,
    version,
    sha256,
    signature,
    publicKey,
    size: fileBuffer.length,
    metadata,
    warnings,
    publisher: token.publisher,
    attestation: metadata.publisher ? metadata.publisher.attestation || '' : '',
    staged,
    removeUpload,
  };
}

/**
 * Publish: run the shared validation pipeline, then store the artifact and
 * index the version. `preparePublish` owns every check; this wrapper owns
 * the writes (and the artifact rollback when indexing fails).
 */
function publish(req, { config, indexStore, artifacts, token }) {
  const prepared = preparePublish(req, { config, indexStore, token });
  const { name, version, metadata, staged } = prepared;

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
    `Published: ${name}@${version} (${(prepared.size / 1024).toFixed(1)} KB, `
    + `sha256:${prepared.sha256.slice(0, 12)}..., by ${token.label}`
    + `${token.publisher ? ` via ${token.publisher.repository}` : ''})`,
  );
  return {
    name,
    version,
    sha256: prepared.sha256,
    signature: prepared.signature,
    publicKey: prepared.publicKey,
    warnings: prepared.warnings,
    publisher: prepared.publisher,
    attestation: prepared.attestation,
  };
}

module.exports = { createApp, publish, computeLatest };
