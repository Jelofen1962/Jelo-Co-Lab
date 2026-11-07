# Phase 2 collaboration protocol

## Text document model

The server is authoritative for each `(workspaceId, filePath)` document. A document state contains its text, an integer revision, and a bounded ordered history.

Each client keeps a local optimistic text value plus an ordered queue of pending operations. Only the head operation is sent. This is important: a later local operation was constructed against the result of the earlier local operation, so it is sent only after the earlier operation is acknowledged or recovered from history.

An edit request has this shape:

```json
{
  "type": "edit",
  "filePath": "src/main.ts",
  "clientId": "alice",
  "opId": "client-generated-unique-id",
  "baseRevision": 12,
  "ops": [
    { "type": "retain", "count": 4 },
    { "type": "insert", "text": "hello" },
    { "type": "retain", "count": 8 }
  ]
}
```

Operation lengths are UTF-16 code units, matching VS Code text offsets. The server serializes mutations per document, transforms an operation through every retained operation newer than `baseRevision`, applies the result, increments the revision, persists state, and sends an `ack` to the sender and `operation` to other subscribers.

Same-position insertions use a deterministic user-ID ordering. Duplicate `(clientId, opId)` submissions found in retained history receive the original acknowledgment and are not applied twice. History is bounded to 500 operations or 1 MiB, whichever is reached first.

## Reconnect and conflict recovery

The extension persists pending text operations in VS Code global storage, namespaced by server URL and workspace ID. On reconnect it asks the server for history since its last revision. It applies missed remote operations while transforming its pending local queue. If the history is missing, truncated, or has a gap, the server sends a snapshot. The extension saves a recovery copy and asks whether to keep the local version or use the server version.

The queue limit is 1,000 pending operations per open document. This is a safety ceiling, not a substitute for a long-term offline merge UI.

## Cursor transformation

Cursors are transmitted as line/character positions. The server converts them to UTF-16 offsets, maps them through each accepted operation, then converts them back to line/character positions and broadcasts updates. Invalid positions outside the current document are rejected.

## File transfer

Files are limited to 10 MiB. Uploads and downloads use 48 KiB Base64 chunks carried in JSON messages. The sender waits for an acknowledgment for each chunk. The receiver checks canonical Base64 encoding, chunk order, chunk hashes, total length, and final SHA-256 before the file is committed.

The server allows up to two active upload transfers per connection, caps aggregate in-memory upload chunks at 128 MiB, limits active downloads to two per connection and 32 server-wide, and rejects connections beyond 100 active clients. Download messages (`download_begin`, `download_chunk`, `download_end`) are acknowledged directly so a transfer does not block the connection's normal message queue. A lost upload connection restarts that file from the beginning after reconnect; partial chunks are not durable on the server.

The extension stores pending file paths and pending delete/rename operations in VS Code global storage. It replays file operations before pending uploads so local rename/delete intent is not silently lost while offline. File delete and move operations carry an operation ID and a content fingerprint. The server persists a per-workspace journal before applying the mutation; a completed retry receives its original acknowledgment and cannot act on a newly recreated file at the old path. A retry with the same ID but different parameters is rejected.

The journal retains up to 5,000 records per workspace. Completed records may be evicted when the limit is reached; unresolved records are never evicted. If the server restarts after recording an operation as pending but before its outcome is known, it refuses automatic replay and asks the operator to inspect the workspace. This fails closed rather than risk deleting or moving newer data.

## File operations and sync exclusions

File deletion and rename are serialized against open/edit/save/transfer operations. Open documents use live OT and are not replaced by snapshot upload. Directory sync displays a selectable manifest, skips open live documents, and reports per-file results.

The client and server both enforce built-in exclusions for repository metadata, IDE state, dependency/build caches, credential directories/files, `.env*`, and private keys. Additional patterns in `collab.excludePatterns` use `*`, `?`, and `**` glob syntax and are applied by the extension before transfer. Built-in exclusions cannot be overridden.

## Known protocol ceilings

- OT is centralized and server-authoritative, not a peer-to-peer CRDT.
- Reconnect history is bounded; sufficiently stale clients use a snapshot conflict flow.
- File chunks are Base64 JSON, not binary WebSocket frames.
- Upload resume is file-level restart, not chunk-offset resume.
- The server currently has one shared secret rather than per-workspace membership or roles.
- A client that is offline while other collaborators add/delete/rename files does not yet receive a complete remote workspace manifest on reconnect; use **Push/Sync Directory** for a manual reconciliation. A full offline manifest and conflict center are Phase 3 work.
- Automated server tests do not replace VS Code Extension Host or multi-platform GUI tests.
