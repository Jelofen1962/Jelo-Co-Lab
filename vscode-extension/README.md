# Jelo Co-Lab for VS Code

Connect a VS Code workspace to a self-hosted Jelo Co-Lab server.

## Setup

1. Install the released `.vsix` in VS Code using **Extensions → ... → Install from VSIX...**.
2. Open a file inside the workspace.
3. Run **Jelo Co-Lab: Set Configuration**.
4. Enter the WebSocket server URL, workspace ID, server token, and a unique user ID.
5. Run **Jelo Co-Lab: Start Connection**.

Use `ws://localhost:3000` only for local testing. Use `wss://` behind a TLS reverse proxy for remote servers. The token is stored in VS Code SecretStorage, not workspace settings.

The server token must be 24-256 characters using letters, numbers, `_` or `-`. The server currently uses one shared token for all workspaces hosted by that server. Every collaborator must use the same server URL, workspace ID and token, but a distinct user ID.

## Commands

- **Jelo Co-Lab: Quick Start**: configures a local server URL and derives a workspace ID from the folder name.
- **Jelo Co-Lab: Set Configuration**: securely saves connection details.
- **Jelo Co-Lab: Start Connection**: connects and authenticates the active editor file.
- **Jelo Co-Lab: Disconnect**: stops the connection and automatic reconnects.
- **Jelo Co-Lab: Push/Sync Directory**: sends eligible files sequentially with pacing; files larger than 700,000 bytes are skipped.

## Default exclusions

For safety, the extension does not synchronize `.git`, `.vscode`, `node_modules`, `.idea`, `.next`, `dist`, `build`, `coverage`, `.env*`, private-key/certificate files, `id_rsa`, `id_ed25519`, `credentials.json`, or `secrets.json`.

## Phase 1 limitations

The initial snapshot will not replace a dirty local editor buffer. If local and server files differ, resolve the conflict manually. Concurrent edit merging, acknowledged/resumable file transfers, rename/delete propagation, multi-root workspaces and offline recovery remain later-phase work.
