# Jelo Co-Lab Server

Node.js 20+ WebSocket service. On a network-connected machine, refresh registry integrity metadata and install production dependencies with `npm install --package-lock-only --ignore-scripts && npm ci --omit=dev`; run `npm start`. The server requires `COLLAB_TOKEN` (24–256 letters, digits, `_` or `-`) and defaults to `127.0.0.1:3000`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Keep localhost behind a TLS reverse proxy for remote access. |
| `PORT` | `3000` | HTTP/WebSocket port. |
| `COLLAB_TOKEN` | required | Bootstrap administrator token for workspaces not yet managed in `access.json`. |
| `DATA_DIR` | `server/data` | Workspace files, access store, document state, upload partials and audit log. |
| `ALLOWED_ORIGINS` | empty | Optional comma-separated allowlist for browser `Origin` headers. VS Code's Node WebSocket client sends no browser origin. |

## Workspace access management

The first member added to a workspace must have the `admin` role. Run the CLI as the service account:

```bash
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab node /opt/jelo-colab/manage-access.js add workspace alice admin
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab node /opt/jelo-colab/manage-access.js add workspace bob editor
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab node /opt/jelo-colab/manage-access.js add workspace guest viewer
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab node /opt/jelo-colab/manage-access.js list workspace
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab node /opt/jelo-colab/manage-access.js rotate workspace bob editor
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab node /opt/jelo-colab/manage-access.js remove workspace guest
```

Tokens are random 256-bit values. Only scrypt salt/hash pairs are stored. The CLI displays a token once, rotates credentials, prevents last-admin removal/demotion, and appends membership events to `audit.jsonl`. The bootstrap token does not bypass a configured workspace membership list.

## Storage layout

- `workspaces/<workspaceId>/` — synchronized regular files.
- `access.json` — workspace member credentials/roles (mode 0600).
- `audit.jsonl` and `audit.jsonl.1` — operational/security audit trail.
- `state/<workspace-hash>.json` — persistent OT documents and operation history.
- `state/uploads/` — durable upload `.part` and metadata records; stale partials older than seven days are purged on startup.

## Protocol and quotas

- Versioned server-authoritative OT with bounded document history.
- Binary 48 KiB file chunks, SHA-256 integrity, acknowledged sequential writes, and resume after server restart.
- 10 MiB maximum file size, 5 MiB maximum document, 128 MiB aggregate active upload storage quota, two concurrent uploads per client, and 32 concurrent downloads globally.
- Separate control-message and binary-chunk rate limits.
- Manifest pages contain at most 250 entries; a manifest is capped at 20,000 paths and 512 MiB of eligible scanned content.
- Workspace-relative paths only; symlinks and special files are refused.

## Checks and tests

```bash
npm ci
npm run check
npm test
```

Tests cover path and symlink safety, access roles and CLI token rotation, OT convergence, file operations, chunk retries, restart-resumable uploads, a 10 MiB binary transfer, viewer write denial, browser-Origin allowlisting, 10 MiB transfer throughput, and 40 concurrent collaborators (20 server tests total).

## Operational guidance

Use a reverse proxy with TLS/WSS, keep `DATA_DIR` writable only by the service account, back it up with the provided `scripts/backup-server.sh`, and test restore before deployment. `GET /healthz` returns non-sensitive health information only.


## Release version

This package is released with Jelo Co-Lab v1.7.9. The repository release preflight checks both package manifests and lockfile roots against the Git tag before packaging. The WebSocket runtime is pinned to 8.22.1.
