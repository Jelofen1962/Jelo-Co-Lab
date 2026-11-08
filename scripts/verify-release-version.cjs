#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const raw = process.env.RELEASE_TAG || process.argv[2] || '';
const expected = String(raw).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error(`Invalid release tag: ${raw || '(empty)'}`);
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
let failed = false;
for (const dir of ['server', 'vscode-extension']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, dir, 'package-lock.json'), 'utf8'));
  const ws = lock.packages?.['node_modules/ws'];
  const problems = [];
  if (manifest.version !== expected) problems.push(`package.json version ${manifest.version} != ${expected}`);
  if (lock.version !== expected) problems.push(`package-lock version ${lock.version} != ${expected}`);
  if (lock.packages?.['']?.version !== expected) problems.push(`package-lock root version ${lock.packages?.['']?.version} != ${expected}`);
  if (manifest.dependencies?.ws !== '8.22.1') problems.push(`package.json ws must be 8.22.1 (found ${manifest.dependencies?.ws || 'missing'})`);
  if (lock.packages?.['']?.dependencies?.ws !== '8.22.1') problems.push(`package-lock root ws must be 8.22.1 (found ${lock.packages?.['']?.dependencies?.ws || 'missing'})`);
  if (ws?.version !== '8.22.1') problems.push(`locked ws must be 8.22.1 (found ${ws?.version || 'missing'})`);
  if (ws?.resolved !== 'https://registry.npmjs.org/ws/-/ws-8.22.1.tgz') problems.push('locked ws registry URL is incorrect');
  if (process.env.REQUIRE_NPM_INTEGRITY === '1' && !ws?.integrity) problems.push('locked ws is missing npm registry integrity metadata; run npm install --package-lock-only');
  if (problems.length) {
    failed = true;
    console.error(`${dir}: ${problems.join('; ')}`);
  } else {
    console.log(`${dir}: ${expected}, ws 8.22.1${ws.integrity ? ', integrity present' : ', integrity will be refreshed by npm'}`);
  }
}
if (failed) process.exit(1);
