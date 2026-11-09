<p align="center">
  <img src="vscode-extension/resources/jelo-colab.svg" width="88" alt="Jelo Co-Lab logo">
</p>

<h1 align="center">Jelo Co-Lab</h1>

<p align="center"><strong>Self-hosted collaborative editing and workspace synchronization for Visual Studio Code.</strong></p>

<p align="center">
  <a href="https://github.com/Jelofen1962/Jelo-Co-Lab/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Jelofen1962/Jelo-Co-Lab/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Jelofen1962/Jelo-Co-Lab/actions/workflows/release.yml"><img alt="Release" src="https://github.com/Jelofen1962/Jelo-Co-Lab/actions/workflows/release.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

Jelo Co-Lab lets a team edit the same project with live document collaboration, see who is connected, synchronize files, recover after interruptions, and keep control of where workspace data is stored. You run the server; contributors connect from the VS Code extension.

> **Supported clients:** Windows and Ubuntu/Linux VS Code installations.  
> **Supported server:** Ubuntu/Debian Linux with Node.js 20+ and systemd.  
> **Remote connections:** Use HTTPS/WSS through a TLS reverse proxy. Plain `ws://` is accepted only for localhost development.

[Releases](https://github.com/Jelofen1962/Jelo-Co-Lab/releases) · [Issues](https://github.com/Jelofen1962/Jelo-Co-Lab/issues) · [Security](SECURITY.md) · [Tutorial](docs/USER-TUTORIAL.md) · [Server guide](server/README.md) · [Extension listing copy](vscode-extension/README.md)

---

## What it does

- **Live collaborative editing:** Server-authoritative Operational Transformation (OT) coordinates concurrent text edits and keeps document revisions ordered.
- **Presence:** See connected collaborators, their roles, and the documents they currently have open.
- **Workspace synchronization:** Compare local files with the server manifest and reconcile additions, changes, deletions, and unambiguous renames.
- **Reliable transfers:** Transfer files in acknowledged, checksummed chunks with retry and resumable upload support.
- **Conflict handling:** Preserve local recovery copies and ask before choosing between divergent local and remote file versions.
- **Offline tolerance:** Queue local edits and file operations for reconnect. When document history is no longer available, request a snapshot and preserve local content rather than silently discarding it.
- **Access control:** Workspace-scoped admin, editor, and viewer roles. Member tokens are stored as salted scrypt hashes on the server and in VS Code SecretStorage on the client.
- **Server operations:** Guided Ubuntu/Debian setup, a terminal management interface, health checks, logs, TLS proxy helper, backup, and restore scripts.

## Architecture

```text
┌──────────────────────┐       WSS / WebSocket       ┌────────────────────────┐
│ VS Code: Contributor │ ◀────────────────────────▶ │ Jelo Co-Lab Server     │
│                      │                              │                        │
│ • Dashboard          │                              │ • Workspace auth       │
│ • Live editor / OT   │                              │ • OT revisions/history │
│ • Presence/cursors   │                              │ • Manifest/reconcile   │
│ • Transfer queue     │                              │ • Chunked file transfer│
│ • Conflict center    │                              │ • Audit / persistence  │
└──────────────────────┘                              └───────────┬────────────┘
                                                                │
                                                   ┌────────────▼───────────┐
                                                   │ Persistent server data │
                                                   │ files · state · access │
                                                   │ audit · upload resume  │
                                                   └────────────────────────┘
```

The server is authoritative for document revisions and workspace permissions. Files are stored under the server data directory. The extension does not require a third-party collaboration account or hosted relay.

## Quick start

### 1. Install the server

On a fresh Ubuntu/Debian server with sudo access:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh | sudo bash
```

To install a specific release instead of the latest published release:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh \
  | sudo env JELO_VERSION=v1.8.0 bash
```

The guided setup checks the platform, downloads the release and checksum, runs the server's install-time checks, creates the first workspace administrator, verifies `/healthz`, displays detected addresses, and offers to open the server manager. It stores the initial administrator invitation in a root-only file and does not print the invitation into the installer log. Public-IP lookup is optional. For unattended setup without a terminal, provide `JELO_WORKSPACE_ID`, `JELO_ADMIN_USER_ID`, and `JELO_CONFIRM=yes`; see the [server guide](server/README.md).

For a remote server, provide a public DNS name during setup. The setup can configure Caddy for automatic HTTPS/WSS. Your DNS A/AAAA records must point to the server, and inbound TCP ports 80 and 443 must be reachable.

### 2. Open the server manager

```bash
sudo jelo-colab
```

The terminal interface shows service health, version, uptime, connected clients, memory, disk space, and LAN addresses. It also provides service controls, live logs, workspace member management, backup/restore, TLS configuration, and diagnostics.

Useful commands without the TUI:

```bash
sudo systemctl status jelo-colab
sudo journalctl -u jelo-colab -f
curl http://127.0.0.1:3000/healthz
```

See [server/README.md](server/README.md) for manual installation, firewall guidance, roles, backup policy, and troubleshooting.

### 3. Install the VS Code extension

1. Download `jelofen-co-lab-v1.8.0.vsix` from the [GitHub Releases page](https://github.com/Jelofen1962/Jelo-Co-Lab/releases).
2. In VS Code, open **Extensions → `…` → Install from VSIX…**.
3. Select the downloaded VSIX and reload VS Code if prompted.
4. Open the project folder you want to share.
5. Open the **Jelo Co-Lab** Activity Bar view and select **Set up & connect**.
6. Enter the WSS server URL, workspace ID, invitation token, and your unique user ID.
7. Connect, then review the workspace reconciliation preview before sharing files.

The first admin invitation is created during server setup. Use the server manager to add editor/viewer invitations for other contributors. An invitation token is shown only when it is issued or rotated; save it securely.

## Roles

| Role | Live document edits | Upload/change files | Read and download | Manage members |
|---|---:|---:|---:|---:|
| **Admin** | Yes | Yes | Yes | Yes, through server manager |
| **Editor** | Yes | Yes | Yes | No |
| **Viewer** | No | No | Yes | No |

The server enforces these permissions. Hiding a button in the extension is not treated as an authorization control.

## Extension interface

The Activity Bar includes a responsive Overview dashboard and dedicated **Collaborators**, **Transfer Queue**, and **Conflicts** views. The dashboard adapts to narrow sidebars and larger panes, uses VS Code theme colors, supports keyboard focus, and provides accessible labels and tooltips for actions.

Main commands:

| Command | Purpose |
|---|---|
| `Jelo Co-Lab: Setup and Test Connection` | Configure server, workspace and invitation token |
| `Jelo Co-Lab: Start Connection` | Connect to the configured workspace |
| `Jelo Co-Lab: Disconnect` | Disconnect while preserving queued local work |
| `Jelo Co-Lab: Reconcile Workspace` | Compare local and remote workspace manifests |
| `Jelo Co-Lab: Push/Sync Directory` | Select files to upload/synchronize |
| `Jelo Co-Lab: Open Conflict Center` | Resolve local/remote differences |
| `Jelo Co-Lab: Pause File Transfers` | Pause file synchronization |
| `Jelo Co-Lab: Resume File Transfers` | Resume queued transfers |
| `Jelo Co-Lab: Show Network Diagnostics` | Inspect connection, role, latency and queue state |
| `Jelo Co-Lab: Open Setup Tutorial` | Open the step-by-step guide included with the extension |

## Configuration

The extension exposes these workspace settings under `collab`:

| Setting | Default | Description |
|---|---|---|
| `collab.serverUrl` | `ws://localhost:3000` | Server WebSocket URL. Remote hosts require `wss://`. |
| `collab.workspaceId` | `demo-workspace` | Shared workspace identifier. |
| `collab.userId` | Generated | Unique contributor ID within the workspace. |
| `collab.excludePatterns` | `[]` | Additional relative glob-style file exclusions. Built-in secret/repository exclusions cannot be overridden. |
| `collab.autoReconcile` | `true` | Offer manifest reconciliation after connecting/reconnecting. |

The workspace token is stored using VS Code SecretStorage, not in workspace settings. Do not put credentials in `settings.json`, `.env` files, source code, or Git.

## Synchronization and safety limits

The server validates workspace IDs and relative paths, rejects symlinks and special files, checks member roles, and applies message and transfer limits. The default service listens on `127.0.0.1:3000` behind a reverse proxy.

Current protocol limits include:

- 10 MiB maximum individual file size.
- 5 MiB maximum collaborative document size.
- 48 KiB binary transfer chunks.
- Up to 100 simultaneous server WebSocket clients.
- Workspace manifests are paged and bounded; the server rejects manifests beyond configured safety caps.
- Generated folders, repository metadata, environment files, credentials, and common private-key files are excluded from synchronization by default.

**Important:** Jelo Co-Lab is a collaboration and synchronization tool, not a replacement for Git, backups, or code review. Keep normal source-control commits and tested backups. Review the exclusion policy before sharing a workspace. Do not share secrets or sensitive customer data.

## Development

Requirements: Node.js 20+, npm, and (for Extension Host tests) the VS Code Electron test harness. Extension Host CI runs on Ubuntu and Windows. The server is designed for Ubuntu/Debian Linux.

Server:

```bash
cd server
node ../scripts/refresh-ws-lockfile.cjs
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

Extension:

```bash
cd vscode-extension
node ../scripts/refresh-ws-lockfile.cjs
npm ci
npm run compile
npm install --no-save --package-lock=false @vscode/test-electron@2.5.2
npm test
npm audit --omit=dev --audit-level=high
```

Run both workflows locally only after registry access is available so the lockfile refresh can fetch the authentic npm tarball integrity metadata. Never invent or copy an integrity hash from a different package version.

## Repository layout

```text
.github/workflows/      CI and tagged release workflows
docs/                   Protocol, operations and user tutorial
scripts/                Install, setup, manager, backup, restore and release helpers
server/                 WebSocket server, OT, access control and server manager
vscode-extension/       VS Code extension source, webview dashboard and test runner
```

## Releases

A tagged release must pass version/lockfile validation, server tests, dependency audits, extension compilation, and Extension Host tests on **Ubuntu and Windows**. The release workflow publishes:

- `jelofen-co-lab-<tag>.vsix`
- `jelo-colab-server-<tag>.zip`
- SHA-256 checksum files
- GitHub build provenance attestations

Create a release tag only after the corresponding CI checks pass. Do not force-push or retag an existing release.

## Support and contribution

- Bugs and feature requests: [GitHub Issues](https://github.com/Jelofen1962/Jelo-Co-Lab/issues)
- Contribution process: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reporting: [SECURITY.md](SECURITY.md)
- Support information: [SUPPORT.md](SUPPORT.md)

Jelo Co-Lab is distributed under the MIT License. See [LICENSE](LICENSE).
