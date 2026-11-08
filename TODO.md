# Jelo Co-Lab delivery status and remaining TODO

Version: 1.7.9

This checklist distinguishes implemented work from release gates that require a real external environment. A checked implementation item does not mean the Windows and Ubuntu GitHub workflow or an independent security review has already run.

## Phase 1 — Security and release foundation

- [x] Validate workspace IDs and file paths at server boundaries.
- [x] Reject traversal, symlink and special-file escapes.
- [x] Atomic writes and bounded payload validation.
- [x] Server-controlled workspace token authentication.
- [x] VS Code SecretStorage for invitation credentials.
- [x] Require secure transport for non-local servers.
- [x] Safe sync exclusions and file-size limits.
- [x] Linux systemd deployment and diagnostics.
- [x] GitHub VSIX/server ZIP release workflow and checksums.

## Phase 2 — Synchronization engine

- [x] Server-authoritative revisioned Operational Transformation.
- [x] Deterministic operation ordering and stale-history handling.
- [x] Durable local operation outbox and reconnect replay.
- [x] Protect dirty documents during initial snapshot/recovery.
- [x] Chunked binary transfers with SHA-256 verification.
- [x] Acknowledgment, retry, resume and duplicate-chunk protection.
- [x] Offline file operation queue for rename/delete.
- [x] Multiple document subscriptions and multi-root path handling.
- [x] Remote cursor updates and position transformation.

## Phase 3 — Product experience and offline recovery

- [x] First-run onboarding and connection test.
- [x] Collaborator, transfer queue and conflict tree views.
- [x] Connection role/latency diagnostics.
- [x] Pause/resume and retry transfer controls.
- [x] Remote workspace manifest with pagination and bounds.
- [x] Reconcile offline file additions, modifications and deletions.
- [x] Detect unambiguous offline renames by content hash.
- [x] Explicit local/remote conflict choices and recovery copies.
- [x] Avoid reverse-sync loops for locally applied remote filesystem operations.
- [ ] Usability review with real users and screen-reader/keyboard-only testing.

## Phase 4 — Production hardening

- [x] Workspace roles: admin, editor and viewer.
- [x] Member add/remove/token rotation CLI with last-admin protection.
- [x] Hashed member tokens and redacted access audit events.
- [x] Origin allowlist for browser-originated connections.
- [x] Heartbeats, stale-client cleanup and non-sensitive health endpoint.
- [x] Audit log with bounded rotation.
- [x] Durable upload partials across server restarts.
- [x] Per-file and per-workspace transfer bounds.
- [x] Separate bulk transfer flow control from control-message rate limiting.
- [x] Linux systemd hardening.
- [x] Caddy TLS reverse-proxy setup script.
- [x] Backup/restore scripts with checksums, path validation and pre-restore copies.
- [x] Daily backup timer installer.
- [x] CI workflow for server checks and Windows and Ubuntu VS Code Extension Host tests (macOS intentionally unsupported).
- [x] Release workflow with package-version gate, audit, VSIX/server ZIP, checksums and build provenance.
- [x] MIT license, contribution guide, support guide and security policy.
- [ ] Run GitHub CI on all three operating systems and retain passing run links.
- [ ] Run a release-tag workflow and verify actual VSIX installation in clean VS Code profiles.
- [ ] Deploy to a real Linux host behind a real domain/TLS proxy; verify install, reboot, backup and restore.
- [ ] Perform an independent security review / penetration test before broad public production use.
- [ ] Measure behavior with representative repositories and more than 40 active collaborators; tune only from observed results.

## Known limits

- Live concurrent editing needs a connection to the authoritative server. Disconnected edits are queued and replayed; this is not a peer-to-peer CRDT.
- Workspace reconciliation is user-mediated when both local and remote versions changed. Ambiguous rename matches are surfaced as conflicts rather than guessed.
- The protocol currently uses bounded 10 MiB per-file transfers. Larger files require a future streaming/chunk-store design.
- The stress test covers 40 simultaneous local WebSocket clients, not an Internet-scale or distributed multi-node deployment.
- The server is single-node and stores state on local disk. Horizontal scaling and shared storage are intentionally out of scope until a measured requirement exists.
- Caddy, systemd and backup/restore scripts are syntax-checked and designed for Ubuntu/Debian, but the current build environment is not a disposable real Linux host for full deployment validation.


## v1.7.9 release-only correction

- [x] Align both package manifests and lockfile roots to 1.7.9.
- [x] Inline tag/version/dependency validation in the release workflow so no separately delivered helper script is required.
- [x] Validate the pinned ws 8.22.1 lock entry and registry integrity metadata before release builds.
- [x] Keep Windows and Ubuntu as the only Extension Host release targets.
- [x] Pin ws to 8.22.1 in server and extension.
- [x] Validate tag, manifest, and lockfile versions before platform builds.
- [x] Refresh and verify registry lock metadata before every npm ci in CI/release.
- [ ] Confirm the online Windows and Ubuntu GitHub Actions release jobs pass.
