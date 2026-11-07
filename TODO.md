# Jelo Co-Lab Development TODO

## Phase 1 — Security and release foundation

- [x] Validate workspace IDs and relative paths at the server boundary.
- [x] Reject symlink components and special-file targets.
- [x] Use temporary files and atomic rename for server-side writes.
- [x] Require a strong server-side token and compare it in constant time.
- [x] Store the token using VS Code SecretStorage.
- [x] Require `wss://` for remote server configuration.
- [x] Validate incoming messages, edit ranges, cursors and file sizes.
- [x] Add health endpoint, structured logs and graceful save flushing.
- [x] Add safe sync exclusions and a conservative 700 KB file limit.
- [x] Protect dirty local buffers from initial remote snapshots.
- [x] Pace directory pushes and report progress/errors.
- [x] Add server security and WebSocket integration tests.
- [x] Build VSIX and server ZIP in GitHub Actions with SHA-256 sidecars.
- [x] Add checksum-verifying Ubuntu/Debian installer and hardened systemd service.
- [x] Document diagnostics, deployment limits and the next phases.

## Phase 2 — Synchronization correctness

- [ ] Pick a concurrency model: CRDT or versioned OT.
- [ ] Add document IDs, versions, operation IDs and idempotency.
- [ ] Test simultaneous edits, Unicode, multiline changes and selection updates.
- [ ] Add explicit local/server snapshot conflict resolution.
- [ ] Replace JSON number arrays with chunked binary transfers.
- [ ] Add file transfer acknowledgments, retry, resume, cancellation and hashes.
- [ ] Synchronize create, rename, move and delete operations.
- [ ] Add transfer manifests and configurable ignore rules.
- [ ] Support multiple open documents and multiple workspace roots.
- [ ] Add multi-client integration tests and deterministic replay tests.

## Phase 3 — UX and resilience

- [ ] Add first-run setup and connection diagnostics.
- [ ] Show collaborator roster, presence and stable remote cursors.
- [ ] Improve auth/connection state transitions and configuration reconnect.
- [ ] Add heartbeat, stale-client cleanup and reconnect backoff with jitter.
- [ ] Add offline queue and recovery after server/network outages.
- [ ] Add dry-run sync preview, cancellation and detailed per-file outcomes.
- [ ] Add configurable ignore patterns and visible secret exclusions.
- [ ] Accessibility pass for keyboard navigation, status labels and notifications.

## Phase 4 — Production and public release

- [ ] Add VS Code Extension Host E2E tests across supported OS/VS Code versions.
- [ ] Stress-test large repositories, slow networks and many collaborators.
- [ ] Add backup/restore and safe upgrade/migration tests.
- [ ] Add per-workspace memberships, roles, token rotation and audit events.
- [ ] Add optional TLS proxy provisioning and firewall guidance.
- [ ] Choose and add an explicit license.
- [ ] Add contribution, support and release policies.
- [ ] Add signed release assets and provenance/attestation where practical.
- [ ] Arrange independent security review before claiming internet-facing production readiness.
