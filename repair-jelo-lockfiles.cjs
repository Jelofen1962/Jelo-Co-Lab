#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = __dirname;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const projects = ['server', 'vscode-extension'];

function run(args, cwd) {
  console.log(`\n> ${npm} ${args.join(' ')}  (${path.relative(root, cwd)})`);
  const result = spawnSync(npm, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} failed in ${path.relative(root, cwd)} (exit ${result.status ?? 'unknown'})`);
  }
}

try {
  for (const project of projects) {
    const cwd = path.join(root, project);
    // Refresh the lock from package.json using the registry's real metadata and
    // integrity hashes. Do not hand-edit lock entries or invent integrity data.
    run(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
    // Prove that the refreshed lock supports a clean install.
    run(['ci', '--no-audit', '--no-fund'], cwd);
  }

  console.log('\nLockfiles refreshed and clean installs passed for server and vscode-extension.');
  console.log('Commit both package-lock.json files so future npm ci runs are reproducible.');
} catch (error) {
  console.error(`\nLockfile repair failed: ${error.message}`);
  process.exitCode = 1;
}
