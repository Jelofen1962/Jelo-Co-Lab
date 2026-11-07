# Jelo Co-Lab Server

Node.js 20+ WebSocket server for the Jelo Co-Lab VS Code extension.

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
| `DATA_DIR` | `server/data` | Persistent workspace data directory |

All workspace IDs on one server currently use the same server token. This is a Phase 1 shared-secret model, not per-workspace membership or token rotation.

## Health and diagnostics

```bash
curl http://127.0.0.1:3000/healthz
npm run check
npm test
```

`GET /healthz` returns service status and the running version. The server emits newline-delimited JSON logs to stdout/stderr, suitable for `journalctl` under systemd.

## Security boundaries

- Workspace IDs and relative file paths are validated before filesystem access.
- Symlink path components are rejected.
- Files are written through a temporary file and atomically renamed.
- File data is limited to 700,000 bytes per file in this protocol version.
- WebSocket messages are capped at 5 MB; binary messages are rejected.
- Authentication secrets are compared using `crypto.timingSafeEqual`.
- Use `wss://` for remote access. The installer binds to localhost and expects a TLS reverse proxy.

The Phase 1 file-size cap is deliberately conservative because the current protocol represents file bytes as JSON number arrays. Phase 2 should replace this with an acknowledged, chunked/binary transfer protocol.
