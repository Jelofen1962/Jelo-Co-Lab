# Phase 3 and Phase 4 implementation notes

## Phase 3: user experience and offline reconciliation

### VS Code experience

The extension contributes a Jelo Co-Lab Activity Bar container with three data views:

- **Collaborators** lists connected users and open documents. Selecting a user opens a picker for their active documents.
- **Transfer Queue** lists pending, active, completed and failed transfer paths. Each item can be retried. Pause/resume affects uploads and downloads, while queued work remains persisted.
- **Conflicts** lists paths requiring user choice. The conflict center can open the local file, keep the local copy, accept a server copy, accept a remote deletion, or resolve a file rename.

The status bar reflects connection state, participant count, measured latency and role. The guided setup validates the WebSocket URL policy, checks the server health endpoint, saves the token with VS Code SecretStorage, previews workspace folders, then joins.

### Manifest reconciliation

The server builds a bounded workspace manifest of eligible regular files with relative path, byte size, mtime and SHA-256. The extension compares it with a local manifest and a persisted last-known baseline.

- Remote-only additions are downloaded.
- Local-only additions are uploaded.
- A local-only path that had a baseline but disappeared remotely is treated as a remote deletion conflict.
- A remote-only path with a baseline and a changed hash is downloaded if the local copy has not changed.
- If both sides changed, the extension asks the user rather than choosing silently.
- A rename is inferred only when exactly one new remote path has the previous remote hash and the old local path still exists. Ambiguous matches are not guessed.

Open live documents continue to use OT rather than file snapshots. Downloads are verified before apply. Unsaved local text is saved to recovery storage before a server replacement/deletion.

### Presence and resilience

The server sends periodic WebSocket ping/heartbeat signals and closes stale clients. The extension records latency, uses bounded exponential reconnect backoff, retains its outboxes, and replays queued work after joining again.

## Phase 4: production operations

### Workspace-scoped identity

`access.json` contains a `workspaces` object and members keyed by user ID. Each member entry stores a per-member scrypt salt/hash, role and created timestamp. The first member added to a workspace must be an admin. The CLI protects the last admin from removal/demotion, rotates tokens and appends membership changes to `audit.jsonl`.

The bootstrap token is accepted only for workspaces with no access-store entry. Once a workspace is managed, only its listed members can join. Roles are checked by the server at each mutating protocol operation.

### Transfer protocol

Client uploads use binary WebSocket frames: a four-byte big-endian header length, a JSON metadata header and a 48 KiB payload. Each chunk is written sequentially to a service-private partial file and fsynced before its acknowledged offset/hash metadata is atomically persisted. The transfer ID is bound to workspace, user, path, expected size, mtime and checksum. After restart, a matching transfer resumes at the next persisted chunk; duplicate chunks are accepted only when their hash matches.

Downloads use binary frames, per-frame acknowledgments/retries and a final SHA-256 check. A download restarts from the beginning after client disconnect; durable partial download resume is not implemented.

The bulk frame token bucket is separate from the control-message bucket. File size, per-client transfer count, aggregate active-upload bytes, concurrent downloads and queue lengths remain bounded.

### Audit and backup

The server rotates `audit.jsonl` once it reaches 10 MiB, keeping the current and previous file. Records include operational actions and identifiers, not authentication tokens or workspace content.

`backup-server.sh` briefly stops the service to make the workspace, document state, access store, audit log and environment file consistent. It creates a private tar.gz and SHA-256 sidecar. The restore helper validates the checksum, rejects traversal and non-regular archive entries, stages the extraction, preserves pre-restore copies, and starts the service again if it was previously active. The optional systemd timer runs a daily backup with a 30-day default retention.

### Release provenance and CI

`ci.yml` runs server checks/tests on Ubuntu and VS Code Extension Host tests on Ubuntu, Windows and macOS. `release.yml` creates the VSIX and server ZIP from a version-matched tag, generates SHA-256 files, then creates GitHub build-provenance attestations for both main artifacts before publishing the GitHub Release.

GitHub provenance attestation is not the same as a publisher-controlled Authenticode/macOS code-signing identity. Platform-specific code signing and a third-party security review remain separate release decisions.

## Explicit constraints

- Centralized server-authoritative OT, not CRDT or peer-to-peer editing.
- One server process and one persistent data directory; no HA clustering or multi-region replication.
- 10 MiB file limit, 5 MiB document limit, 20,000-entry manifest cap and 512 MiB eligible-manifest scan cap.
- Downloads restart after disconnect; uploads resume from durable server acknowledgments.
- Offline rename inference only resolves unique unchanged-hash matches. Ambiguous or content-changed renames remain conflicts.
- The server can read all workspace content; TLS is transport encryption, not E2E encryption.
