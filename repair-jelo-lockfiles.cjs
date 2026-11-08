#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const expected = String(process.argv[2] || process.env.EXPECTED_VERSION || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error('Usage: node scripts/verify-release-version.cjs <version-or-tag>');
  process.exit(2);
}
for (const dir of ['server', 'vscode-extension']) {
  const manifestPath = path.join(dir, 'package.json');
  const lockPath = path.join(dir, 'package-lock.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const errors = [];
  if (manifest.version !== expected) errors.push(`package.json version ${manifest.version} != ${expected}`);
  if (lock.version !== expected) errors.push(`package-lock version ${lock.version} != ${expected}`);
  if (lock.packages?.['']?.version !== expected) errors.push(`package-lock root version ${lock.packages?.['']?.version} != ${expected}`);
  if (manifest.dependencies?.ws !== '8.22.1') errors.push(`package.json ws must be pinned to 8.22.1 (found ${manifest.dependencies?.ws})`);
  const lockWs = lock.packages?.['node_modules/ws'];
  if (!lockWs || lockWs.version !== '8.22.1') errors.push(`lockfile node_modules/ws must resolve to 8.22.1 (found ${lockWs?.version || 'missing'})`);
  if (errors.length) {
    console.error(`${dir}: ${errors.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${dir}: version ${expected}, ws ${lockWs.version}`);
  }
}
