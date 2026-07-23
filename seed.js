#!/usr/bin/env node
/**
 * Seed the XIOM registry with data from the local packages/index.json.
 * Usage: node seed.js [registry-url] [api-key]
 *
 * Default: http://localhost:3000
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const REGISTRY_URL = process.argv[2] || 'http://localhost:3000';
const API_KEY = process.argv[3] || process.env.API_KEY || '';

// Read local packages/index.json
const indexPath = path.join(__dirname, '..', 'packages', 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`ERROR: ${indexPath} not found. Run from registry/ directory.`);
  process.exit(1);
}

const raw = fs.readFileSync(indexPath, 'utf-8');
let packages;

try {
  packages = JSON.parse(raw);
} catch (e) {
  console.error('ERROR: Failed to parse packages/index.json:', e.message);
  process.exit(1);
}

// Normalize to array format
const pkgList = Array.isArray(packages) ? packages : (packages.packages || []);

console.log(`Seeding ${pkgList.length} packages to ${REGISTRY_URL}...`);

function postJSON(urlPath, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(urlPath, REGISTRY_URL);
    const client = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // Batch sync
  const result = await postJSON('/sync', { packages: pkgList });

  if (result.status === 200 || result.status === 201) {
    console.log(`OK: ${result.body.added || 0} added, ${result.body.skipped || 0} skipped, ${result.body.total || 0} total`);
  } else {
    console.error(`ERROR: ${result.status} —`, result.body);
    console.log('\nMake sure the registry is running:');
    console.log('  cd registry && node server.js');
  }
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  console.log('\nMake sure the registry is running:');
  console.log('  cd registry && node server.js');
  console.log('\nOr use Docker:');
  console.log('  cd registry && docker-compose up -d');
});
