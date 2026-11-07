# Jelo Co-Lab Server

Node.js 20+ WebSocket server for the Jelo Co-Lab VS Code extension (v1.6.0 / Phase 2).

## Start locally

```bash
npm ci
COLLAB_TOKEN="$(openssl rand -hex 32)" npm start
```

The server binds to `127.0.0.1:3000` by default. `COLLAB_TOKEN` is required and must be 24-256 characters using letters, numbers, `_` or `-`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `COLLAB_TOKEN` | Required | Shared server authentication secret |
| `HOST` | `127.0.0.1` | Listen address; use a TLS reverse proxy for remote clients |
| `PORT` | `3000` | HTTP/WebSocket port |
| `DATA_DIR` | `server/data` | Persistent workspace files and document state |

All workspace IDs on one server currently use the same server token. This is a shared-secret model, not per-workspace membership or role-based authorization.

## Health and diagnostics

```bash
curl http://127.0.0.1:3000/healthz
npm run check
npm test
```

`GET /healthz` returns service status and running version. Structured newline-delimited JSON logs go to stdout/stderr and are available through `journalctl` under systemd.

## Phase 2 protocol

- Documents have monotonically increasing server revisions.
- Clients submit UTF-16 text operations with a `baseRevision`, `clientId`, and `opId`.
- The server serializes edits per document, transforms stale operations through bounded history, persists state, then broadcasts the accepted operation.
- Duplicate operation IDs are acknowledged without applying the operation twice.
- Reconnect requests return history since a client's last revision; if history is too old or incomplete, the server sends a current snapshot.
- Files up to 10 MiB are transferred in sequential 48 KiB Base64 chunks. Every chunk is acknowledged and checked, and completed content is verified with SHA-256 before atomic persistence.
- Downloads are acknowledged frame-by-frame and are limited to two simultaneous downloads per connection.
- File deletion and rename are serialized against document saves, opens, transfers and downloads.
- File operations carry idempotency IDs and are recorded in a persistent per-workspace journal. Completed retries receive the original acknowledgment; unresolved journal entries fail closed rather than risk applying a delayed delete or move to a newer file.

See `../docs/PHASE-2-PROTOCOL.md` for message formats and known ceilings.

## Security boundaries

- Workspace IDs and relative paths are validated at the server boundary.
- Symlink path components and non-regular files are rejected.
- Server writes use temporary files, fsync, and atomic rename.
- File data is limited to 10 MiB; WebSocket JSON messages are limited to 6 MiB.
- Common repository/build directories, cloud/SSH credentials, `.env*`, and key/certificate files are excluded.
- Authentication secrets are compared using `crypto.timingSafeEqual`.
- Use `wss://` for remote access. The installer binds to localhost and expects a TLS reverse proxy.

## Known limitations

- OT history is bounded (500 operations or 1 MiB); older clients need snapshot recovery.
- Upload retries restart a file from its first chunk after a disconnect; partial transfers are not persisted across server restarts.
- Base64 JSON chunks are not as efficient as a binary WebSocket frame protocol.
- One shared token protects the server; per-workspace roles and token rotation are future work.
- The file-operation journal retains up to 5,000 operation records per workspace. Pending/unknown outcomes are never evicted automatically and require manual inspection.
- Server unit/integration tests do not replace VS Code Extension Host or multi-OS end-to-end testing.
