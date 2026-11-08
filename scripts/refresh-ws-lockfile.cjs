#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WS_VERSION = '8.22.1';
const WS_TARBALL = `https://registry.npmjs.org/ws/-/ws-${WS_VERSION}.tgz`;
const root = path.resolve(__dirname, '..');
const packageDir = process.argv[2]
  ? path.resolve(root, process.argv[2])
  : process.cwd();
const manifestPath = path.join(packageDir, 'package.json');
const lockPath = path.join(packageDir, 'package-lock.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function hasValidSha512(value) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === encoded;
}

if (!fs.existsSync(manifestPath) || !fs.existsSync(lockPath)) {
  fail(`Expected package.json and package-lock.json in ${packageDir}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (manifest.dependencies?.ws !== WS_VERSION) {
  fail(`package.json must pin ws ${WS_VERSION}; found ${manifest.dependencies?.ws || 'missing'}`);
}
if (lock.packages?.['']?.dependencies?.ws !== WS_VERSION) {
  fail(`package-lock root must pin ws ${WS_VERSION}; found ${lock.packages?.['']?.dependencies?.ws || 'missing'}`);
}

// Always fetch the published dist.integrity value from the official npm registry.
// Never synthesize or reuse an integrity value, even when the lock already has one.
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['view', `ws@${WS_VERSION}`, 'dist', '--json', '--registry=https://registry.npmjs.org'], {
  cwd: packageDir,
  encoding: 'utf8',
  windowsHide: true,
  shell: process.platform === 'win32',
  env: process.env,
});
if (result.error || result.status !== 0) {
  const detail = result.error?.message || result.stderr?.trim() || `npm exited with ${result.status}`;
  fail(`Could not fetch npm registry metadata for ws@${WS_VERSION}: ${detail}`);
}

let dist;
try {
  dist = JSON.parse(result.stdout.trim());
} catch (error) {
  fail(`npm view returned invalid JSON for ws@${WS_VERSION}: ${error.message}`);
}
if (dist?.tarball !== WS_TARBALL || !hasValidSha512(dist?.integrity)) {
  fail(`npm registry metadata for ws@${WS_VERSION} did not contain the expected tarball and a valid SHA-512 integrity value`);
}

lock.packages = lock.packages || {};
const wsEntry = { ...(lock.packages['node_modules/ws'] || {}) };
wsEntry.version = WS_VERSION;
wsEntry.resolved = dist.tarball;
wsEntry.integrity = dist.integrity;
lock.packages['node_modules/ws'] = wsEntry;

// A modern npm lockfile may also carry the legacy dependency tree. Keep it in sync.
if (lock.dependencies?.ws) {
  lock.dependencies.ws = {
    ...lock.dependencies.ws,
    version: WS_VERSION,
    resolved: dist.tarball,
    integrity: dist.integrity,
  };
}

fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`${path.relative(root, packageDir) || '.'}: refreshed ws ${WS_VERSION} from npm registry (sha512 integrity verified)`);
