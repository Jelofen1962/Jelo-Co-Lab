# Jelo Co-Lab for Visual Studio Code

Jelo Co-Lab provides self-hosted collaborative editing, workspace file synchronization, collaborator presence, transfer controls, and conflict resolution.

## Quick start

1. Install the `.vsix` from the project's GitHub Releases page.
2. Open the project folder (or a multi-root workspace).
3. Run **Jelo Co-Lab: Quick Start** from the Command Palette.
4. Enter the server URL, workspace ID, invitation token, and a display name.
5. Confirm the workspace folders and connect.

For remote servers, use `wss://`. Plain `ws://` is intended for localhost development only. Ask the server administrator for an invitation token and role. Never put tokens in workspace settings or commit them to Git.

## Main controls

- **Jelo Co-Lab: Reconcile Workspace** compares the local workspace with the server manifest and presents conflict choices where both sides changed.
- **Jelo Co-Lab: Push/Sync Directory** starts a selected directory synchronization.
- **Jelo Co-Lab: Pause Transfers / Resume Transfers** controls the transfer queue.
- **Jelo Co-Lab: Show Conflicts** opens the conflict center.
- **Jelo Co-Lab: Show Diagnostics** displays connection, role, latency, and transfer state.
- The **Collaborators**, **Transfer Queue**, and **Conflicts** views are available in the Explorer.

## Security and limitations

The server assigns permissions. Viewers can read and receive files but cannot edit or upload. Editors can collaborate and change files. Administrators can manage workspace members using the server's `manage-access.js` command.

The collaboration engine uses server-authoritative Operational Transformation. It requires an active connection for live editing. Local operations are queued while disconnected and replayed after reconnect when the server still has the required history; if history has expired, the extension offers snapshot recovery rather than silently overwriting local edits.

Workspace manifest reconciliation detects offline additions, modifications, deletions, and unambiguous renames. Ambiguous rename matches are not guessed. Large files are transferred in checksummed, acknowledged chunks with a 10 MiB per-file limit. Excluded files are never uploaded.

See the repository's root README and `docs/PHASE-3-4.md` for server installation, access management, backup/restore, limits, and operational guidance.
