// XIOM Package Registry -- process entry point.
// Copyright 2026 Eleftherios Notas and XIOM Foundation
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { IndexStore } = require('./index');

function start() {
  const config = loadConfig();
  const app = createApp(config);

  const server = app.listen(config.port, config.host, () => {
    const index = new IndexStore(config).snapshot();
    console.log(`XIOM Registry ${require('../package.json').version} listening on ${config.host}:${config.port}`);
    console.log(`  env:      ${config.env}`);
    console.log(`  data:     ${config.dataDir}`);
    console.log(`  packages: ${config.packagesDir}`);
    console.log(`  tokens:   ${config.tokens.size} configured (${config.tokens.size === 0 ? 'publishing disabled' : 'publishing enabled'})`);
    console.log(`  packages indexed: ${Object.keys(index.packages).length}`);
    console.log(`  limits:   ${config.maxTarballBytes} byte tarballs, ${config.maxIndexPackages} packages`);
  });

  const shutdown = (signal) => {
    console.log(`xiom-registry: ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on stuck keep-alive connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = { start };
