# Jelo Co-Lab Server

The Jelo Co-Lab server is a self-hosted Node.js WebSocket service for collaborative editing, workspace synchronization, presence, access control, and resumable file transfer.

**Recommended deployment:** Ubuntu/Debian Linux, Node.js 20+, systemd, and a public DNS name with TLS/WSS for remote access.

## 1. Zero-to-hero installation

Run the guided installer on a fresh Ubuntu/Debian server:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh | sudo bash
```

To pin a specific published release:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh \
  | sudo env JELO_VERSION=v1.8.0 bash
```

The guided setup:

1. Confirms the OS, root privileges, package manager and systemd availability.
2. Installs its small set of operating-system prerequisites.
3. Downloads the selected GitHub server ZIP and its SHA-256 file.
4. Verifies the archive checksum and rejects unsafe archive paths.
5. Runs `npm ci`, the server syntax checks, and the server test suite in a temporary staging directory before activating the release.
6. Creates the restricted `jelo-colab` service account and persistent data directory.
7. Installs the systemd service and a `jelo-colab` management command.
8. Creates the first workspace administrator and stores the one-time invitation in a root-only file.
9. Checks the local `/healthz` endpoint, detects LAN addresses, and optionally configures Caddy for HTTPS/WSS.
10. Offers to open the interactive server manager.

The setup wizard defaults to the latest published release. Do not run it before the desired release has been published. The installer is designed for a clean Ubuntu/Debian host; review the script before piping it into a root shell on an existing production machine. Its `whiptail` dialogs attach to the controlling terminal, so the documented `curl | sudo bash` command works from a normal interactive SSH/console session.

For unattended setup without a TTY, supply workspace/admin IDs and explicit confirmation:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh \
  | sudo env JELO_WORKSPACE_ID=team-workspace JELO_ADMIN_USER_ID=admin JELO_CONFIRM=yes bash
```

Optional environment variables: `JELO_VERSION`, `JELO_DOMAIN`, and `JELO_LOOKUP_PUBLIC_IP=true`. Public-IP lookup is opt-in because it contacts a third-party IP lookup service.

## 2. Server manager TUI

Open the manager at any time:

```bash
sudo jelo-colab
```

The terminal dashboard displays service state, API health, server version, uptime, connected clients, process memory, data disk space, and detected LAN IPv4 addresses.

Menu actions:

| Action | What it does |
|---|---|
| Service status | Shows the full systemd status. |
| Restart service | Restarts the Node.js service. |
| Start / stop | Starts or stops the service. |
| Live logs | Follows the service journal; press Ctrl+C to return. |
| Workspace members | Lists, adds, rotates, or removes workspace invitations. |
| Create backup | Runs the verified backup script. |
| Restore backup | Validates and restores a selected backup after an explicit confirmation. |
| Configure TLS | Installs/configures Caddy for a public DNS name. |
| Network addresses | Shows LAN addresses; public-IP lookup is optional and only runs when requested. |
| Run diagnostics | Checks systemd, the health endpoint, recent errors, and Node.js. |

The manager requires root because service management, backup/restore, and workspace membership operations are privileged. It uses the system's `systemctl`, `journalctl`, `runuser`, and the Node.js runtime; it does not require a separate npm UI framework.

## 3. Connection and network model

The server binds to `127.0.0.1:3000` by default. This avoids exposing an unauthenticated plain-WebSocket listener on a public interface. For remote contributors, put a TLS reverse proxy in front of the local server.

### Caddy helper

Provide a DNS hostname whose A/AAAA records point to this server:

```bash
sudo /opt/jelo-colab/scripts/configure-caddy.sh collab.example.com
```

The helper installs Caddy, backs up an existing Caddyfile, configures a reverse proxy to `127.0.0.1:3000`, validates the configuration and starts/reloads Caddy. Ensure inbound TCP ports **80 and 443** are reachable and your DNS records have propagated.

The VS Code extension should use:

```text
wss://collab.example.com
```

Never expose `ws://` over the public internet. A LAN address is useful for diagnostics, but it is not a secure remote endpoint unless you have deliberately configured TLS and network policy for it.

### Port summary

| Port | Use | Exposure |
|---|---|---|
| TCP 3000 | Local HTTP health check and WebSocket service | Localhost by default; do not open publicly |
| TCP 80 | Caddy HTTP challenge / redirect | Public when using Caddy automatic HTTPS |
| TCP 443 | HTTPS/WSS endpoint | Public when using Caddy |

## 4. Workspace member and role management

The setup wizard creates the first administrator and saves the one-time invitation output to:

```text
/root/jelo-colab-<workspace>-<admin>-invitation.txt
```

Read it locally as root and transfer the token to the administrator through a secure channel. The token is not written into the installer log.

The manager can administer memberships. Equivalent commands:

```bash
sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js list team-workspace

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js add team-workspace alice editor

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js add team-workspace guest viewer

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js rotate team-workspace alice editor

sudo -u jelo-colab env DATA_DIR=/var/lib/jelo-colab \
  node /opt/jelo-colab/manage-access.js remove team-workspace guest
```

Roles:

- **Admin:** edit documents, upload and change files, read files, and manage membership.
- **Editor:** edit documents and synchronize files; cannot manage members.
- **Viewer:** read and download; server rejects edit and upload operations.

The first member of a workspace must be an admin. The CLI prevents removing or demoting the last admin. Member invitation tokens are random 256-bit values; the server stores salted scrypt hashes, not recoverable plaintext tokens. The token is displayed once when created or rotated.

## 5. Environment configuration

The installer creates `/etc/jelo-colab.env` with mode `0600`.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | HTTP/WebSocket bind address. Keep localhost behind a TLS reverse proxy for remote access. |
| `PORT` | `3000` | HTTP/WebSocket port. |
| `COLLAB_TOKEN` | Generated during installation | Bootstrap secret used only for workspaces without a configured membership store. Keep it private. |
| `DATA_DIR` | `/var/lib/jelo-colab` | Workspace files, access records, document state, upload records and audit logs. |
| `ALLOWED_ORIGINS` | Empty | Optional comma-separated browser Origin allowlist. VS Code's Node WebSocket client does not send a browser Origin header. |

After changing environment values:

```bash
sudo systemctl restart jelo-colab
sudo systemctl status jelo-colab
```

Do not commit `/etc/jelo-colab.env` or copy its contents into support requests.

## 6. Health, status and logs

Local health endpoint:

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

It returns the service name/version, uptime, current WebSocket connection count and process RSS. It does not return member tokens or file contents.

Operations:

```bash
sudo systemctl status jelo-colab
sudo journalctl -u jelo-colab -f
sudo journalctl -u jelo-colab -n 200 --no-pager
sudo systemctl restart jelo-colab
sudo systemctl stop jelo-colab
sudo systemctl start jelo-colab
```

## 7. Backups and restore

Create a backup:

```bash
sudo /opt/jelo-colab/scripts/backup-server.sh
```

Backups include the persistent data directory and `/etc/jelo-colab.env`. The backup helper locks against concurrent backup/restore, stops the service while taking a consistent archive, validates the archive, writes a SHA-256 sidecar and applies retention.

Install the daily backup timer:

```bash
sudo /opt/jelo-colab/scripts/install-backup-timer.sh
```

Restore a backup:

```bash
sudo /opt/jelo-colab/scripts/restore-server.sh \
  /var/backups/jelo-colab/jelo-colab-YYYYMMDDTHHMMSSZ.tar.gz
```

The restore script verifies the checksum and archive member paths, refuses links/special files, creates pre-restore copies, and restarts the service if it was active. Test restore on a separate host before treating a backup as reliable. Keep at least one encrypted off-host copy.

## 8. Storage layout and limits

Default data directory: `/var/lib/jelo-colab`.

- `workspaces/<workspaceId>/` — synchronized regular files.
- `access.json` — workspace member roles and salted token hashes; mode `0600`.
- `audit.jsonl` and rotated audit log — membership and security events.
- `state/` — document snapshots and bounded OT history.
- `state/uploads/` — resumable partial uploads and metadata.

Current safety caps include a 10 MiB maximum file, a 5 MiB collaborative document limit, 48 KiB binary chunks, a bounded active-upload storage quota, a maximum of 100 WebSocket clients, and bounded/paged workspace manifests. Symlinks and special files are refused.

## 9. Manual installation and development

Requirements: Ubuntu/Debian with systemd actively running, Node.js 20+, npm, `curl`, `unzip`, `sha256sum`, `runuser`, and a non-root service account for production. The guided installer rejects containers or WSL environments without an active systemd instance.

For a development server:

```bash
cd server
node ../scripts/refresh-ws-lockfile.cjs
npm ci
npm run check
npm test
COLLAB_TOKEN="$(openssl rand -hex 32)" npm start
```

Production deployment should use the provided installer and systemd unit rather than running `npm start` in an interactive shell.

## 10. Troubleshooting

**Service does not start**

```bash
sudo systemctl status jelo-colab
sudo journalctl -u jelo-colab -n 200 --no-pager
sudo cat /etc/jelo-colab.env | sed 's/^COLLAB_TOKEN=.*/COLLAB_TOKEN=[redacted]/'
```

Confirm Node.js 20+, a valid token, a writable `/var/lib/jelo-colab` directory, and a valid `PORT` value. Do not paste the unredacted environment file into an issue.

**Health check works locally but extension cannot connect**

Check Caddy status, DNS A/AAAA records, inbound ports 80/443, certificate issuance, and the extension's `wss://` URL:

```bash
sudo systemctl status caddy
sudo journalctl -u caddy -n 100 --no-pager
```

**Authentication fails**

Check workspace ID and user ID. Confirm that the member exists and issue a new invitation with the manager if necessary. Existing workspaces with membership records require a valid member token; the bootstrap token does not bypass a configured membership list.

**Disk or transfer problems**

Use `sudo jelo-colab` → diagnostics, review the service journal, and check free space in `/var/lib/jelo-colab`. Individual files above the transfer limit are rejected by design.

## 11. Security notes

- Keep the server behind TLS/WSS for remote access.
- Never publish the bootstrap or member invitation token.
- Restrict `/etc/jelo-colab.env`, `/var/lib/jelo-colab`, and backup archives.
- Keep the operating system and Node.js patched.
- Review the workspace exclusion policy before sharing.
- Restrict inbound ports to 80/443 for a public Caddy deployment; do not expose port 3000.
- Report suspected vulnerabilities using the process in the repository's `SECURITY.md`.
