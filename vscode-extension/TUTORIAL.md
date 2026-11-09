# Jelo Co-Lab User Tutorial

This tutorial walks a workspace administrator and a contributor from first installation to everyday collaboration.

## Part A — Workspace administrator

### 1. Prepare a server

Use a fresh Ubuntu/Debian Linux server with systemd actively running. A public DNS hostname is recommended if contributors will connect over the internet. Point the domain's A/AAAA records to the server and allow inbound TCP 80 and 443.

Run the guided installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh | sudo bash
```

To select a particular release:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh \
  | sudo env JELO_VERSION=v1.8.0 bash
```

The wizard asks for a release, initial workspace ID, initial admin user ID, and optional domain. Its dialogs attach to the controlling terminal, so this command works from a normal interactive SSH session even though the script is piped into `sudo bash`. It verifies the published server ZIP checksum, runs the server checks and tests before activation, creates the systemd service, creates the first admin membership, validates the health endpoint, and displays local IP addresses. Public-IP lookup is optional and is performed only if you approve it.

For a non-interactive install (CI/automation), pass the required values and explicit confirmation:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/server-setup.sh \
  | sudo env JELO_WORKSPACE_ID=team-workspace JELO_ADMIN_USER_ID=admin JELO_CONFIRM=yes bash
```

Optional variables: `JELO_VERSION`, `JELO_DOMAIN`, and `JELO_LOOKUP_PUBLIC_IP=true`.

### 2. Save the administrator invitation

The wizard writes the first admin invitation to a root-only file, for example:

```text
/root/jelo-colab-team-workspace-admin-invitation.txt
```

Read it as root:

```bash
sudo cat /root/jelo-colab-team-workspace-admin-invitation.txt
```

The output contains the workspace ID, user ID, role and one-time token. Send the invitation to its intended user through a private channel. Do not paste it into GitHub, chat rooms, public logs, or issue reports.

### 3. Open the server manager

```bash
sudo jelo-colab
```

The dashboard shows server health and quick actions. Use **Workspace members** to add other users:

- `editor` can edit and synchronize files.
- `viewer` can read and download but cannot edit or upload.
- `admin` can manage the workspace membership as well as collaborate.

A new invitation token is shown only when created or rotated. Ask the recipient to save it securely.

### 4. Configure secure remote access

If the domain was not configured during setup:

```bash
sudo /opt/jelo-colab/scripts/configure-caddy.sh collab.example.com
```

Ensure DNS points to the server and TCP ports 80 and 443 are reachable. The extension endpoint is `wss://collab.example.com`. Do not expose `ws://` to the public internet.

### 5. Check the service

```bash
sudo systemctl status jelo-colab
curl -fsS http://127.0.0.1:3000/healthz
sudo journalctl -u jelo-colab -f
```

## Part B — Contributor setup

### 6. Install the extension

1. Download the VSIX from the project's GitHub Releases page.
2. Open VS Code → Extensions.
3. Open the Extensions view menu (`…`) → **Install from VSIX…**.
4. Select the downloaded `jelofen-co-lab-<version>.vsix`.
5. Reload VS Code if prompted.
6. Open the project folder you intend to share.

### 7. Configure your workspace connection

Open the **Jelo Co-Lab** Activity Bar icon and choose **Set up & connect**. Enter:

- **Server URL:** `wss://collab.example.com` for a remote server. Use `ws://localhost:3000` only for local development.
- **Workspace ID:** exactly the ID given by your administrator.
- **Invitation token:** the private token issued for your user ID and role.
- **User ID:** your unique identifier in that workspace. Each connected contributor must use a different ID.

The token prompt is masked and the token is stored in VS Code SecretStorage. It is not written to workspace settings.

Choose **Connect** after checking the workspace folders in the confirmation prompt.

### 8. Understand the dashboard

The Overview panel presents:

- **Connection:** Disconnected, Connecting or Connected.
- **Workspace / Server / Account:** the configured collaboration context.
- **Role:** your server-assigned permissions.
- **Latency:** recent connection round-trip measurement when available.
- **Collaborators:** connected users, excluding the local user in the list.
- **Queued items:** pending file transfers, file operations and offline text work.
- **Active transfers:** current uploads/downloads.
- **Conflicts:** unresolved local/remote differences.

Every action button includes a hover tooltip. The dashboard reflows into a compact one-column layout in a narrow sidebar and uses the active VS Code theme.

### 9. Start collaborating

1. Open a text file in the shared workspace.
2. Confirm the workspace is connected.
3. Ask another contributor to open the same file.
4. Edit text. Changes are sent as revisioned operations through the server.
5. Use the Collaborators view to see connected contributors and the documents they have open.
6. Use the Transfer Queue to inspect synchronization work.

The server uses Operational Transformation with server-assigned revisions. Keep the connection active for live edits. If the network drops, local work remains in the editor and pending operations are queued for reconnect/recovery.

### 10. Synchronize workspace files

Select **Synchronize files** or run **Jelo Co-Lab: Push/Sync Directory**. Review the list and select the files you intend to share. The extension excludes sensitive files, repository metadata, generated folders and common caches by default. Additional patterns can be configured under `collab.excludePatterns`.

To catch up after being offline, use **Reconcile workspace**. The extension compares the local workspace with a paged server manifest and may queue downloads/uploads or show a conflict where both copies changed.

### 11. Resolve a conflict

Open the Conflict Center. Select a conflict and review the reason. Depending on the conflict type, choose to keep the local version, use the server version, or postpone the decision. The extension saves a recovery copy before a destructive snapshot choice. Do not pick a side until you have reviewed which copy contains the desired changes.

### 12. Pause, resume and retry

- **Pause transfers** stops file synchronization work; it does not pause live text edits.
- **Resume transfers** continues queued work.
- **Retry pending** retries queued edits, file operations and transfers.
- **Diagnostics** shows server URL, workspace, role, latency, pending work and conflicts. It does not include your token.

## Part C — Good operating habits

- Use a unique user ID for each person in the workspace.
- Use `wss://` for remote collaboration.
- Keep Git commits and backups. Jelo Co-Lab does not replace source control.
- Review files selected for sharing. Never share credentials, private keys, `.env` files, or customer data without authorization.
- Keep file sizes within the current 10 MiB transfer limit and document sizes within the 5 MiB collaboration limit.
- If the server is unavailable, save local work. The server manager and health endpoint help the administrator diagnose the service.

## Part D — Troubleshooting checklist

### The extension says Disconnected

1. Run `curl https://your-domain/healthz` from a network that should reach the server.
2. Check the WSS domain, DNS and TLS certificate.
3. Confirm the workspace ID, user ID and invitation token.
4. Ask the administrator to inspect `sudo journalctl -u jelo-colab -n 100 --no-pager`.

### Authentication failed

The invitation may belong to another workspace/user ID, or it may have been rotated. Ask an admin to issue a new token using the server manager.

### File does not synchronize

Check the Transfer Queue. Verify that the file is not excluded and is under the size limit. Run Reconcile Workspace. A viewer cannot upload.

### VS Code reports a workspace conflict

Open the Conflict Center and compare the local and server choices. A recovery copy is retained under the extension's global storage. Keep a backup before choosing a version.

### Server needs attention

Run `sudo jelo-colab` and select diagnostics, or use:

```bash
sudo systemctl status jelo-colab
sudo journalctl -u jelo-colab -n 200 --no-pager
curl http://127.0.0.1:3000/healthz
```
