# Changelog

## [1.7.2] - Binary upload flow-control fix

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
