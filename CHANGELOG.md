# Changelog

## [1.7.14] - Fix VSIX license assertion

- Fixed the release workflow check to match VS Code packaging output (`extension/LICENSE.txt`).
- Added diagnostic output showing license entries when VSIX validation fails.
- No extension or server runtime behavior changed.


## [1.7.13] - Fix VSIX packaging lifecycle

- Keep TypeScript and other development dependencies installed until VSCE completes the `vscode:prepublish` lifecycle hook.
- Remove the premature `npm prune --omit=dev` command that removed `tsc` before VSCE invoked the prepublish compile.
- Verify the VSIX contains the production `ws` dependency and license, but does not include the TypeScript compiler.
- Preserve Windows and Ubuntu as the supported Extension Host CI targets.
- No application functionality changes.

## [1.7.11] - Lockfile registry integrity refresh correction

- Keep a valid `ws@8.22.1` lock entry so the checked-in manifests and lockfiles remain structurally synchronized for clean installs.
- Explicitly remove the placeholder `ws` lock entry immediately before registry refresh, forcing npm to fetch authentic package integrity metadata.
- Require a valid npm `sha512` integrity value in the release verifier and CI checks.
- Apply the same refresh sequence to server CI, extension CI, tagged release jobs, and the Ubuntu server installer.
- Include the lock refresh helper in the standalone server release ZIP.
- No application functionality changes.


## [1.7.9] - Release workflow self-containment fix

- Remove the release workflow dependency on a separately committed version-verifier script.
- Validate tag, server and extension package versions, lockfile roots, and ws integrity metadata inline in GitHub Actions.
- Keep server and extension manifests and lockfiles aligned at 1.7.9.
- No application functionality changes.

## [1.7.8] - Release metadata and reproducible build fix

- Align server and VS Code extension package versions with the v1.7.8 tag.
- Pin the patched WebSocket runtime dependency to ws 8.22.1 in both packages.
- Add matching package-lock root metadata and the exact `node_modules/ws@8.22.1` lock entry so `npm ci` validates the dependency graph.
- Add an early release preflight that checks both package manifests, both lockfiles, and the tag version before platform tests run. A stale server version now fails immediately with a clear diagnostic.
- Ensure Windows and Ubuntu release jobs refresh and validate lockfiles before every npm ci.
- No application behavior changes; this is a release and packaging correction only.


## [1.7.6] - Fix release build lockfile refresh ordering

- Refresh and verify the extension lockfile in the tagged-release Windows/Ubuntu test matrix before running `npm ci`.
- Keep the lockfile refresh behavior aligned with the already-working CI workflow and the later packaging job.
- Verify the resolved `ws` version is patched and has registry integrity metadata before clean installation.
- Bump server and extension package versions and lockfile root metadata to 1.7.6.

## [1.7.5] - Limit supported CI targets to Windows and Ubuntu

- Run VS Code Extension Host tests on `windows-latest` and `ubuntu-latest` only; macOS is intentionally excluded.
- Gate tagged releases on successful Extension Host test runs on both supported operating systems.
- Keep Ubuntu headless testing under Xvfb and run Windows tests natively.
- Bump server and extension package versions and lockfile root metadata to 1.7.5.

## [1.7.5] - Restrict supported CI platforms to Windows and Ubuntu

- Run VS Code Extension Host CI on `windows-latest` and `ubuntu-latest` only.
- Remove macOS from the test matrix and platform claims; no macOS build or support is part of this release.
- Keep Linux headless testing on Ubuntu with Xvfb and run the Windows Extension Host tests natively.
- Bump the server and extension package versions and lockfile root metadata to 1.7.5.

## [1.7.4] - Fix Extension Host test runner dependency

- Removed the undeclared Mocha runtime requirement from the Extension Host test suite.
- Replaced Mocha globals with a small dependency-free async test runner using Node.js built-in assertions.
- Exported the `run()` entry point expected by the VS Code Extension Host test loader.
- Kept `@vscode/test-electron` as the separately installed test harness; it is not shipped to extension users.
- Excluded the Extension Host test files from the VSIX and pruned test-only dependencies before release packaging.
- Added an Extension Host test gate to tagged-release automation.
- Updated server and extension package versions and lockfile root metadata to 1.7.4.


## [1.7.3] - Production dependency security update and binary upload reliability

- Updated the server and VS Code extension production dependency `ws` to 8.20.2, outside the vulnerable 8.0.0–8.20.1 range reported by npm audit.
- Added high-severity production dependency audit gates for both runtime packages in CI and release automation.
- Replace the binary chunk message-count limiter with a byte-based token bucket suitable for the supported 10 MiB file size.
- Correlate binary chunk acknowledgements and rate-limit errors with their request IDs.
- Return a retry delay for throttled chunks and make the VS Code client retry them safely.
- Make the large-file integration test report server-side chunk errors immediately instead of hiding them behind a timeout.
- Extend the large-file CI test budget to tolerate slower hosted runners.

## [1.7.1] - CI test reliability patch

- Run the Node test files serially in CI and local `npm test` to avoid resource contention between multiple server-spawning integration suites.
- Extend WebSocket message and health-startup test timeouts for slower hosted runners.
- Centralize child-process shutdown in tests, attach exit listeners before signaling, and force-kill only after a bounded graceful-shutdown window.
- Increase the explicit timeout for the 10 MiB transfer integration test and 40-client stress test.

## [1.7.0] — Phase 3 and Phase 4 completion

### Added
- Guided onboarding with server health verification and local workspace preview.
- Activity Bar views for collaborators, transfers and conflicts, with empty-state actions and accessible tree labels.
- Collaborator document picker, transfer pause/resume/retry and conflict resolution for file modifications, deletions and renames.
- Offline workspace-manifest reconciliation using path, size and SHA-256; simple remote renames are identified by last-known hash.
- Workspace-scoped accounts with `admin`, `editor`, and `viewer` roles; server-enforced read-only viewers, scrypt-hashed tokens, CLI token rotation, membership changes, last-admin protection and audit events.
- Binary 48 KiB file upload frames with SHA-256 verification and durable acknowledged-offset resume across server restarts.
- Separate bulk-chunk rate limit bucket so large valid transfers do not exhaust the control-message budget.
- Operational audit rotation, consistent backup/restore, daily backup timer helper, and official-repository Caddy TLS setup helper.
- Cross-platform VS Code Extension Host CI workflow for Ubuntu, Windows and macOS.
- GitHub build-provenance attestation for VSIX and standalone server release archives.
- MIT license, contribution guide, support policy, operations and security documentation.

### Fixed
- Prevented stale reconciliation state from overwriting a hash baseline recorded by a completed download.
- Prevented automatic overwrite during remote file moves when a local destination already exists.
- Added viewer-role write denial and regression coverage.
- Fixed 10 MiB transfer stalls caused by using the control-message rate limiter for binary data chunks.
- Kept paused upload requests in the durable transfer queue instead of dropping them.
- Suppressed watcher feedback when applying an offline remote rename.

### Validated
- Server tests include 10 MiB binary transfer, durable upload resume after server restart, access-management CLI, viewer permissions, browser-Origin policy, and 40 concurrent WebSocket collaborators (20 server tests total).
- TypeScript compilation, shell syntax, YAML parsing, archive integrity and SHA-256 checks are part of the release validation workflow.

## [1.6.0] — Phase 2 synchronization engine
- Server-authoritative, revisioned OT and reconnect history replay.
- Durable local operation queue and recovery-copy conflict flow.
- Per-document collaboration sessions and cursor transformation.
- Acknowledged chunk file transfer, offline filesystem operations and idempotent server operations.

## [1.5.4] — Phase 1 security foundation
- Workspace path validation, symlink refusal and atomic writes.
- Bootstrap authentication, SecretStorage, secure remote WSS policy and release installer foundation.
