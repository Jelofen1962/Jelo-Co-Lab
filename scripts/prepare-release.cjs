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
  // Keep the lock graph complete for npm ci. Preserve an authentic integrity
  // value only when it belongs to this exact tarball; otherwise omit it until
  // refresh-ws-lockfile.cjs fetches the official registry dist.integrity.
  const wsKey = 'node_modules/ws';
  const existingWs = lock.packages[wsKey];
  for (const key of Object.keys(lock.packages)) {
    if (/(^|\/)node_modules\/ws$/.test(key) && key !== wsKey) delete lock.packages[key];
  }
  const expectedWsUrl = 'https://registry.npmjs.org/ws/-/ws-8.22.1.tgz';
  const hasValidIntegrity = existingWs?.version === '8.22.1' &&
    existingWs?.resolved === expectedWsUrl &&
    typeof existingWs?.integrity === 'string' && /^sha512-[A-Za-z0-9+/]+=*$/.test(existingWs.integrity);
  lock.packages[wsKey] = hasValidIntegrity ? existingWs : {
    version: '8.22.1',
    resolved: expectedWsUrl,
    engines: { node: '>=10.0.0' },
    peerDependencies: { bufferutil: '^4.0.1', 'utf-8-validate': '>=5.0.2' },
    peerDependenciesMeta: {
      bufferutil: { optional: true },
      'utf-8-validate': { optional: true },
    },
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`${dir}: stamped ${version}; ws 8.22.1`);
}
