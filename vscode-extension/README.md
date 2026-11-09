<p align="center">
  <img src="resources/jelo-colab.svg" width="76" alt="Jelo Co-Lab">
</p>

# Jelo Co-Lab — Collaborative Editing for VS Code

**Bring your team into the same workspace. Keep the server under your control.**

Jelo Co-Lab is a self-hosted collaboration extension for Visual Studio Code. It combines live document editing, collaborator presence, workspace file synchronization, offline recovery, and conflict resolution with a server that you operate yourself.

## Highlights

- **Live multi-user editing:** Server-authoritative Operational Transformation coordinates concurrent text changes.
- **Know who is there:** See connected contributors, their workspace roles, and the documents they have open.
- **A useful workspace dashboard:** Connection state, latency, collaborator count, pending work, active transfers, failed transfers, and conflicts in one responsive view.
- **Reliable file sync:** Manifest-based reconciliation, acknowledged chunk uploads, SHA-256 verification, retry, and resumable uploads.
- **Resolve conflicts safely:** Compare local and remote versions. Recovery copies are preserved before a potentially destructive snapshot choice.
- **Offline-aware:** Local edits and file operations can queue while disconnected and replay on reconnect when the server still has the required history.
- **Self-hosted:** Your team chooses the server, data directory, access policy, and retention/backup process.

## Get started

1. Install the Jelo Co-Lab server on Ubuntu/Debian. Follow the [server setup guide](https://github.com/Jelofen1962/Jelo-Co-Lab/blob/main/server/README.md).
2. Ask your server administrator for the server URL, workspace ID, user ID, and invitation token.
3. Install this extension from the Visual Studio Marketplace when published, or install the `.vsix` from the project's [GitHub Releases](https://github.com/Jelofen1962/Jelo-Co-Lab/releases) using **Extensions → `…` → Install from VSIX…**.
4. Open a project folder in VS Code.
5. Open **Jelo Co-Lab** from the Activity Bar and choose **Set up & connect**.
6. Enter your connection details. The token prompt is a password field and stores the token in VS Code SecretStorage.
7. Review and run workspace reconciliation. Check the excluded-file policy before sharing.

For a step-by-step walkthrough, use **Jelo Co-Lab: Open Setup Tutorial** from the Command Palette or open the included `TUTORIAL.md` guide.

## The Overview dashboard

The Jelo Co-Lab Activity Bar view includes an adaptive Overview dashboard. It uses your current VS Code theme and is designed for both narrow sidebars and wider panes.

The dashboard includes:

- Connection state, workspace, server, signed-in user, role and latency.
- Collaborator, queued-item, active-transfer and conflict counters.
- Actions for connect/disconnect, directory synchronization, reconciliation, conflicts, retry, diagnostics, transfer pause/resume and the tutorial.
- A compact list of connected collaborators and the documents they have open.
- Focus-visible controls, accessible button names and descriptive hover tooltips.

The separate **Collaborators**, **Transfer Queue**, and **Conflicts** views remain available for detailed navigation.

## Commands

| Command | Description |
|---|---|
| **Jelo Co-Lab: Setup and Test Connection** | Configure and validate your server/workspace credentials. |
| **Jelo Co-Lab: Start Connection** | Connect to the configured workspace. |
| **Jelo Co-Lab: Quick Start** | Open the guided configuration flow. |
| **Jelo Co-Lab: Disconnect** | Disconnect without deleting queued local work. |
| **Jelo Co-Lab: Push/Sync Directory** | Review eligible files and select files to synchronize. |
| **Jelo Co-Lab: Reconcile Workspace** | Compare your files with the server manifest. |
| **Jelo Co-Lab: Open Conflict Center** | Review local/remote conflicts and choose a resolution. |
| **Jelo Co-Lab: Pause File Transfers** | Pause file transfers. Live text editing requires an active connection. |
| **Jelo Co-Lab: Resume File Transfers** | Resume queued file transfers. |
| **Jelo Co-Lab: Retry Pending Synchronization** | Retry pending text operations, file operations and transfers. |
| **Jelo Co-Lab: Show Network Diagnostics** | Inspect connection status, role, latency and pending work. |
| **Jelo Co-Lab: Open Setup Tutorial** | Open the included setup and collaboration guide. |

## Workspace roles

| Role | Edit documents | Upload and modify files | Read files | Manage members |
|---|---:|---:|---:|---:|
| Admin | Yes | Yes | Yes | Yes, through server administration |
| Editor | Yes | Yes | Yes | No |
| Viewer | No | No | Yes | No |

Roles are enforced by the server. A viewer cannot write to a document or upload file content.

## Settings

| Setting | Default | Description |
|---|---|---|
| `collab.serverUrl` | `ws://localhost:3000` | WebSocket endpoint. Use `wss://` for all remote servers. |
| `collab.workspaceId` | `demo-workspace` | Workspace identifier issued by your administrator. |
| `collab.userId` | Generated | Unique contributor ID for this workspace. |
| `collab.excludePatterns` | `[]` | Extra workspace-relative patterns excluded from uploads. Built-in security exclusions cannot be overridden. |
| `collab.autoReconcile` | `true` | Offer reconciliation after connection/reconnection. |

Your invitation token is stored in VS Code SecretStorage. Do not paste it into `settings.json`, commit it to Git, or share it in a public issue.

## File safety and limits

- Individual files: up to 10 MiB.
- Collaborative documents: up to 5 MiB.
- File transfer: checksummed 48 KiB chunks with acknowledgments.
- Common secret files, keys, repository metadata, dependency folders, caches and build output are excluded by default.
- Symlinks and special files are not synchronized by the server.
- Review the file selection and conflict prompts before applying changes.

Jelo Co-Lab does not replace Git. Commit your work regularly and keep backups of important projects. Do not use it to distribute credentials, private keys, production secrets, or data you are not authorized to share.

## Supported platforms

The extension's automated Extension Host release tests target **Windows and Ubuntu Linux**. The collaboration server is intended for Ubuntu/Debian Linux with Node.js 20 or newer. macOS is not a supported or tested release target.

## Troubleshooting

**The connection stays disconnected**

- Check that the server is healthy: `curl https://your-domain/healthz` (or locally `curl http://127.0.0.1:3000/healthz`).
- Use `wss://` for a remote server. `ws://` is restricted to localhost.
- Confirm that the workspace ID, user ID and invitation token match the server's member record.
- Ask the administrator to check `sudo journalctl -u jelo-colab -n 100 --no-pager`.

**A file does not appear**

- Open the Transfer Queue and check for a failed transfer.
- Confirm the file is not excluded and is below the 10 MiB limit.
- Run **Reconcile Workspace** to compare local and remote manifests.

**A conflict appears**

- Open the Conflict Center.
- Review the path and conflict reason.
- Keep the local version, use the server version, or postpone resolution as appropriate. Recovery copies are stored in the extension's global storage directory.

**Diagnostics**

Run **Jelo Co-Lab: Show Network Diagnostics**. The summary can be copied without exposing the invitation token.

## Privacy

The server operator controls the server, member list, workspace storage, logs and backups. The extension sends document edits, file content selected for synchronization, presence/cursor information and protocol metadata to that server. It does not send workspace contents to a Jelo-hosted cloud service.

## Links

- [Project repository](https://github.com/Jelofen1962/Jelo-Co-Lab)
- [GitHub Releases](https://github.com/Jelofen1962/Jelo-Co-Lab/releases)
- [Server installation and administration](https://github.com/Jelofen1962/Jelo-Co-Lab/blob/main/server/README.md)
- [Step-by-step tutorial](https://github.com/Jelofen1962/Jelo-Co-Lab/blob/main/docs/USER-TUTORIAL.md)
- [Security policy](https://github.com/Jelofen1962/Jelo-Co-Lab/blob/main/SECURITY.md)
- [MIT License](https://github.com/Jelofen1962/Jelo-Co-Lab/blob/main/LICENSE)
