"use strict";

const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const WebSocket = require("ws");
const {
  validateWorkspaceId,
  getAbsoluteFilePath,
  readWorkspaceFile,
  readWorkspaceFileBuffer,
  writeWorkspaceFile,
  removeWorkspacePath,
  moveWorkspaceFile,
} = require("./security");
const { normalize, applyOperation, transformOperation } = require("./ot");

const VERSION = require("./package.json").version;
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const COLLAB_TOKEN = process.env.COLLAB_TOKEN || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const STATE_DIR = path.join(DATA_DIR, "state");
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 6 * 1024 * 1024;
const CHUNK_BYTES = 48 * 1024;
const MAX_HISTORY = 500;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_CLIENTS = 100;
const MAX_ACTIVE_UPLOAD_BYTES = 128 * 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 32;
const USER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/;
const TRANSFER_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be an integer between 1 and 65535");
if (!/^[A-Za-z0-9_-]{24,256}$/.test(COLLAB_TOKEN)) {
  console.error("Refusing to start: COLLAB_TOKEN must be 24-256 characters using letters, numbers, _ or -.");
  process.exit(1);
}

const clients = new Map();
const docStates = new Map();
const docLoads = new Map();
const docQueues = new Map();
const fileOperationStores = new Map();
const fileOperationLoads = new Map();
const mutatingPaths = new Set();
const saveTimeouts = new Map();
const rateLimits = new Map();
const downloadAckWaiters = new Map();
let activeUploadBytes = 0;
let activeDownloads = 0;

function safeTokenEqual(provided) {
  if (typeof provided !== "string") return false;
  const expected = Buffer.from(COLLAB_TOKEN);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function checkRateLimit(ws) {
  const now = Date.now();
  const limit = rateLimits.get(ws) || { tokens: 50, lastRefill: now };
  limit.tokens = Math.min(50, limit.tokens + (now - limit.lastRefill) * 0.05);
  limit.lastRefill = now;
  if (limit.tokens < 1) { rateLimits.set(ws, limit); return false; }
  limit.tokens -= 1;
  rateLimits.set(ws, limit);
  return true;
}

function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const response = payload.type === "error" && typeof ws.activeRequestId === "string"
    ? { ...payload, requestId: ws.activeRequestId }
    : payload;
  ws.send(JSON.stringify(response));
}

function downloadAckKey(transferId, phase, index) {
  return `${transferId}:${phase}:${index ?? ""}`;
}

function waitForDownloadAck(ws, transferId, phase, index) {
  const key = downloadAckKey(transferId, phase, index);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      downloadAckWaiters.delete(key);
      reject(new Error(`Download acknowledgement timed out (${phase}:${index ?? ""})`));
    }, 8000);
    downloadAckWaiters.set(key, {
      ws,
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

function handleDownloadAck(ws, data) {
  if (!TRANSFER_ID_RE.test(data.transferId || "") || !["begin", "chunk", "complete"].includes(data.phase) ||
      (data.phase === "chunk" && !Number.isSafeInteger(data.index))) return;
  const key = downloadAckKey(data.transferId, data.phase, data.index);
  const waiter = downloadAckWaiters.get(key);
  if (!waiter || waiter.ws !== ws) return;
  downloadAckWaiters.delete(key);
  waiter.resolve(data);
}

function log(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

function validRelativePath(value) {
  try {
    getAbsoluteFilePath(WORKSPACES_DIR, "validation", value);
    const parts = value.replace(/\\/g, "/").split("/");
    const blocked = new Set([".git", ".vscode", ".jelo-state", "node_modules", ".idea", ".next", ".aws", ".ssh", ".gnupg", ".azure", ".kube", ".terraform", ".venv", "venv", ".tox", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", ".turbo", ".parcel-cache", "dist", "build", "coverage"]);
    const filename = parts[parts.length - 1].toLowerCase();
    return !parts.some((part) => blocked.has(part.toLowerCase())) &&
      !/^\.env($|\.)/i.test(filename) && !/\.(pem|key|p12|pfx|keystore)$/i.test(filename) &&
      !["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials.json", "secrets.json", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "authorized_keys", "known_hosts"].includes(filename);
  } catch { return false; }
}

function validPosition(value) {
  return value && Number.isInteger(value.line) && value.line >= 0 &&
    Number.isInteger(value.character) && value.character >= 0 &&
    value.line <= 1_000_000 && value.character <= 1_000_000;
}

function positionToOffset(text, position) {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return null;
    offset = newline + 1;
  }
  const newline = text.indexOf("\n", offset);
  let lineEnd = newline < 0 ? text.length : newline;
  if (lineEnd > offset && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
  return position.character <= lineEnd - offset ? offset + position.character : null;
}

function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const newlineCount = (before.match(/\n/g) || []).length;
  const lastNewline = before.lastIndexOf("\n");
  let character = before.length - lastNewline - 1;
  if (character > 0 && before.charCodeAt(before.length - 1) === 13) character -= 1;
  return { line: newlineCount, character };
}

function mapOffsetThroughOperation(offset, operation) {
  let source = 0;
  let target = 0;
  let deleted = false;
  for (const part of operation) {
    if (part.type === "insert") {
      if (source <= offset || deleted) target += part.text.length;
      continue;
    }
    const end = source + part.count;
    if (part.type === "retain") {
      if (deleted) return target;
      if (offset < end) return target + offset - source;
      source = end;
      target += part.count;
    } else {
      if (offset < end) deleted = true;
      source = end;
    }
  }
  return target;
}

function documentKey(workspaceId, filePath) { return `${workspaceId}:${filePath}`; }
function stateFile(workspaceId, filePath) {
  const id = crypto.createHash("sha256").update(`${workspaceId}\0${filePath}`).digest("hex");
  return path.join(STATE_DIR, `${id}.json`);
}

async function persistDocumentState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const destination = stateFile(state.workspaceId, state.filePath);
  const temp = `${destination}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify({
      version: 1, workspaceId: state.workspaceId, filePath: state.filePath,
      revision: state.revision, text: state.text, history: state.history,
    }), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, destination);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function loadDocumentState(workspaceId, filePath) {
  const key = documentKey(workspaceId, filePath);
  if (docStates.has(key)) return docStates.get(key);
  if (docLoads.has(key)) return docLoads.get(key);

  const loading = (async () => {
    let state;
    try {
      const saved = JSON.parse(await fs.readFile(stateFile(workspaceId, filePath), "utf8"));
      if (saved.version === 1 && saved.workspaceId === workspaceId && saved.filePath === filePath &&
          Number.isSafeInteger(saved.revision) && saved.revision >= 0 && typeof saved.text === "string" &&
          Buffer.byteLength(saved.text) <= MAX_DOCUMENT_BYTES && Array.isArray(saved.history)) {
        state = { workspaceId, filePath, revision: saved.revision, text: saved.text, history: saved.history };
      }
    } catch (error) {
      if (error.code !== "ENOENT") log("DOCUMENT_STATE_RECOVERY", { file: filePath, message: error.message });
    }

    if (!state) {
      const text = await readWorkspaceFile(WORKSPACES_DIR, workspaceId, filePath);
      state = { workspaceId, filePath, revision: 0, text: text ?? "", history: [] };
      if (Buffer.byteLength(state.text) > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds the 5 MB collaboration limit");
      await persistDocumentState(state);
    }
    docStates.set(key, state);
    return state;
  })();
  docLoads.set(key, loading);
  try { return await loading; }
  finally { if (docLoads.get(key) === loading) docLoads.delete(key); }
}

function withDocumentLock(key, callback) {
  const previous = docQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  docQueues.set(key, current);
  return current.finally(() => { if (docQueues.get(key) === current) docQueues.delete(key); });
}

function withDocumentLocks(keys, callback) {
  const ordered = Array.from(new Set(keys)).sort();
  const acquire = (index) => index === ordered.length
    ? callback()
    : withDocumentLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}

function isPathMutating(workspaceId, filePath) {
  const prefix = `${workspaceId}:`;
  for (const key of mutatingPaths) {
    if (!key.startsWith(prefix)) continue;
    const target = key.slice(prefix.length);
    if (filePath === target || filePath.startsWith(`${target}/`) || target.startsWith(`${filePath}/`)) return true;
  }
  return false;
}

function hasOpenFile(workspaceId, filePath) {
  return Array.from(clients.values()).some((member) => member.workspaceId === workspaceId && member.files.has(filePath));
}

function trimHistory(state) {
  while (state.history.length > MAX_HISTORY ||
    Buffer.byteLength(JSON.stringify(state.history)) > MAX_HISTORY_BYTES) state.history.shift();
}

function operationStoreFile(workspaceId) {
  const id = crypto.createHash("sha256").update(workspaceId).digest("hex");
  return path.join(STATE_DIR, `file-operations-${id}.json`);
}

async function loadFileOperationStore(workspaceId) {
  if (fileOperationStores.has(workspaceId)) return fileOperationStores.get(workspaceId);
  if (fileOperationLoads.has(workspaceId)) return fileOperationLoads.get(workspaceId);
  const loading = (async () => {
    let records = [];
    try {
      const saved = JSON.parse(await fs.readFile(operationStoreFile(workspaceId), "utf8"));
      if (!Array.isArray(saved) || saved.length > 10_000 || saved.some((record) =>
        !record || typeof record.userId !== "string" || typeof record.operationId !== "string" ||
        typeof record.fingerprint !== "string" || !["pending", "complete"].includes(record.status) ||
        (record.status === "complete" && (!record.ack || typeof record.ack !== "object")))) {
        throw new Error("File operation journal has an invalid format");
      }
      records = saved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fileOperationStores.set(workspaceId, records);
    return records;
  })();
  fileOperationLoads.set(workspaceId, loading);
  try { return await loading; }
  finally { if (fileOperationLoads.get(workspaceId) === loading) fileOperationLoads.delete(workspaceId); }
}

async function persistFileOperationStore(workspaceId, records) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const destination = operationStoreFile(workspaceId);
  const temporary = `${destination}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function lookupFileOperation(info, operationId, fingerprint) {
  if (!operationId) return null;
  const records = await loadFileOperationStore(info.workspaceId);
  const existing = records.find((record) => record.userId === info.userId && record.operationId === operationId);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) return { error: "Operation ID was reused for a different file operation" };
  if (existing.status === "pending") return { error: "A previous operation has an unknown outcome. Inspect the workspace before creating a new operation." };
  return { ack: existing.ack };
}

async function beginFileOperation(info, operationId, fingerprint) {
  if (!operationId) return { fresh: true };
  const previous = await lookupFileOperation(info, operationId, fingerprint);
  if (previous) return previous;
  const records = await loadFileOperationStore(info.workspaceId);
  // Keep a bounded journal. Pending entries are never evicted because replaying an
  // operation with an unknown outcome could delete or move a newer file.
  while (records.length >= 5000) {
    const index = records.findIndex((record) => record.status === "complete");
    if (index < 0) return { error: "The file-operation journal is full of unresolved operations. Inspect and resolve them before retrying." };
    records.splice(index, 1);
  }
  records.push({ userId: info.userId, operationId, fingerprint, status: "pending" });
  await persistFileOperationStore(info.workspaceId, records);
  return { fresh: true };
}

async function completeFileOperation(info, operationId, ack) {
  if (!operationId) return;
  const records = await loadFileOperationStore(info.workspaceId);
  const record = records.find((item) => item.userId === info.userId && item.operationId === operationId);
  if (!record) throw new Error("File operation journal entry disappeared");
  record.status = "complete";
  record.ack = ack;
  await persistFileOperationStore(info.workspaceId, records);
}

function scheduleWorkspaceSave(state) {
  const key = documentKey(state.workspaceId, state.filePath);
  const previous = saveTimeouts.get(key);
  if (previous) clearTimeout(previous.timer);
  const pending = {
    timer: undefined,
    save: async () => {
      try {
        await writeWorkspaceFile(WORKSPACES_DIR, state.workspaceId, state.filePath, state.text);
        log("DOCUMENT_SAVE", { workspace: state.workspaceId, file: state.filePath, revision: state.revision });
      } catch (error) {
        log("SAVE_ERROR", { file: state.filePath, message: error.message });
      } finally {
        if (saveTimeouts.get(key) === pending) saveTimeouts.delete(key);
      }
    },
  };
  pending.timer = setTimeout(() => { void pending.save(); }, 500);
  saveTimeouts.set(key, pending);
}

function sendSnapshot(ws, state, responseType = "init") {
  send(ws, { type: responseType, filePath: state.filePath, revision: state.revision, content: state.text });
}

function broadcastFile(senderWs, workspaceId, filePath, message) {
  const serialized = JSON.stringify(message);
  for (const [clientWs, info] of clients) {
    if (clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN &&
        info.workspaceId === workspaceId && info.files.has(filePath)) clientWs.send(serialized);
  }
}

function broadcastWorkspace(senderWs, workspaceId, message) {
  const serialized = JSON.stringify(message);
  for (const [clientWs, info] of clients) {
    if (clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN && info.workspaceId === workspaceId) clientWs.send(serialized);
  }
}

function sendPresence(ws, filePath) {
  const target = clients.get(ws);
  if (!target) return;
  const members = [];
  for (const [otherWs, other] of clients) {
    if (otherWs === ws || other.workspaceId !== target.workspaceId || !other.files.has(filePath)) continue;
    const cursor = other.cursors.get(filePath);
    members.push({ userId: other.userId, color: other.color, cursor });
  }
  send(ws, { type: "presence", filePath, members });
}

async function openFile(ws, filePath, initial = false) {
  const info = clients.get(ws);
  if (!info || !validRelativePath(filePath)) {
    send(ws, { type: "error", message: "Invalid relative file path" });
    return;
  }
  const lockKeys = filePath.split("/").map((_, index, parts) =>
    documentKey(info.workspaceId, parts.slice(0, index + 1).join("/")));
  await withDocumentLocks(lockKeys, async () => {
    if (isPathMutating(info.workspaceId, filePath)) {
      send(ws, { type: "error", message: "This path is being moved or deleted. Try opening it again shortly." });
      return;
    }
    for (const member of clients.values()) {
      for (const upload of member.uploads.values()) {
        if (member.workspaceId === info.workspaceId && upload.path === filePath) {
          send(ws, { type: "error", message: "This file is currently being transferred. Open it again after the transfer completes." });
          return;
        }
      }
    }
    const wasOpen = info.files.has(filePath);
    info.files.add(filePath);
    const state = await loadDocumentState(info.workspaceId, filePath);
    send(ws, { type: initial ? "joined" : "file_joined", workspaceId: info.workspaceId,
      userId: info.userId, filePath, revision: state.revision, hasRemoteFile: state.text.length > 0 });
    sendSnapshot(ws, state);
    sendPresence(ws, filePath);
    if (!wasOpen) broadcastFile(ws, info.workspaceId, filePath, {
      type: "presence_join", filePath, userId: info.userId, color: info.color,
    });
  });
}

function closeFile(ws, filePath) {
  const info = clients.get(ws);
  if (!info || !info.files.delete(filePath)) return;
  info.cursors.delete(filePath);
  broadcastFile(ws, info.workspaceId, filePath, { type: "presence_leave", filePath, userId: info.userId });
}

async function handleEdit(ws, info, data) {
  const filePath = data.filePath;
  const key = documentKey(info.workspaceId, filePath);
  await withDocumentLock(key, async () => {
    if (isPathMutating(info.workspaceId, filePath)) {
      send(ws, { type: "error", message: "This file is being moved or deleted" });
      return;
    }
    const state = await loadDocumentState(info.workspaceId, filePath);
    if (typeof data.opId !== "string" || !TRANSFER_ID_RE.test(data.opId) || data.clientId !== info.userId ||
        !Number.isSafeInteger(data.baseRevision) || data.baseRevision < 0) {
      send(ws, { type: "error", message: "Invalid edit metadata" });
      return;
    }
    const duplicate = state.history.find((entry) => entry.clientId === info.userId && entry.opId === data.opId);
    if (duplicate) {
      send(ws, { type: "ack", filePath, opId: data.opId, revision: duplicate.revision, ops: duplicate.ops });
      return;
    }
    if (data.baseRevision > state.revision) {
      sendSnapshot(ws, state, "resync");
      return;
    }
    let operation;
    try { operation = normalize(data.ops); }
    catch { send(ws, { type: "error", message: "Malformed edit operation" }); return; }

    if (data.baseRevision < state.revision) {
      const firstBase = state.history[0]?.baseRevision;
      if (firstBase === undefined || data.baseRevision < firstBase) {
        sendSnapshot(ws, state, "resync");
        return;
      }
      for (const previous of state.history) {
        if (previous.revision <= data.baseRevision) continue;
        const incomingWinsTie = info.userId < previous.clientId;
        operation = transformOperation(operation, previous.ops, incomingWinsTie);
      }
    }

    let nextText;
    try { nextText = applyOperation(state.text, operation); }
    catch { send(ws, { type: "error", message: "Edit could not be applied to the current document" }); sendSnapshot(ws, state, "resync"); return; }
    if (Buffer.byteLength(nextText) > MAX_DOCUMENT_BYTES) {
      send(ws, { type: "error", message: "Document exceeds the 5 MB collaboration limit" });
      return;
    }

    const baseRevision = state.revision;
    const previousText = state.text;
    for (const [ownerWs, owner] of clients) {
      if (owner.workspaceId !== info.workspaceId || !owner.files.has(filePath)) continue;
      const cursor = owner.cursors.get(filePath);
      if (!cursor) continue;
      const start = positionToOffset(previousText, { line: cursor.startLine, character: cursor.startChar });
      const end = positionToOffset(previousText, { line: cursor.endLine, character: cursor.endChar });
      if (start === null || end === null) { owner.cursors.delete(filePath); continue; }
      const mappedStart = offsetToPosition(nextText, mapOffsetThroughOperation(start, operation));
      const mappedEnd = offsetToPosition(nextText, mapOffsetThroughOperation(end, operation));
      const updated = { ...cursor, startLine: mappedStart.line, startChar: mappedStart.character,
        endLine: mappedEnd.line, endChar: mappedEnd.character };
      owner.cursors.set(filePath, updated);
      for (const [peerWs, peer] of clients) {
        if (peerWs !== ownerWs && peer.workspaceId === info.workspaceId && peer.files.has(filePath)) {
          send(peerWs, { type: "cursor", filePath, ...updated });
        }
      }
    }
    state.text = nextText;
    state.revision += 1;
    state.history.push({ revision: state.revision, baseRevision, clientId: info.userId, opId: data.opId, ops: operation });
    trimHistory(state);
    await persistDocumentState(state);
    scheduleWorkspaceSave(state);

    const message = { type: "operation", filePath, clientId: info.userId, opId: data.opId,
      baseRevision, revision: state.revision, ops: operation };
    broadcastFile(ws, info.workspaceId, filePath, message);
    send(ws, { type: "ack", filePath, opId: data.opId, revision: state.revision, ops: operation });
  });
}

async function handleFileBegin(ws, info, data) {
  if (typeof data.transferId !== "string" || !TRANSFER_ID_RE.test(data.transferId) ||
      typeof data.path !== "string" || !validRelativePath(data.path) ||
      !Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_FILE_BYTES ||
      !Number.isFinite(data.mtime)) {
    send(ws, { type: "error", message: "Invalid file transfer metadata" });
    return;
  }
  const lockKeys = data.path.split("/").map((_, index, parts) =>
    documentKey(info.workspaceId, parts.slice(0, index + 1).join("/")));
  await withDocumentLocks(lockKeys, async () => {
    if (isPathMutating(info.workspaceId, data.path)) {
      send(ws, { type: "error", message: "This file is being moved or deleted" });
      return;
    }
    const existingUpload = info.uploads.get(data.transferId);
    if (existingUpload) {
      if (existingUpload.path === data.path && existingUpload.size === data.size) send(ws, { type: "file_begin_ack", transferId: data.transferId });
      else send(ws, { type: "error", message: "Transfer ID was reused with different metadata" });
      return;
    }
    if (info.completedUploads.has(data.transferId)) {
      send(ws, { type: "file_begin_ack", transferId: data.transferId });
      return;
    }
    if (info.uploads.size >= 2) {
      send(ws, { type: "error", message: "Too many active transfers" });
      return;
    }
    for (const member of clients.values()) {
      if (member.workspaceId !== info.workspaceId) continue;
      if (member.files.has(data.path)) {
        send(ws, { type: "error", message: "This file is currently open for live collaboration. Use the document editor instead of a file snapshot transfer." });
        return;
      }
      if (member.downloads.has(data.path)) {
        send(ws, { type: "error", message: "Another collaborator is downloading this file. Retry after it finishes." });
        return;
      }
      if (Array.from(member.uploads.values()).some((upload) => upload.path === data.path)) {
        send(ws, { type: "error", message: "Another collaborator is already transferring this file. Retry after it finishes." });
        return;
      }
    }
    info.uploads.set(data.transferId, { path: data.path, size: data.size, mtime: data.mtime, nextIndex: 0, received: 0, chunks: [], chunkHashes: [] });
    send(ws, { type: "file_begin_ack", transferId: data.transferId });
  });
}

function releaseUpload(info, transferId, upload) {
  if (info.uploads.get(transferId) !== upload) return false;
  info.uploads.delete(transferId);
  activeUploadBytes = Math.max(0, activeUploadBytes - upload.received);
  return true;
}

async function removePersistedDocumentStates(workspaceId, filePath) {
  let entries;
  try { entries = await fs.readdir(STATE_DIR, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filename = path.join(STATE_DIR, entry.name);
    try {
      const saved = JSON.parse(await fs.readFile(filename, "utf8"));
      if (saved.workspaceId === workspaceId && typeof saved.filePath === "string" &&
          (saved.filePath === filePath || saved.filePath.startsWith(`${filePath}/`))) {
        await fs.rm(filename, { force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") log("DOCUMENT_STATE_CLEANUP_ERROR", { file: entry.name, message: error.message });
    }
  }
}

function handleFileChunk(ws, info, data) {
  const upload = info.uploads.get(data.transferId);
  if (!upload || !Number.isSafeInteger(data.index) || data.index < 0 || typeof data.data !== "string" || data.data.length > 70_000) {
    send(ws, { type: "error", message: "Invalid file chunk" });
    return;
  }
  const chunk = Buffer.from(data.data, "base64");
  if (!chunk.length || chunk.length > CHUNK_BYTES || chunk.toString("base64") !== data.data) {
    send(ws, { type: "error", message: "Invalid file chunk encoding" });
    return;
  }
  const chunkHash = crypto.createHash("sha256").update(chunk).digest("hex");
  if (data.index < upload.nextIndex) {
    if (upload.chunkHashes[data.index] !== chunkHash) {
      send(ws, { type: "error", message: "A retried chunk did not match the original chunk" });
      return;
    }
    send(ws, { type: "file_chunk_ack", transferId: data.transferId, index: data.index });
    return;
  }
  if (data.index !== upload.nextIndex || upload.received + chunk.length > upload.size) {
    send(ws, { type: "error", message: "File chunks must be sequential and within the declared size" });
    return;
  }
  if (activeUploadBytes + chunk.length > MAX_ACTIVE_UPLOAD_BYTES) {
    send(ws, { type: "error", message: "Server upload memory limit reached. Retry shortly." });
    return;
  }
  upload.chunks.push(chunk);
  upload.chunkHashes.push(chunkHash);
  upload.received += chunk.length;
  activeUploadBytes += chunk.length;
  upload.nextIndex += 1;
  send(ws, { type: "file_chunk_ack", transferId: data.transferId, index: data.index });
}

async function handleFileEnd(ws, info, data) {
  const upload = info.uploads.get(data.transferId);
  if (!upload) {
    const completed = info.completedUploads.get(data.transferId);
    if (completed) send(ws, completed);
    else send(ws, { type: "error", message: "Unknown file transfer" });
    return;
  }
  if (upload.received !== upload.size || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) {
    send(ws, { type: "error", message: "Incomplete or invalid file transfer" });
    return;
  }
  const content = Buffer.concat(upload.chunks, upload.received);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  if (hash !== data.sha256) {
    releaseUpload(info, data.transferId, upload);
    send(ws, { type: "error", message: "File checksum mismatch" });
    return;
  }

  const key = documentKey(info.workspaceId, upload.path);
  mutatingPaths.add(key);
  try {
    await withDocumentLock(key, async () => {
      if (info.uploads.get(data.transferId) !== upload) return;
      if (hasOpenFile(info.workspaceId, upload.path)) {
        releaseUpload(info, data.transferId, upload);
        send(ws, { type: "error", message: "A collaborator opened this file during its transfer. Retry after the file is closed." });
        return;
      }
      const pendingSave = saveTimeouts.get(key);
      if (pendingSave) { clearTimeout(pendingSave.timer); await pendingSave.save(); }
      await writeWorkspaceFile(WORKSPACES_DIR, info.workspaceId, upload.path, content);
      docStates.delete(key);
      await fs.rm(stateFile(info.workspaceId, upload.path), { force: true });
      releaseUpload(info, data.transferId, upload);
      const message = { type: "file_available", path: upload.path, size: content.length, sha256: hash, mtime: upload.mtime };
      broadcastWorkspace(ws, info.workspaceId, message);
      const acknowledgement = { type: "file_ack", transferId: data.transferId, path: upload.path, size: content.length, sha256: hash };
      info.completedUploads.set(data.transferId, acknowledgement);
      while (info.completedUploads.size > 20) info.completedUploads.delete(info.completedUploads.keys().next().value);
      send(ws, acknowledgement);
      log("FILE_TRANSFER_COMPLETE", { user: info.userId, workspace: info.workspaceId, file: upload.path, size: content.length });
    });
  } finally {
    mutatingPaths.delete(key);
  }
}

async function sendDownloadFrame(ws, transferId, phase, index, payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("Client disconnected during download");
    const acknowledgement = waitForDownloadAck(ws, transferId, phase, index);
    send(ws, payload);
    try {
      const result = await acknowledgement;
      if (result.status !== "ok") {
        const rejected = new Error(`Client rejected download frame (${phase}:${index ?? ""})`);
        rejected.code = "ERR_DOWNLOAD_REJECTED";
        throw rejected;
      }
      return;
    } catch (error) {
      if (error.code === "ERR_DOWNLOAD_REJECTED" || attempt === 2 || ws.readyState !== WebSocket.OPEN) throw error;
    }
  }
}

async function sendFileDownload(ws, workspaceId, filePath) {
  const buffer = await readWorkspaceFileBuffer(WORKSPACES_DIR, workspaceId, filePath);
  if (buffer === null) { send(ws, { type: "error", message: "Requested file does not exist", path: filePath }); return; }
  if (buffer.length > MAX_FILE_BYTES) { send(ws, { type: "error", message: "Requested file exceeds transfer limit", path: filePath }); return; }
  const transferId = crypto.randomUUID();
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const stat = await fs.stat(getAbsoluteFilePath(WORKSPACES_DIR, workspaceId, filePath));
  await sendDownloadFrame(ws, transferId, "begin", undefined,
    { type: "download_begin", transferId, path: filePath, size: buffer.length, sha256, mtime: stat.mtimeMs });
  let index = 0;
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    await sendDownloadFrame(ws, transferId, "chunk", index,
      { type: "download_chunk", transferId, index, data: buffer.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
    index += 1;
  }
  await sendDownloadFrame(ws, transferId, "complete", undefined, { type: "download_end", transferId, chunks: index });
}

async function handleMessage(ws, raw, isBinary) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (!checkRateLimit(ws)) { send(ws, { type: "error", message: "Rate limit exceeded. Slow down and retry." }); return; }
  if (isBinary || raw.length > MAX_MESSAGE_BYTES) {
    send(ws, { type: "error", message: "Only JSON text messages up to 6 MB are accepted" });
    ws.close(1003, "Invalid message format");
    return;
  }
  let data;
  try { data = JSON.parse(raw.toString()); }
  catch { send(ws, { type: "error", message: "Invalid JSON message" }); ws.close(1007, "Invalid JSON"); return; }
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") {
    send(ws, { type: "error", message: "Invalid message" }); return;
  }

  if (data.type === "join") {
    let workspaceId;
    try { workspaceId = validateWorkspaceId(data.workspaceId); }
    catch { send(ws, { type: "error", message: "Invalid workspace ID" }); return; }
    if (typeof data.userId !== "string" || !USER_ID_RE.test(data.userId)) { send(ws, { type: "error", message: "Invalid user ID" }); return; }
    if (!safeTokenEqual(data.token)) { send(ws, { type: "error", message: "Authentication failed" }); ws.close(1008, "Authentication failed"); return; }

    handleLeave(ws);
    for (const [existingWs, existing] of clients) {
      if (existing.workspaceId === workspaceId && existing.userId === data.userId && existingWs !== ws) {
        send(existingWs, { type: "error", message: "This user ID is already connected elsewhere in this workspace" });
        existingWs.close(1008, "Duplicate user ID");
      }
    }
    const info = { workspaceId, userId: data.userId, color: `#${crypto.randomBytes(3).toString("hex")}`,
      files: new Set(), cursors: new Map(), uploads: new Map(), completedUploads: new Map(), downloads: new Set() };
    clients.set(ws, info);
    await openFile(ws, data.filePath, true);
    log("JOIN", { user: data.userId, workspace: workspaceId });
    return;
  }

  const info = clients.get(ws);
  if (!info) { send(ws, { type: "error", message: "Join and authenticate a workspace first" }); return; }

  if (data.type === "open_file") { await openFile(ws, data.filePath); return; }
  if (data.type === "close_file") { closeFile(ws, data.filePath); return; }
  if (data.type === "edit") {
    if (typeof data.filePath !== "string" || !info.files.has(data.filePath)) { send(ws, { type: "error", message: "Open the document before editing" }); return; }
    await handleEdit(ws, info, data); return;
  }
  if (data.type === "resume") {
    if (!info.files.has(data.filePath) || !Number.isSafeInteger(data.baseRevision) || data.baseRevision < 0) {
      send(ws, { type: "error", message: "Invalid resume request" }); return;
    }
    const state = await loadDocumentState(info.workspaceId, data.filePath);
    if (data.baseRevision > state.revision) { sendSnapshot(ws, state, "resync"); return; }
    const firstBase = state.history[0]?.baseRevision;
    if (data.baseRevision < state.revision && (firstBase === undefined || data.baseRevision < firstBase)) {
      sendSnapshot(ws, state, "resync"); return;
    }
    send(ws, { type: "resume_history", filePath: data.filePath, revision: state.revision,
      entries: state.history.filter((entry) => entry.revision > data.baseRevision) });
    return;
  }
  if (data.type === "resync") {
    if (!info.files.has(data.filePath)) { send(ws, { type: "error", message: "Document is not open" }); return; }
    const state = await loadDocumentState(info.workspaceId, data.filePath);
    sendSnapshot(ws, state, "resync"); return;
  }
  if (data.type === "cursor") {
    if (!info.files.has(data.filePath) || !validPosition({ line: data.startLine, character: data.startChar }) ||
        !validPosition({ line: data.endLine, character: data.endChar })) { send(ws, { type: "error", message: "Invalid cursor position" }); return; }
    const state = await loadDocumentState(info.workspaceId, data.filePath);
    if (positionToOffset(state.text, { line: data.startLine, character: data.startChar }) === null ||
        positionToOffset(state.text, { line: data.endLine, character: data.endChar }) === null) {
      send(ws, { type: "error", message: "Cursor position exceeds the document" }); return;
    }
    const cursor = { userId: info.userId, color: info.color, startLine: data.startLine, startChar: data.startChar,
      endLine: data.endLine, endChar: data.endChar };
    info.cursors.set(data.filePath, cursor);
    broadcastFile(ws, info.workspaceId, data.filePath, { type: "cursor", filePath: data.filePath, ...cursor });
    return;
  }
  if (data.type === "file_begin") { await handleFileBegin(ws, info, data); return; }
  if (data.type === "file_chunk") { handleFileChunk(ws, info, data); return; }
  if (data.type === "file_end") { await handleFileEnd(ws, info, data); return; }
  if (data.type === "file_cancel") {
    if (typeof data.transferId !== "string") return;
    const upload = info.uploads.get(data.transferId);
    const cancelled = upload ? releaseUpload(info, data.transferId, upload) : false;
    send(ws, { type: "file_cancel_ack", transferId: data.transferId, cancelled });
    return;
  }
  if (data.type === "file_get") {
    if (!validRelativePath(data.path)) { send(ws, { type: "error", message: "Invalid file path", path: data.path }); return; }
    if (info.downloads.has(data.path) || info.downloads.size >= 2 || activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
      send(ws, { type: "error", message: "A download is already active or the server reached its download limit", path: data.path });
      return;
    }
    info.downloads.add(data.path);
    activeDownloads += 1;
    const parts = data.path.split("/");
    const lockKeys = parts.map((_, index) => documentKey(info.workspaceId, parts.slice(0, index + 1).join("/")));
    void withDocumentLocks(lockKeys, async () => {
      if (isPathMutating(info.workspaceId, data.path)) {
        send(ws, { type: "error", message: "This file is currently being moved or deleted", path: data.path });
        return;
      }
      if (Array.from(clients.values()).some((member) => member.workspaceId === info.workspaceId &&
          Array.from(member.uploads.values()).some((upload) => upload.path === data.path))) {
        send(ws, { type: "error", message: "This file is currently being uploaded. Request it again after the transfer completes.", path: data.path });
        return;
      }
      await sendFileDownload(ws, info.workspaceId, data.path);
    }).catch((error) => {
      log("FILE_DOWNLOAD_ERROR", { user: info.userId, file: data.path, message: error.message });
      send(ws, { type: "error", message: "File download failed. Request it again to retry.", path: data.path });
    }).finally(() => { info.downloads.delete(data.path); activeDownloads -= 1; });
    return;
  }
  if (data.type === "file_delete") {
    if (!validRelativePath(data.path) || (data.operationId !== undefined && !TRANSFER_ID_RE.test(data.operationId))) {
      send(ws, { type: "error", message: "Invalid file path or operation ID" }); return;
    }
    const prefix = documentKey(info.workspaceId, data.path);
    const matches = (key) => key === prefix || key.startsWith(`${prefix}/`);
    const lockKeys = new Set([prefix, `${info.workspaceId}:\0file-operations`]);
    for (const key of [...docStates.keys(), ...saveTimeouts.keys()]) if (matches(key)) lockKeys.add(key);
    for (const member of clients.values()) {
      if (member.workspaceId === info.workspaceId) {
        for (const filePath of member.files) if (filePath === data.path || filePath.startsWith(`${data.path}/`)) {
          lockKeys.add(documentKey(info.workspaceId, filePath));
        }
      }
    }
    mutatingPaths.add(prefix);
    try {
      await withDocumentLocks(Array.from(lockKeys), async () => {
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ operation: "delete", path: data.path })).digest("hex");
        const previous = await lookupFileOperation(info, data.operationId, fingerprint);
        if (previous?.error) { send(ws, { type: "error", message: previous.error }); return; }
        if (previous?.ack) { send(ws, previous.ack); return; }
        for (const member of clients.values()) {
          if (member.workspaceId === info.workspaceId && Array.from(member.uploads.values()).some((upload) =>
            upload.path === data.path || upload.path.startsWith(`${data.path}/`))) {
            send(ws, { type: "error", message: "A file under this path is currently being transferred" });
            return;
          }
        }
        const begun = await beginFileOperation(info, data.operationId, fingerprint);
        if (begun.error) { send(ws, { type: "error", message: begun.error }); return; }
        if (begun.ack) { send(ws, begun.ack); return; }
        for (const [key, pending] of saveTimeouts) {
          if (matches(key)) { clearTimeout(pending.timer); await pending.save(); }
        }
        try { await removeWorkspacePath(WORKSPACES_DIR, info.workspaceId, data.path); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        for (const [key, state] of docStates) {
          if (matches(key)) {
            docStates.delete(key);
            await fs.rm(stateFile(state.workspaceId, state.filePath), { force: true });
          }
        }
        await removePersistedDocumentStates(info.workspaceId, data.path);
        for (const member of clients.values()) {
          if (member.workspaceId === info.workspaceId) {
            for (const filePath of Array.from(member.files)) {
              if (filePath === data.path || filePath.startsWith(`${data.path}/`)) {
                member.files.delete(filePath);
                member.cursors.delete(filePath);
              }
            }
          }
        }
        broadcastWorkspace(ws, info.workspaceId, { type: "file_deleted", path: data.path });
        const acknowledgement = { type: "file_operation_ack", operation: "delete", path: data.path, operationId: data.operationId };
        await completeFileOperation(info, data.operationId, acknowledgement);
        send(ws, acknowledgement);
      });
    } finally {
      mutatingPaths.delete(prefix);
    }
    return;
  }
  if (data.type === "file_move") {
    if (!validRelativePath(data.from) || !validRelativePath(data.to) || data.from === data.to || data.to.startsWith(`${data.from}/`) ||
        (data.operationId !== undefined && !TRANSFER_ID_RE.test(data.operationId))) {
      send(ws, { type: "error", message: "Invalid move path or operation ID" }); return;
    }
    const oldKey = documentKey(info.workspaceId, data.from);
    const newKey = documentKey(info.workspaceId, data.to);
    mutatingPaths.add(oldKey);
    mutatingPaths.add(newKey);
    try {
      await withDocumentLocks([oldKey, newKey, `${info.workspaceId}:\0file-operations`], async () => {
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ operation: "move", from: data.from, to: data.to })).digest("hex");
        const previous = await lookupFileOperation(info, data.operationId, fingerprint);
        if (previous?.error) { send(ws, { type: "error", message: previous.error }); return; }
        if (previous?.ack) { send(ws, previous.ack); return; }
        for (const member of clients.values()) {
          if (member.workspaceId === info.workspaceId && Array.from(member.uploads.values()).some((upload) => upload.path === data.from || upload.path === data.to)) {
            send(ws, { type: "error", message: "A file participating in this move is being transferred" }); return;
          }
        }
        if (docStates.has(newKey) || hasOpenFile(info.workspaceId, data.to) ||
            await readWorkspaceFileBuffer(WORKSPACES_DIR, info.workspaceId, data.to) !== null) {
          send(ws, { type: "error", message: "Destination document already exists or is open" }); return;
        }
        const begun = await beginFileOperation(info, data.operationId, fingerprint);
        if (begun.error) { send(ws, { type: "error", message: begun.error }); return; }
        if (begun.ack) { send(ws, begun.ack); return; }
        const source = await readWorkspaceFileBuffer(WORKSPACES_DIR, info.workspaceId, data.from);
        if (source === null && data.operationId) {
          const acknowledgement = { type: "file_operation_ack", operation: "move", from: data.from, to: data.to, operationId: data.operationId };
          await completeFileOperation(info, data.operationId, acknowledgement);
          send(ws, acknowledgement);
          return;
        }
        if (docStates.has(newKey) || hasOpenFile(info.workspaceId, data.to)) {
          send(ws, { type: "error", message: "Destination document already exists or is open" }); return;
        }
        const pending = saveTimeouts.get(oldKey);
        if (pending) { clearTimeout(pending.timer); await pending.save(); }
        const state = await loadDocumentState(info.workspaceId, data.from);
        await moveWorkspaceFile(WORKSPACES_DIR, info.workspaceId, data.from, data.to);
        docStates.delete(oldKey);
        await fs.rm(stateFile(info.workspaceId, data.from), { force: true });
        await fs.rm(stateFile(info.workspaceId, data.to), { force: true });
        state.filePath = data.to;
        docStates.set(newKey, state);
        await persistDocumentState(state);
        for (const member of clients.values()) {
          if (member.workspaceId === info.workspaceId && member.files.delete(data.from)) {
            member.files.add(data.to);
            const cursor = member.cursors.get(data.from);
            member.cursors.delete(data.from);
            if (cursor) member.cursors.set(data.to, cursor);
          }
        }
        broadcastWorkspace(ws, info.workspaceId, { type: "file_moved", from: data.from, to: data.to });
        const acknowledgement = { type: "file_operation_ack", operation: "move", from: data.from, to: data.to, operationId: data.operationId };
        await completeFileOperation(info, data.operationId, acknowledgement);
        send(ws, acknowledgement);
      });
    } finally {
      mutatingPaths.delete(oldKey);
      mutatingPaths.delete(newKey);
    }
    return;
  }
  if (data.type === "leave") { handleLeave(ws); return; }
  send(ws, { type: "error", message: `Unsupported message type: ${data.type}` });
}

function handleLeave(ws) {
  const info = clients.get(ws);
  if (info) {
    for (const filePath of info.files) broadcastFile(ws, info.workspaceId, filePath,
      { type: "presence_leave", filePath, userId: info.userId });
    log("LEAVE", { user: info.userId, workspace: info.workspaceId });
  }
  if (info) {
    for (const [transferId, upload] of info.uploads) releaseUpload(info, transferId, upload);
    info.downloads.clear();
  }
  clients.delete(ws);
  rateLimits.delete(ws);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: "ok", service: "jelo-colab", version: VERSION }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocket.Server({ server, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
wss.on("connection", (ws) => {
  if (wss.clients.size > MAX_CLIENTS) { ws.close(1013, "Server connection limit reached"); return; }
  let messageQueue = Promise.resolve();
  let queuedMessages = 0;
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) {
      try {
        const control = JSON.parse(raw.toString());
        if (control?.type === "download_ack") { handleDownloadAck(ws, control); return; }
      } catch { /* The normal message handler reports malformed JSON. */ }
    }
    queuedMessages += 1;
    if (queuedMessages > 100) { ws.close(1013, "Too many queued messages"); return; }
    messageQueue = messageQueue.then(async () => {
      let requestId;
      if (!isBinary) {
        try { requestId = JSON.parse(raw.toString())?.requestId; } catch { /* handled by handleMessage */ }
      }
      ws.activeRequestId = typeof requestId === "string" && requestId.length <= 80 ? requestId : undefined;
      try {
        await handleMessage(ws, raw, isBinary);
      } catch (error) {
        log("MESSAGE_ERROR", { message: error.message });
        send(ws, { type: "error", message: "Request could not be processed" });
      } finally {
        ws.activeRequestId = undefined;
      }
    }).catch((error) => {
      log("MESSAGE_QUEUE_ERROR", { message: error.message });
      send(ws, { type: "error", message: "Request could not be processed" });
    }).finally(() => { queuedMessages -= 1; });
  });
  ws.on("close", () => {
    for (const [key, waiter] of downloadAckWaiters) {
      if (waiter.ws === ws) { downloadAckWaiters.delete(key); waiter.reject(new Error("Client disconnected during download")); }
    }
    handleLeave(ws);
  });
  ws.on("error", (error) => log("WEBSOCKET_ERROR", { message: error.message }));
});

async function shutdown(signal) {
  log("SHUTDOWN", { signal });
  const pendingWrites = [];
  for (const pending of saveTimeouts.values()) { clearTimeout(pending.timer); pendingWrites.push(pending.save()); }
  await Promise.allSettled(pendingWrites);
  for (const state of docStates.values()) pendingWrites.push(persistDocumentState(state));
  await Promise.allSettled(pendingWrites);
  for (const client of wss.clients) client.close(1001, "Server shutting down");
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

server.on("error", (error) => { log("HTTP_SERVER_ERROR", { message: error.message }); process.exitCode = 1; });
server.listen(PORT, HOST, () => log("SERVER_READY", { host: HOST, port: PORT, version: VERSION, dataDir: DATA_DIR }));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
