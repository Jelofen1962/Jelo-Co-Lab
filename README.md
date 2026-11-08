# Jelo Co-Lab

> v1.7.9 is a release-only correction: package versions and lockfile graphs now match the tag, ws is pinned to 8.22.1, and release validation is implemented inline in GitHub Actions (no external verifier script is required) and runs before platform builds. No application behavior changes.

Self-hosted collaborative editing for Visual Studio Code. The product functionality from v1.7.0 remains unchanged in this release-only patch. The release pipeline now checks server and extension package versions against the tag, verifies lockfile dependency graphs, refreshes registry integrity metadata before clean installs, and gates releases on Windows and Ubuntu Extension Host tests.

The editor uses server-authoritative versioned OT. It is not a CRDT. The server serializes document operations, transforms edits against retained history, and persists the current revision plus bounded history for reconnect. See [the protocol reference](docs/PHASE-2-PROTOCOL.md) and [Phase 3/4 operations](docs/PHASE-3-4.md).

## Release assets

Each GitHub Release created from a `v*` tag contains:

- `jelofen-co-lab-vX.Y.Z.vsix` — installable VS Code extension.
- `jelo-colab-server-vX.Y.Z.zip` — standalone server and operational scripts.
- SHA-256 sidecars for both release assets.
- GitHub build-provenance attestations for the VSIX and server ZIP.

The release workflow verifies tag/package version agreement, runs server checks and tests, compiles and packages the extension, checks that the `ws` runtime dependency is present in the VSIX, creates server assets, and publishes the release. Both CI and tagged releases run the Extension Host suite on Ubuntu and Windows. The artifact-packaging job runs on Ubuntu only after both platform test jobs pass. The test suite uses Node.js built-in assertions and does not require Mocha. Test files and test-only dependencies are excluded from the published VSIX.

## Install the server on Ubuntu/Debian

After publishing a GitHub release, run this single command on Ubuntu 22.04/24.04 or Debian 12+:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/install-server.sh | sudo bash
```

The installer generates a strong server bootstrap token on a fresh install, reuses the existing token on upgrade, verifies the downloaded release ZIP against its SHA-256 sidecar, installs Node.js 20+, installs production dependencies, runs the server checks/tests, creates a restricted systemd service, and checks `/healthz`.

To install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/install-server.sh | sudo env JELO_VERSION=v1.7.9 bash
```

To provide your own bootstrap token on a fresh install:

```bash
sudo env COLLAB_TOKEN='YOUR_24_TO_256_CHARACTER_TOKEN' bash
```

The token must contain 24–256 letters, numbers, `_` or `-`. Retrieve the generated bootstrap token locally:

```bash
sudo awk -F= '/^COLLAB_TOKEN=/ {print $2}' /etc/jelo-colab.env
```

### What the installer configures

- Node.js 20+ and production-only dependencies.
- Dedicated `jelo-colab` system user.
- Root-owned application files in `/opt/jelo-colab`.
- Workspace, access-control, audit, and synchronization state in `/var/lib/jelo-colab`.
- Root-only environment file at `/etc/jelo-colab.env`.
- systemd restart policy, service sandboxing, and localhost-only binding at `127.0.0.1:3000`.
- SHA-256 verification and server regression tests before service activation.

The installer supports apt-based Ubuntu/Debian systems. It does not automatically configure your cloud firewall or domain DNS.

## Configure remote TLS/WSS with Caddy

Point a DNS A/AAAA record at the server and allow inbound TCP 80 and 443. Then run:

```bash
sudo /opt/jelo-colab/scripts/configure-caddy.sh collab.example.com
```

The helper installs Caddy from its official Debian repository, backs up the previous Caddyfile, configures reverse proxying to `127.0.0.1:3000`, validates the configuration, and starts Caddy. Use `wss://collab.example.com` in VS Code. The Co-Lab server remains bound to localhost; do not expose plain `ws://` to the internet.

## Configure workspace users and roles

The bootstrap token grants administrator access only while a workspace has no entry in `access.json`. To use individual accounts, create the first workspace administrator. The first member must be an administrator, preventing accidental creation of a workspace with no admin.

Run management commands as the service user so ownership and file permissions remain correct:

```bash
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js add engineering alice admin
```

The CLI prints a new random token once. Store it in the user's VS Code Jelo Co-Lab configuration. It is stored in VS Code SecretStorage, not `settings.json`.

Add another editor or viewer:

```bash
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js add engineering bob editor

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js add engineering guest viewer
```

List members, rotate a token, or remove a member:

```bash
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js list engineering

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js rotate engineering bob editor

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js remove engineering guest
```

Roles:

| Role | Capabilities |
|---|---|
| `admin` | Read, edit, upload, delete, rename, and manage membership offline through the server CLI. |
| `editor` | Read, edit, upload, delete, and rename. Cannot manage membership. |
| `viewer` | Read documents/files and see presence. Mutating operations are rejected by the server. |

Tokens are stored as salted scrypt hashes in `/var/lib/jelo-colab/access.json`. The CLI writes membership changes to the administrative audit log and prevents removing or demoting the last admin. Once a workspace has a managed membership entry, the bootstrap token no longer bypasses membership checks for that workspace.

## Install the VS Code extension

1. Download `jelofen-co-lab-v1.7.9.vsix` from the GitHub Release.
2. In VS Code, open **Extensions** (`Ctrl+Shift+X`).
3. Select `...` → **Install from VSIX...** and choose the downloaded file.
4. Open a file inside a workspace.
5. Run **Jelo Co-Lab: Setup and Test Connection**.
6. Enter the server URL (`ws://localhost:3000` for local testing or remote `wss://`), workspace ID, your workspace-member token, and a unique user ID.
7. Review the workspace folders and connect.

The Jelo Co-Lab activity bar contains three views: **Collaborators**, **Transfer Queue**, and **Conflicts**. The status bar reports connection state, collaborator count, latency, and role. The Command Palette also exposes connection, synchronization, transfer, conflict, and diagnostics commands.

## Phase 3 capabilities: user experience and recovery

- **Guided onboarding:** validates the server URL, checks `/healthz`, captures a workspace ID and SecretStorage token, previews the local workspace folders, then joins the workspace.
- **Collaborator sidebar:** shows connected user IDs and the documents each collaborator has open. Selecting a collaborator lets you jump to one of their shared documents.
- **Transfer queue:** shows queued, uploading, downloading, completed, and failed files. Transfers can be paused/resumed and retried per file. Upload queues survive extension restarts.
- **Conflict center:** lets users open the local file, keep local content, accept the server copy, accept a remote deletion, or resolve a remote rename. Local unsaved text is saved to recovery storage before a remote replacement/deletion.
- **Offline manifest reconciliation:** on join/reconnect, compares local and server manifests (path, size, SHA-256) to discover remote creates, deletes and changes. It detects a straightforward offline rename when exactly one new remote path matches the last-known hash. Ambiguous changes are presented as conflicts rather than guessed.
- **Presence/network feedback:** heartbeats detect stale sessions, latency appears in the status bar and diagnostics, and reconnection uses bounded exponential backoff.
- **Accessibility:** tree items expose accessible labels, empty views have action links, and primary flows are available from the Command Palette.

## Phase 4 capabilities: production operations

- **Scoped accounts:** workspace member tokens, `admin`/`editor`/`viewer` roles, scrypt-hashed tokens, token rotation, last-admin protection, and audit records.
- **Binary chunk uploads:** 48 KiB binary frames, SHA-256 verification, ordered acknowledgments, server-side partial files, and durable resume from the last persisted chunk after server restart. Each file is limited to 10 MiB; global active upload storage is capped.
- **Rate limiting:** control messages and bulk binary chunks use separate token buckets. Bulk traffic remains bounded by per-file size and global in-flight byte quotas.
- **Download integrity:** binary chunks are acknowledged and retried, and the complete payload is hash-verified before local apply. A disconnected download restarts on reconnect; upload partials are durable across server restarts.
- **Audit trail:** authentication failures, joins, file writes/deletes/moves, stale sessions, shutdowns and CLI membership changes are written to `audit.jsonl` with one rotated backup.
- **Backup/restore:** consistent backup archives include workspace data, document state, membership store, audit logs, and the server environment file. Restore verifies the checksum, rejects links/special files and unexpected paths, and preserves a pre-restore copy.
- **Scheduled backups:** install a daily systemd timer with `/opt/jelo-colab/scripts/install-backup-timer.sh`.
- **Build provenance:** GitHub Actions creates build-provenance attestations for both release payloads.
- **Operational docs:** license, contribution guide, support policy, security policy, protocol documentation and runbooks are included.

### Backup and restore

Create a consistent manual backup:

```bash
sudo /opt/jelo-colab/scripts/backup-server.sh
```

Install a daily backup timer:

```bash
sudo /opt/jelo-colab/scripts/install-backup-timer.sh
systemctl list-timers jelo-colab-backup.timer --no-pager
```

Restore a verified backup (the script preserves the previous data and environment files):

```bash
sudo /opt/jelo-colab/scripts/restore-server.sh /var/backups/jelo-colab/jelo-colab-YYYYMMDDTHHMMSSZ.tar.gz
```

Backups default to `/var/backups/jelo-colab`, are root-readable only, and retain 30 days by default. Set `RETENTION_DAYS` to change retention. Test restores on a staging server before relying on backups for disaster recovery.

## Server diagnostics

```bash
sudo systemctl status jelo-colab
sudo journalctl -u jelo-colab -f
sudo journalctl -u jelo-colab -n 200 --no-pager
sudo systemctl restart jelo-colab
sudo systemctl stop jelo-colab
curl -fsS http://127.0.0.1:3000/healthz
```

Useful paths:

| Purpose | Path |
|---|---|
| Application and admin CLI | `/opt/jelo-colab` |
| Environment/bootstrap secret | `/etc/jelo-colab.env` |
| Workspace files, access store, document state and audit log | `/var/lib/jelo-colab` |
| Installer log | `/var/log/jelo-colab-install.log` |
| Backup archive | `/var/backups/jelo-colab` |
| systemd service | `/etc/systemd/system/jelo-colab.service` |

The health endpoint returns service status, version, uptime, active connection count, and process memory usage. It does not expose credentials or workspace contents.

## Build and test from source

Requirements: Node.js 20+, npm, and `@vscode/vsce` for VSIX packaging. The Extension Host suite uses the lightweight Node.js assertion runner bundled with the repository; it does not require Mocha.

```bash
cd server
npm install --package-lock-only --ignore-scripts
npm ci
npm run check
npm test
COLLAB_TOKEN="$(openssl rand -hex 32)" npm start
```

In another terminal:

```bash
cd vscode-extension
npm install --package-lock-only --ignore-scripts
npm ci
npm run compile
npx --yes @vscode/vsce package
```

Run the VS Code Extension Host suite (requires downloading VS Code and the test harness):

```bash
npm install --no-save --package-lock=false @vscode/test-electron@2.5.2
npm test
```

The Extension Host tests run in GitHub Actions on Windows and Ubuntu only. Ubuntu uses `xvfb-run` for a headless display. macOS is not a supported CI target or release target.

## Security and limits

- Server requires a 24–256 character bootstrap token at startup.
- Remote VS Code clients must use `wss://`; the server binds to localhost by default.
- Paths are workspace-relative; symlinks, path traversal, special files, secret files and excluded directories are rejected.
- File snapshots are limited to 10 MiB. Workspace manifests are capped at 20,000 entries and 512 MiB of scanned eligible content.
- Document content is limited to 5 MiB and operation history is bounded. Very stale clients may need snapshot recovery.
- There is no built-in web UI, cloud identity provider, end-to-end encryption, or multi-server/high-availability mode. The TLS reverse proxy encrypts transport between clients and the server; the server can read workspace content.

See [SECURITY.md](SECURITY.md) before exposing the service to an untrusted network.

## Clean dependency installation

The server and extension pin the patched WebSocket runtime to `ws@8.22.1`. The committed lockfiles include the exact package graph; CI refreshes registry integrity metadata before clean installation and verifies it before release. For a local clean install, run from each package directory:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
```

Before creating a release tag, verify both packages match the intended tag:

```bash
The release workflow validates both package manifests, lockfile roots, and the pinned ws runtime directly before building.
```

