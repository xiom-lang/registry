// XIOM Package Registry -- index store (data/index.json).
// Copyright (c) 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const fs = require('fs');
const path = require('path');
const semver = require('semver');

const { ConflictError, IndexLimitError, NotFoundError, BadRequestError } = require('./errors');
const { validateTokenKey } = require('./signatures');

const INDEX_SCHEMA_VERSION = '1.0.0';

/**
 * In-memory index with write-through persistence.
 *
 * On-disk shape (the schema the client accepts, SESSION.md section 2.2):
 * {
 *   "version": "1.0.0",
 *   "packages": {
 *     "<name>": {
 *       "name", "description", "repository", "latest",
 *       "versions": {
 *         "<version>": {
 *           "version", "sha256", "signature", "publicKey", "size",
 *           "published", "dependencies", "yanked"?, "compiler"?
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * Legacy entries (version arrays, `download_url` seeding from /sync) are
 * normalized on read so old data keeps working; every write emits the
 * object form.
 */
class IndexStore {
  /**
   * @param {{ indexPath: string, maxIndexPackages: number, maxIndexBytes: number,
   *           maxVersionsPerPackage: number }} config
   */
  constructor(config) {
    this.indexPath = config.indexPath;
    this.maxIndexPackages = config.maxIndexPackages;
    this.maxIndexBytes = config.maxIndexBytes;
    this.maxVersionsPerPackage = config.maxVersionsPerPackage;
    this.registryUrl = config.registryUrl || '';
    this.index = this.#readFromDisk();
  }

  #emptyIndex() {
    return { registry: this.registryUrl, version: INDEX_SCHEMA_VERSION, packages: {} };
  }

  #readFromDisk() {
    if (!fs.existsSync(this.indexPath)) return this.#emptyIndex();
    let raw;
    try {
      raw = fs.readFileSync(this.indexPath, 'utf-8');
    } catch (err) {
      throw new Error(`cannot read index ${this.indexPath}: ${err.message}`);
    }
    if (raw.trim() === '') return this.#emptyIndex();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`index ${this.indexPath} is corrupt JSON: ${err.message}`);
    }
    return normalizeIndex(parsed, this.registryUrl);
  }

  /** Full index (live reference; callers must not mutate). */
  snapshot() {
    return this.index;
  }

  getPackage(name) {
    return this.index.packages[name];
  }

  /** @throws NotFoundError */
  requirePackage(name) {
    const pkg = this.getPackage(name);
    if (!pkg) throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
    return pkg;
  }

  /** @throws NotFoundError */
  requireVersion(name, version) {
    const pkg = this.requirePackage(name);
    const entry = pkg.versions[version];
    if (!entry) {
      throw new NotFoundError(
        `version "${version}" of "${name}" not found`,
        'version_not_found',
      );
    }
    return entry;
  }

  /**
   * Immutable publish: insert a new version, recompute `latest`, persist.
   * Republishing an existing version is a ConflictError (SESSION.md 2.5).
   *
   * @param {string} name
   * @param {object} metadata complete version metadata
   * @returns {object} the stored version entry
   */
  publishVersion(name, metadata) {
    validateTokenKey(metadata.signature, metadata.publicKey);
    // The version is used as a computed object key below; require a valid
    // semver (a faithful, explicit sanitizer: `__proto__`, `constructor`,
    // and every other non-semver string are rejected here).
    if (!semver.valid(metadata.version)) {
      throw new BadRequestError(
        `invalid version "${metadata.version}": must be valid semver`,
        'invalid_version',
      );
    }
    const pkg = this.index.packages[name];
    if (pkg && pkg.versions[metadata.version]) {
      throw new ConflictError(
        `version ${metadata.version} of ${name} already exists; `
        + 'versions are immutable (yank it instead: POST /packages/'
        + `${name}/${metadata.version}/yank)`,
        'version_exists',
      );
    }
    if (!pkg && Object.keys(this.index.packages).length >= this.maxIndexPackages) {
      throw new IndexLimitError(
        `registry index is full (${this.maxIndexPackages} packages); `
        + 'contact the maintainers',
        'index_full',
      );
    }
    const versionCount = pkg ? Object.keys(pkg.versions).length : 0;
    if (versionCount >= this.maxVersionsPerPackage) {
      throw new IndexLimitError(
        `package ${name} has reached the version limit (${this.maxVersionsPerPackage})`,
        'version_limit',
      );
    }

    // The version string is validated semver above. Define the entry with
    // Object.defineProperty on a null-prototype map: no prototype chain
    // exists to pollute and the version value is never used as a bare
    // computed assignment target. (CodeQL js/prototype-polluting-assignment.)
    const versionsMap = pkg ? { ...pkg.versions } : Object.create(null);
    Object.defineProperty(versionsMap, metadata.version, {
      value: metadata,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const packageEntry = pkg
      ? { ...pkg, versions: versionsMap, latest: computeLatest(versionsMap) }
      : {
        name,
        description: metadata.description || '',
        repository: metadata.repository || '',
        versions: versionsMap,
        latest: metadata.version,
      };

    const next = {
      packages: { ...this.index.packages, [name]: packageEntry },
    };
    this.#commit(next);
    return packageEntry.versions[metadata.version];
  }

  /**
   * Mark a version yanked. The artifact and metadata stay in the index so
   * pinned lockfiles keep resolving; fresh resolution should skip it.
   *
   * @returns {object} the updated version entry
   */
  yankVersion(name, version, reason = '') {
    const pkg = this.requirePackage(name);
    const existing = pkg.versions[version];
    if (!existing) {
      throw new NotFoundError(
        `version "${version}" of "${name}" not found`,
        'version_not_found',
      );
    }
    const updated = {
      ...existing,
      yanked: true,
      yankedAt: new Date().toISOString(),
      ...(reason ? { yankReason: String(reason).slice(0, 500) } : {}),
    };
    const nextPkg = { ...pkg, versions: { ...pkg.versions, [version]: updated } };
    nextPkg.latest = computeLatest(nextPkg.versions);
    this.#commit({
      packages: { ...this.index.packages, [name]: nextPkg },
    });
    return updated;
  }

  /** Remove a package entirely (admin/tests only; not exposed as HTTP). */
  removePackage(name) {
    if (!this.index.packages[name]) {
      throw new NotFoundError(`package "${name}" not found`, 'package_not_found');
    }
    const packages = { ...this.index.packages };
    delete packages[name];
    this.#commit({ packages });
  }

  /** Persist and swap in memory. Throws before any disk write on limits. */
  #commit(next) {
    const withTimestamp = {
      registry: this.registryUrl,
      version: INDEX_SCHEMA_VERSION,
      ...next,
      updated_at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(withTimestamp, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > this.maxIndexBytes) {
      throw new IndexLimitError(
        `index would exceed the size limit (${this.maxIndexBytes} bytes); contact the maintainers`,
        'index_full',
      );
    }
    atomicWriteFile(this.indexPath, serialized);
    this.index = withTimestamp;
  }
}

/**
 * Highest installable version (non-yanked), preferring stable releases over
 * prereleases. Returns '' when every version is yanked -- `latest` must never
 * point at a withdrawn release, or a version-less install would silently
 * fetch it. Yanked versions remain resolvable by explicit version pin.
 *
 * @param {Record<string, object>} versions
 * @returns {string}
 */
function computeLatest(versions) {
  const candidates = Object.values(versions).filter((v) => v && !v.yanked && v.version);
  return highestVersion(candidates);
}

function highestVersion(entries) {
  let best = '';
  for (const entry of entries) {
    const version = entry.version;
    if (!semver.valid(version)) continue;
    if (best === '') {
      best = version;
      continue;
    }
    const bestStable = semver.prerelease(best) === null;
    const curStable = semver.prerelease(version) === null;
    if (curStable && !bestStable) {
      best = version;
    } else if (curStable === bestStable && semver.gt(version, best)) {
      best = version;
    }
  }
  return best;
}

/**
 * Normalize an arbitrary on-disk index into the canonical shape. Tolerates:
 * - missing `version`
 * - legacy `versions` arrays of strings
 * - `publickey` (lowercase) from early server builds
 * - extra fields
 *
 * @param {any} parsed
 * @param {string} [registryUrl] value for the required root `registry` field
 */
function normalizeIndex(parsed, registryUrl = '') {
  const index = { registry: registryUrl, version: INDEX_SCHEMA_VERSION, packages: {} };
  if (!parsed || typeof parsed !== 'object') return index;
  // The configured URL always wins; the on-disk value is stale by definition
  // after a staging -> production promotion.
  if (!registryUrl && typeof parsed.registry === 'string') index.registry = parsed.registry;
  if (typeof parsed.version === 'string') index.version = parsed.version;
  if (parsed.updated_at) index.updated_at = parsed.updated_at;
  const packages = parsed.packages;
  if (!packages || typeof packages !== 'object') return index;

  for (const [name, rawPkg] of Object.entries(packages)) {
    if (!rawPkg || typeof rawPkg !== 'object') continue;
    const pkg = {
      name: typeof rawPkg.name === 'string' && rawPkg.name ? rawPkg.name : name,
      description: typeof rawPkg.description === 'string' ? rawPkg.description : '',
      repository: typeof rawPkg.repository === 'string' ? rawPkg.repository : '',
      versions: {},
      latest: typeof rawPkg.latest === 'string' ? rawPkg.latest : '',
    };
    const rawVersions = rawPkg.versions;
    if (Array.isArray(rawVersions)) {
      // Legacy list shape: no digests recorded anywhere in the file.
      for (const version of rawVersions) {
        if (typeof version !== 'string') continue;
        pkg.versions[version] = normalizeVersionEntry(version, { version });
      }
    } else if (rawVersions && typeof rawVersions === 'object') {
      for (const [version, rawEntry] of Object.entries(rawVersions)) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        pkg.versions[version] = normalizeVersionEntry(version, rawEntry);
      }
    }
    const computed = computeLatest(pkg.versions);
    pkg.latest = computed;
    index.packages[name] = pkg;
  }
  return index;
}

/** Normalize a single version entry to the canonical field set. */
function normalizeVersionEntry(fallbackVersion, raw) {
  const entry = {
    version: typeof raw.version === 'string' && raw.version ? raw.version : fallbackVersion,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : '',
    signature: typeof raw.signature === 'string' ? raw.signature.toLowerCase() : '',
    publicKey: typeof (raw.publicKey ?? raw.publickey) === 'string'
      ? String(raw.publicKey ?? raw.publickey).toLowerCase()
      : '',
    size: Number.isFinite(raw.size) ? raw.size : 0,
    published: typeof raw.published === 'string' ? raw.published : '',
    dependencies: normalizeDependencies(raw.dependencies),
  };
  if (raw.yanked === true) entry.yanked = true;
  if (typeof raw.yankedAt === 'string') entry.yankedAt = raw.yankedAt;
  if (typeof raw.yankReason === 'string' && raw.yankReason) entry.yankReason = raw.yankReason;
  if (typeof raw.compiler === 'string' && raw.compiler) entry.compiler = raw.compiler;
  if (typeof raw.download_url === 'string' && raw.download_url) {
    // Seed/sync entries point at GitHub Releases; keep the hint so operators
    // can migrate them, but never emit it as the primary location.
    entry.download_url = raw.download_url;
  }
  return entry;
}

/**
 * Dependencies are a name -> spec map in the canonical schema. The legacy
 * seed used `[]` and /sync accepted arbitrary JSON; anything non-object
 * becomes an empty object.
 *
 * Hardening (CodeQL js/prototype-polluting-assignment): the result is a
 * fresh null-prototype object built from an explicit allowlist of safe
 * package-name keys, so `__proto__`, `constructor`, and `prototype` strings
 * from a hostile seed/sync body can never alter an object prototype.
 */
const SAFE_DEPENDENCY_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

function normalizeDependencies(raw) {
  const deps = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...deps };
  }
  for (const [name, spec] of Object.entries(raw)) {
    if (typeof spec !== 'string') continue;
    if (!SAFE_DEPENDENCY_KEY.test(name) || name.length > 128) continue;
    deps[name] = spec;
  }
  // Spread into a plain object for JSON serialization; the allowlist above
  // already excluded every prototype-sensitive key.
  return { ...deps };
}

/** Write a file atomically (temp file + rename) so readers never see partials. */
function atomicWriteFile(target, contents) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

module.exports = {
  IndexStore,
  normalizeIndex,
  normalizeDependencies,
  computeLatest,
  atomicWriteFile,
  INDEX_SCHEMA_VERSION,
};
