// XIOM Package Registry — Production-grade Node.js backend
// Deployable on Docker/Portainer, Contabo VPS, or any Node.js host.
// Copyright (c) 2026 Eleftherios Notas. MIT License.

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PACKAGES_DIR = process.env.PACKAGES_DIR || path.join(__dirname, 'packages');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const API_KEY = process.env.API_KEY || '';

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Authenticated routes use this
function authRequired(req, res, next) {
  if (!API_KEY) return next(); // No key configured = open registry
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized — invalid API key' });
  next();
}

// ─── Index management ──────────────────────────────────────────────────────
function loadIndex() {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    }
  } catch (e) { /* fall through */ }
  return { version: '1.0.0', packages: {} };
}

function saveIndex(index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  index.updated_at = new Date().toISOString();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

// ─── Package storage ────────────────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, 'tmp'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

function packageDir(name, version) {
  return path.join(PACKAGES_DIR, name, version);
}

function ensurePackageDir(name, version) {
  const dir = packageDir(name, version);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── API Routes ─────────────────────────────────────────────────────────────

// GET / — health check
app.get('/', (req, res) => {
  const index = loadIndex();
  const count = Object.keys(index.packages).length;
  res.json({
    name: 'XIOM Package Registry',
    version: '1.0.0',
    packages: count,
    status: 'operational',
    docs: 'https://xiom-lang.org/docs/registry',
  });
});

// GET /index.json — full package catalog
app.get('/index.json', (req, res) => {
  const index = loadIndex();
  res.json(index);
});

// GET /packages/:name — list versions for a package
app.get('/packages/:name', (req, res) => {
  const index = loadIndex();
  const pkg = index.packages[req.params.name];
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  res.json(pkg);
});

// GET /packages/:name/:version — get package metadata
app.get('/packages/:name/:version', (req, res) => {
  const index = loadIndex();
  const pkg = index.packages[req.params.name];
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  const ver = pkg.versions[req.params.version];
  if (!ver) return res.status(404).json({ error: 'Version not found' });
  res.json(ver);
});

// GET /packages/:name/:version/download — download package tarball
app.get('/packages/:name/:version/download', (req, res) => {
  const { name, version } = req.params;
  const dir = packageDir(name, version);
  const tarball = path.join(dir, 'package.tar.gz');

  if (!fs.existsSync(tarball)) {
    return res.status(404).json({ error: 'Package tarball not found. Use xiom pkg publish to upload.' });
  }

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${version}.tar.gz"`);
  fs.createReadStream(tarball).pipe(res);
});

// POST /publish — publish a new package version (authenticated)
app.post('/publish', authRequired, upload.single('package'), (req, res) => {
  try {
    const { name, version, description, repository, dependencies } = req.body;

    if (!name || !version) {
      return res.status(400).json({ error: 'name and version are required' });
    }

    // Validate name format: alphanumeric + hyphens/underscores
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid package name. Must start with a letter, 1-64 chars.' });
    }

    // Validate semver
    const semver = require('semver');
    if (!semver.valid(version)) {
      return res.status(400).json({ error: `Invalid version "${version}". Must be valid semver.` });
    }

    const index = loadIndex();

    // Check for existing version
    if (index.packages[name] && index.packages[name].versions[version]) {
      return res.status(409).json({ error: `Version ${version} of ${name} already exists.` });
    }

    // Store the tarball
    const dir = ensurePackageDir(name, version);
    const tarballPath = path.join(dir, 'package.tar.gz');

    if (req.file) {
      // Move uploaded file to package directory
      fs.renameSync(req.file.path, tarballPath);
    } else {
      return res.status(400).json({ error: 'No package tarball uploaded. Use multipart/form-data with field "package".' });
    }

    // Generate checksum
    const fileBuffer = fs.readFileSync(tarballPath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Update index
    if (!index.packages[name]) {
      index.packages[name] = {
        name,
        description: description || '',
        repository: repository || '',
        versions: {},
        latest: version,
      };
    }

    const deps = dependencies ? (typeof dependencies === 'string' ? JSON.parse(dependencies) : dependencies) : {};

    index.packages[name].versions[version] = {
      version,
      published: new Date().toISOString(),
      sha256,
      size: fileBuffer.length,
      dependencies: deps,
    };

    index.packages[name].latest = version;
    saveIndex(index);

    console.log(`Published: ${name}@${version} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);

    res.status(201).json({
      ok: true,
      package: name,
      version,
      sha256,
      message: `Successfully published ${name}@${version}`,
    });
  } catch (err) {
    console.error('Publish error:', err);
    res.status(500).json({ error: 'Internal server error during publish' });
  }
});

// POST /sync — sync packages from local index.json (authenticated, batch import)
app.post('/sync', authRequired, express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { packages } = req.body;
    if (!Array.isArray(packages)) {
      return res.status(400).json({ error: 'Expected "packages" array in body' });
    }

    const index = loadIndex();
    let added = 0;
    let skipped = 0;

    for (const pkg of packages) {
      if (!pkg.name || !pkg.version) continue;
      if (index.packages[pkg.name]?.versions[pkg.version]) { skipped++; continue; }

      if (!index.packages[pkg.name]) {
        index.packages[pkg.name] = {
          name: pkg.name,
          description: pkg.description || '',
          repository: pkg.repository || '',
          versions: {},
          latest: pkg.version,
        };
      }

      index.packages[pkg.name].versions[pkg.version] = {
        version: pkg.version,
        published: new Date().toISOString(),
        download_url: pkg.download_url || '',
        dependencies: pkg.dependencies || {},
      };
      index.packages[pkg.name].latest = pkg.version;
      added++;
    }

    saveIndex(index);
    res.json({ ok: true, added, skipped, total: Object.keys(index.packages).length });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Internal server error during sync' });
  }
});

// GET /search?q=<query> — search packages
app.get('/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase();
  const index = loadIndex();
  const results = [];

  for (const [name, pkg] of Object.entries(index.packages)) {
    if (!query || name.toLowerCase().includes(query) || (pkg.description || '').toLowerCase().includes(query)) {
      results.push({
        name,
        description: pkg.description,
        latest: pkg.latest,
        versions: Object.keys(pkg.versions).length,
        repository: pkg.repository,
      });
    }
  }

  res.json({ query: req.query.q, results });
});

// ─── Start server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`XIOM Registry running on port ${PORT}`);
  console.log(`  Data: ${DATA_DIR}`);
  console.log(`  Packages: ${PACKAGES_DIR}`);

  // Initialize empty index if needed
  if (!fs.existsSync(INDEX_PATH)) {
    saveIndex({ version: '1.0.0', packages: {} });
    console.log('  Initialized empty index.json');
  }

  const index = loadIndex();
  const count = Object.keys(index.packages).length;
  console.log(`  ${count} packages registered`);
});
