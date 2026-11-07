# Changelog

## 1.5.4 - Phase 1 final hardening pass

- Validated workspace IDs, relative paths, WebSocket message shapes, edit ranges, cursor positions, file sizes and authentication tokens.
- Rejected symlink path components and special-file targets; wrote synchronized files through temporary files and atomic rename.
- Added an unauthenticated `/healthz` endpoint for service monitoring and structured server logs.
- Added graceful shutdown that flushes pending debounced document saves.
- Removed the unused Express dependency; the server now uses Node's HTTP module and `ws` only.
- Added server security and WebSocket integration tests.
- Enforced secure URL configuration and server-token validation in the extension; stored the token with VS Code SecretStorage.
- Prevented a remote initial snapshot from overwriting a dirty local document buffer.
- Added safe default sync exclusions, a conservative per-file size limit, transfer pacing, progress and error reporting.
- Added a checksum-verifying Ubuntu/Debian installer with a hardened systemd service and health check.
- Added release automation for the VSIX, server ZIP, and SHA-256 sidecars.

This release does not include CRDT/OT merging, resumable transfers, delete/rename sync, or multi-root synchronization. See the roadmap in README.md.
