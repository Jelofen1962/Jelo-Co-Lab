# Jelo Co-Lab

Self-hosted collaborative editing for VS Code. **Phase 1.5.4** is the security, packaging, installation and release foundation. It is a bounded Phase 1 release, not a claim that concurrent editing is already production-grade. The roadmap below keeps the remaining synchronization-engine work explicit for Phase 2.

## Release assets

Each GitHub Release created from a `v*` tag contains:

- `jelofen-co-lab-vX.Y.Z.vsix` — installable VS Code extension.
- `jelo-colab-server-vX.Y.Z.zip` — standalone server package.
- `.sha256` sidecars for both files.

The workflow checks that the tag version matches both package versions, runs server tests, compiles the extension, and only then publishes the assets.

## Install on a fresh Ubuntu/Debian server

After publishing a GitHub release, run this single command on Ubuntu 22.04/24.04 or Debian 12+:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/install-server.sh | sudo bash
```

On a first install, the script generates a random server token automatically. On an upgrade, it reuses the token already stored in `/etc/jelo-colab.env`. It installs Node.js 20+, downloads the latest server ZIP and its checksum, verifies the checksum, runs server checks/tests, configures a restricted systemd service, and verifies `/healthz`.

For unattended upgrades, the installer reuses the token already stored in `/etc/jelo-colab.env` unless `COLLAB_TOKEN` is explicitly supplied. To install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/install-server.sh | sudo env JELO_VERSION=v1.5.4 bash
```

To supply your own token on first install, use `curl -fsSL https://raw.githubusercontent.com/Jelofen1962/Jelo-Co-Lab/main/scripts/install-server.sh | sudo env COLLAB_TOKEN='YOUR_24_TO_256_CHARACTER_TOKEN' bash`. Use only letters, numbers, `_` and `-`. Retrieve the generated token locally with `sudo awk -F= '/^COLLAB_TOKEN=/ {print $2}' /etc/jelo-colab.env`.

### What the installer configures

- Node.js 20+ and production-only dependencies.
- Dedicated `jelo-colab` system user.
- Root-owned application files in `/opt/jelo-colab`.
- Workspace data in `/var/lib/jelo-colab` with service-user-only access.
- Root-only environment file at `/etc/jelo-colab.env`.
- `systemd` restart policy and service sandboxing.
- SHA-256 verification and server self-tests before service activation.
- Local binding at `127.0.0.1:3000` by default.

The installer supports apt-based Ubuntu/Debian systems. It does not install or configure a domain, firewall rules, Caddy/Nginx, or TLS certificates. For remote collaborators, put the service behind a TLS reverse proxy and connect using `wss://`. Do not expose plain `ws://` to the internet.

Example Caddyfile (after installing Caddy and pointing the domain's DNS to this server):

```caddy
collab.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy can provision and renew the HTTPS certificate for the domain. The extension should then connect to `wss://collab.example.com`.

## Install the VS Code extension

1. Download `jelofen-co-lab-v1.5.4.vsix` from the GitHub Release.
2. In VS Code, open **Extensions** (`Ctrl+Shift+X`).
3. Select `...` → **Install from VSIX...** and choose the downloaded file.
4. Open a workspace file.
5. Run **Jelo Co-Lab: Set Configuration**.
6. Enter your server URL, workspace ID, server token and a unique user ID.
7. Run **Jelo Co-Lab: Start Connection**.

Use `ws://localhost:3000` only for local testing. Remote servers must use `wss://`. The extension stores the token in VS Code SecretStorage, not `settings.json`.

All collaborators on the same server currently share one server token. They must use the same server URL, workspace ID and token, but distinct user IDs. Per-workspace roles, membership and token rotation are later security work.

## Server debugging

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
| Application | `/opt/jelo-colab` |
| Environment and secret | `/etc/jelo-colab.env` |
| Workspace data | `/var/lib/jelo-colab/workspaces` |
| Installer log | `/var/log/jelo-colab-install.log` |
| systemd unit | `/etc/systemd/system/jelo-colab.service` |

Back up `/var/lib/jelo-colab` before upgrades. The installer keeps workspace data separate from the application directory.

## Build and test from source

Requirements: Node.js 20+, npm, and `@vscode/vsce` for packaging.

```bash
cd server
npm ci
npm run check
npm test
COLLAB_TOKEN="$(openssl rand -hex 32)" npm start
```

In another terminal:

```bash
cd vscode-extension
npm ci
npm run compile
npx --yes @vscode/vsce package
```

## Phase 1.5.4: delivered scope

- [x] Workspace ID and relative path validation.
- [x] Symlink-component and special-file rejection in workspace data.
- [x] Atomic file writes and nested directory creation on the server.
- [x] Server-controlled shared-secret authentication with timing-safe comparison.
- [x] Extension token storage through VS Code SecretStorage.
- [x] Local-only `ws://`; remote configuration requires `wss://`.
- [x] WebSocket payload, file, edit-operation and cursor validation.
- [x] File-size cap consistent with the current JSON-array protocol.
- [x] Health endpoint, structured logs and pending-save flush on shutdown.
- [x] Safe default exclusions for common secrets, repository internals and generated folders.
- [x] Dirty-buffer protection for the initial remote snapshot.
- [x] Pacing and progress reporting for directory pushes.
- [x] Security and server integration tests.
- [x] VSIX/server ZIP release workflow and SHA-256 sidecars.
- [x] Ubuntu/Debian installer with checksum verification, service hardening and diagnostics.

### Explicit Phase 1 boundaries

This release does **not** solve concurrent edit conflicts with OT/CRDT, provide resumable/acknowledged transfers, synchronize deletes/renames, reconcile a dirty local file with a newer server snapshot, support multiple workspace roots, or queue offline edits. These are Phase 2/3 items and must not be represented as completed features.

## Development TODO

### Phase 2 — Correctness of synchronization

- [ ] Choose and document the consistency model: CRDT (recommended for multi-writer editing) or versioned OT.
- [ ] Add document IDs, monotonically increasing versions, operation IDs and idempotent operation handling.
- [ ] Add concurrent-edit tests for insert/insert, insert/delete, Unicode, multiline and selection changes.
- [ ] Add snapshot version checks and explicit local/server conflict resolution; never silently overwrite dirty buffers.
- [ ] Replace JSON byte arrays with chunked binary transfer.
- [ ] Add server acknowledgments, retry, resume, cancellation and integrity hashes for every file transfer.
- [ ] Synchronize create, rename, move and delete operations safely.
- [ ] Add transfer manifests and ignore-rule support.
- [ ] Support multiple open files and multiple workspace roots.
- [ ] Add integration tests that simulate several clients editing and syncing simultaneously.

### Phase 3 — UX and resilience

- [ ] Add first-run onboarding with connection test and workspace join preview.
- [ ] Add collaborator list, presence, names and stable remote cursor state per document.
- [ ] Improve configuration-change reconnect and explicit connection/authentication states.
- [ ] Add offline queue, exponential reconnect with jitter, heartbeat and stale-client cleanup.
- [ ] Add sync preview, transfer progress, cancellation and per-file result summary.
- [ ] Add configurable ignore patterns and a visible secret-file exclusion preview.
- [ ] Add accessible keyboard-first commands, clear error recovery actions and localization.

### Phase 4 — Production and public release

- [ ] Add VS Code Extension Host end-to-end tests across supported VS Code versions and OSes.
- [ ] Add stress tests for large projects, slow networks, server restarts and many collaborators.
- [ ] Add backup/restore, schema/version migration and safe server upgrade tests.
- [ ] Add per-workspace membership, role-based permissions, token rotation and audit events.
- [ ] Add optional Caddy/Nginx TLS provisioning and documented firewall configuration.
- [ ] Add public license after maintainer chooses the intended reuse terms.
- [ ] Add contribution guide, support policy and release checklist.
- [ ] Consider signed release assets and provenance/attestation.
- [ ] Complete a third-party security review before advertising internet-facing production use.
