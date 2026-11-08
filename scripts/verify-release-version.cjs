#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const raw = process.env.RELEASE_TAG || process.argv[2] || '';
const expected = String(raw).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error(`Invalid release tag: ${raw || '(empty)'}`);
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
const refreshScript = path.join(__dirname, 'refresh-ws-lockfile.cjs');
let failed = false;

function hasValidSha512(value) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === encoded;
}

// Make the verifier self-contained: refresh official registry metadata for both
// packages before inspecting the lockfiles. No separate manual step is required.
for (const dir of ['server', 'vscode-extension']) {
  const refreshed = spawnSync(process.execPath, [refreshScript, dir], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  if (refreshed.stdout) process.stdout.write(refreshed.stdout);
  if (refreshed.status !== 0) {
    failed = true;
    const detail = refreshed.stderr?.trim() || refreshed.error?.message || `refresh exited with ${refreshed.status}`;
    console.error(`${dir}: unable to refresh ws registry metadata: ${detail}`);
  }
}

for (const dir of ['server', 'vscode-extension']) {
  const manifestPath = path.join(root, dir, 'package.json');
  const lockPath = path.join(root, dir, 'package-lock.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const ws = lock.packages?.['node_modules/ws'];
  const problems = [];
  if (manifest.version !== expected) problems.push(`package.json version ${manifest.version} != ${expected}`);
  if (lock.version !== expected) problems.push(`package-lock version ${lock.version} != ${expected}`);
  if (lock.packages?.['']?.version !== expected) problems.push(`package-lock root version ${lock.packages?.['']?.version} != ${expected}`);
  if (manifest.dependencies?.ws !== '8.22.1') problems.push(`package.json ws must be 8.22.1 (found ${manifest.dependencies?.ws || 'missing'})`);
  if (lock.packages?.['']?.dependencies?.ws !== '8.22.1') problems.push(`package-lock root ws must be 8.22.1 (found ${lock.packages?.['']?.dependencies?.ws || 'missing'})`);
  if (ws?.version !== '8.22.1') problems.push(`locked ws must be 8.22.1 (found ${ws?.version || 'missing'})`);
  if (ws?.resolved !== 'https://registry.npmjs.org/ws/-/ws-8.22.1.tgz') problems.push('locked ws registry URL is incorrect');
  if (!hasValidSha512(ws?.integrity)) problems.push('locked ws is missing valid npm registry SHA-512 integrity metadata');
  if (problems.length) {
    failed = true;
    console.error(`${dir}: ${problems.join('; ')}`);
  } else {
    console.log(`${dir}: ${expected}, ws 8.22.1, valid npm SHA-512 integrity`);
  }
}
if (failed) process.exit(1);
console.log(`Release metadata verified for ${expected}`);
