const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const WebSocket = require("ws");
const {
  validateWorkspaceId,
  getAbsoluteFilePath,
  readWorkspaceFile,
  writeWorkspaceFile,
} = require("./security");

const VERSION = require("./package.json").version;
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const COLLAB_TOKEN = process.env.COLLAB_TOKEN || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const MAX_FILE_BYTES = 700_000;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const USER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!/^[A-Za-z0-9_-]{24,256}$/.test(COLLAB_TOKEN)) {
  console.error("Refusing to start: COLLAB_TOKEN must be 24-256 characters using letters, numbers, _ or -.");
  process.exit(1);
}

const clients = new Map();
const saveTimeouts = new Map();
const rateLimits = new Map();

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
  if (limit.tokens < 1) {
    rateLimits.set(ws, limit);
    return false;
  }
  limit.tokens -= 1;
  rateLimits.set(ws, limit);
  return true;
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function log(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

function validPosition(value) {
  return value && Number.isInteger(value.line) && value.line >= 0 &&
    Number.isInteger(value.character) && value.character >= 0 &&
    value.line <= 1_000_000 && value.character <= 1_000_000;
}

function validChanges(changes) {
  return Array.isArray(changes) && changes.length <= 500 && changes.every((change) =>
    change && typeof change.text === "string" && Buffer.byteLength(change.text) <= MAX_FILE_BYTES &&
    Array.isArray(change.range) && change.range.length === 2 &&
    validPosition(change.range[0]) && validPosition(change.range[1]),
  );
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
  let messageQueue = Promise.resolve();
  let queuedMessages = 0;
  ws.on("message", (raw, isBinary) => {
    queuedMessages += 1;
    if (queuedMessages > 100) {
      ws.close(1013, "Too many queued messages");
      return;
    }
    messageQueue = messageQueue.then(() => handleMessage(ws, raw, isBinary)).catch((error) => {
      log("MESSAGE_ERROR", { message: error.message });
      send(ws, { type: "error", message: "Request could not be processed" });
    }).finally(() => { queuedMessages -= 1; });
  });
  ws.on("close", () => handleLeave(ws));
  ws.on("error", (error) => log("WEBSOCKET_ERROR", { message: error.message }));
});

async function handleMessage(ws, raw, isBinary) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (!checkRateLimit(ws)) {
    send(ws, { type: "error", message: "Rate limit exceeded. Slow down and retry." });
    return;
  }
  if (isBinary || raw.length > MAX_MESSAGE_BYTES) {
    send(ws, { type: "error", message: "Only JSON text messages up to 5 MB are accepted" });
    ws.close(1003, "Invalid message format");
    return;
  }

  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    send(ws, { type: "error", message: "Invalid JSON message" });
    ws.close(1007, "Invalid JSON");
    return;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") {
    send(ws, { type: "error", message: "Invalid message" });
    return;
  }

  if (data.type === "join") {
    let workspaceId;
    try {
      workspaceId = validateWorkspaceId(data.workspaceId);
      getAbsoluteFilePath(WORKSPACES_DIR, workspaceId, data.filePath);
    } catch {
      send(ws, { type: "error", message: "Invalid workspace ID or relative file path" });
      return;
    }
    if (typeof data.userId !== "string" || !USER_ID_RE.test(data.userId)) {
      send(ws, { type: "error", message: "Invalid user ID" });
      return;
    }
    if (!safeTokenEqual(data.token)) {
      send(ws, { type: "error", message: "Authentication failed" });
      ws.close(1008, "Authentication failed");
      return;
    }

    handleLeave(ws);
    for (const [existingWs, info] of clients.entries()) {
      if (info.workspaceId === workspaceId && info.userId === data.userId && existingWs !== ws) {
        send(existingWs, { type: "error", message: "This user ID is already connected elsewhere in this workspace" });
        handleLeave(existingWs);
        existingWs.close(1008, "Duplicate user ID");
      }
    }

    const clientInfo = { workspaceId, userId: data.userId, filePath: data.filePath, color: `#${crypto.randomBytes(3).toString("hex")}` };
    clients.set(ws, clientInfo);
    const content = await readWorkspaceFile(WORKSPACES_DIR, workspaceId, data.filePath);
    send(ws, { type: "joined", workspaceId, userId: data.userId, filePath: data.filePath, hasRemoteFile: content !== null });
    if (content !== null) send(ws, { type: "init", filePath: data.filePath, content });
    broadcast(ws, { type: "cursor", userId: data.userId, color: clientInfo.color, startLine: 0, startChar: 0, endLine: 0, endChar: 0 });
    log("JOIN", { user: data.userId, workspace: workspaceId, file: data.filePath });
    return;
  }

  const clientInfo = clients.get(ws);
  if (!clientInfo) {
    send(ws, { type: "error", message: "Join and authenticate a workspace first" });
    return;
  }

  if (data.type === "file_created" || data.type === "sync_file") {
    if (!Array.isArray(data.content) || data.content.length > MAX_FILE_BYTES ||
        !data.content.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      send(ws, { type: "error", message: "Invalid or oversized file content" });
      return;
    }
    getAbsoluteFilePath(WORKSPACES_DIR, clientInfo.workspaceId, data.path);
    await writeWorkspaceFile(WORKSPACES_DIR, clientInfo.workspaceId, data.path, Buffer.from(data.content));
    broadcastWorkspace(ws, { type: data.type, path: data.path, mtime: Number.isFinite(data.mtime) ? data.mtime : Date.now(), content: data.content });
    log("FILE_SYNC", { user: clientInfo.userId, workspace: clientInfo.workspaceId, file: data.path });
    return;
  }

  if (data.type === "edit") {
    if (data.filePath !== clientInfo.filePath || typeof data.fullContent !== "string" ||
        Buffer.byteLength(data.fullContent) > MAX_FILE_BYTES || !validChanges(data.changes)) {
      send(ws, { type: "error", message: "Invalid or oversized edit operation" });
      return;
    }
    broadcast(ws, { type: "edit", filePath: clientInfo.filePath, userId: clientInfo.userId, changes: data.changes });
    const fileKey = `${clientInfo.workspaceId}:${clientInfo.filePath}`;
    const previous = saveTimeouts.get(fileKey);
    if (previous) clearTimeout(previous.timer);
    const pending = {
      save: async () => {
        try {
          await writeWorkspaceFile(WORKSPACES_DIR, clientInfo.workspaceId, clientInfo.filePath, data.fullContent);
          log("DOCUMENT_SAVE", { workspace: clientInfo.workspaceId, file: clientInfo.filePath });
        } catch (error) {
          log("SAVE_ERROR", { file: fileKey, message: error.message });
        } finally {
          if (saveTimeouts.get(fileKey) === pending) saveTimeouts.delete(fileKey);
        }
      },
      timer: undefined,
    };
    pending.timer = setTimeout(() => { void pending.save(); }, 800);
    saveTimeouts.set(fileKey, pending);
    return;
  }

  if (data.type === "cursor") {
    if (data.filePath !== clientInfo.filePath ||
        !validPosition({ line: data.startLine, character: data.startChar }) ||
        !validPosition({ line: data.endLine, character: data.endChar })) {
      send(ws, { type: "error", message: "Invalid cursor position" });
      return;
    }
    broadcast(ws, { type: "cursor", filePath: clientInfo.filePath, userId: clientInfo.userId,
      color: clientInfo.color, startLine: data.startLine, startChar: data.startChar,
      endLine: data.endLine, endChar: data.endChar });
    return;
  }

  if (data.type === "leave") {
    handleLeave(ws);
    return;
  }
  send(ws, { type: "error", message: `Unsupported message type: ${data.type}` });
}

function handleLeave(ws) {
  const info = clients.get(ws);
  if (info) {
    broadcast(ws, { type: "leave", userId: info.userId });
    log("LEAVE", { user: info.userId, workspace: info.workspaceId });
  }
  clients.delete(ws);
  rateLimits.delete(ws);
}

function broadcast(senderWs, message) {
  const sender = clients.get(senderWs);
  if (!sender) return;
  const serialized = JSON.stringify(message);
  for (const [clientWs, info] of clients) {
    if (clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN &&
        info.workspaceId === sender.workspaceId && info.filePath === sender.filePath) {
      clientWs.send(serialized);
    }
  }
}

function broadcastWorkspace(senderWs, message) {
  const sender = clients.get(senderWs);
  if (!sender) return;
  const serialized = JSON.stringify(message);
  for (const [clientWs, info] of clients) {
    if (clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN && info.workspaceId === sender.workspaceId) {
      clientWs.send(serialized);
    }
  }
}

async function shutdown(signal) {
  log("SHUTDOWN", { signal });
  const pendingWrites = [];
  for (const pending of saveTimeouts.values()) {
    clearTimeout(pending.timer);
    pendingWrites.push(pending.save());
  }
  await Promise.allSettled(pendingWrites);
  for (const client of wss.clients) client.close(1001, "Server shutting down");
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

server.on("error", (error) => {
  log("HTTP_SERVER_ERROR", { message: error.message });
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => log("SERVER_READY", { host: HOST, port: PORT, version: VERSION, dataDir: DATA_DIR }));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
