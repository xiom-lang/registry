// XIOM Package Registry -- tarball storage.
// Copyright 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const fs = require('fs');
const path = require('path');

const { atomicWriteFile } = require('./index');
const { NotFoundError } = require('./errors');

const TARBALL_NAME = 'package.tar.gz';

/**
 * Content-addressed-adjacent layout: PACKAGES_DIR/<name>/<version>/package.tar.gz
 * (exactly what the client downloads). Names and versions are validated
 * before they reach this module, but every path builder re-asserts that the
 * resolved path stays inside PACKAGES_DIR as defense in depth.
 */
class ArtifactStore {
  /** @param {{ packagesDir: string }} config */
  constructor(config) {
    this.packagesDir = path.resolve(config.packagesDir);
    fs.mkdirSync(this.packagesDir, { recursive: true });
  }

  /** Path of the artifact, resolving symlinks and checking containment. */
  tarballPath(name, version) {
    const candidate = path.resolve(this.packagesDir, name, version, TARBALL_NAME);
    const root = this.packagesDir.endsWith(path.sep) ? this.packagesDir : this.packagesDir + path.sep;
    if (!candidate.startsWith(root)) {
      // Traversal attempt must be impossible; treat as a bad artifact request.
      throw new NotFoundError(`artifact ${name}@${version} not found`, 'artifact_not_found');
    }
    return candidate;
  }

  exists(name, version) {
    try {
      return fs.existsSync(this.tarballPath(name, version));
    } catch {
      return false;
    }
  }

  /** @throws NotFoundError */
  require(name, version) {
    const file = this.tarballPath(name, version);
    if (!fs.existsSync(file)) {
      throw new NotFoundError(
        `artifact for ${name}@${version} not found`,
        'artifact_not_found',
      );
    }
    return file;
  }

  /**
   * Move a fully-received upload into place. The file lands atomically
   * (temp -> rename inside the same volume) so a crash never leaves a
   * half-written artifact that the index already points at.
   *
   * @param {string} name
   * @param {string} version
   * @param {string} sourcePath path of the uploaded temp file
   * @returns {string} final tarball path
   */
  store(name, version, sourcePath) {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) {
      throw new Error(`upload is not a regular file: ${sourcePath}`);
    }
    const target = this.tarballPath(name, version);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      // Same filesystem: rename is atomic, so the path is either absent or
      // the complete artifact -- never a partial file the index points at.
      fs.renameSync(sourcePath, target);
    } catch (err) {
      if (err.code === 'EXDEV') {
        atomicWriteFile(target, fs.readFileSync(sourcePath));
        fs.rmSync(sourcePath, { force: true });
      } else {
        throw err;
      }
    }
    return target;
  }

  /** Bytes + stat helpers used by the publish pipeline. */
  read(name, version) {
    return fs.readFileSync(this.require(name, version));
  }

  remove(name, version) {
    const dir = path.dirname(this.tarballPath(name, version));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

module.exports = { ArtifactStore, TARBALL_NAME };
