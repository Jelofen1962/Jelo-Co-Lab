#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const raw = process.env.RELEASE_TAG || process.argv[2] || '';
const version = String(raw).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Usage: node scripts/prepare-release.cjs <version-or-tag>; received: ${raw || '(empty)'}`);
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const packages = ['server', 'vscode-extension'];
for (const dir of packages) {
  const manifestPath = path.join(root, dir, 'package.json');
  const lockPath = path.join(root, dir, 'package-lock.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  manifest.version = version;
  manifest.dependencies = manifest.dependencies || {};
  manifest.dependencies.ws = '8.22.1';

  lock.name = manifest.name;
  lock.version = version;
  lock.lockfileVersion = 3;
  lock.packages = lock.packages || {};
  lock.packages[''] = lock.packages[''] || {};
  lock.packages[''].name = manifest.name;
  lock.packages[''].version = version;
  lock.packages[''].dependencies = lock.packages[''].dependencies || {};
  lock.packages[''].dependencies.ws = '8.22.1';
  lock.packages['node_modules/ws'] = lock.packages['node_modules/ws'] || {};
  const wsEntry = lock.packages['node_modules/ws'];
  const expectedWsUrl = 'https://registry.npmjs.org/ws/-/ws-8.22.1.tgz';
  if (wsEntry.version !== '8.22.1' || wsEntry.resolved !== expectedWsUrl) {
    // An older version's digest must never be reused for a different tarball.
    delete wsEntry.integrity;
  }
  wsEntry.version = '8.22.1';
  wsEntry.resolved = expectedWsUrl;
  // npm install --package-lock-only fills the authentic registry integrity; never invent a digest.

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`${dir}: stamped ${version}; ws 8.22.1`);
}
