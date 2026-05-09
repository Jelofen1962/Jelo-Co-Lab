const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WORKSPACES_DIR))
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

function getAbsoluteFilePath(workspaceId, relPath) {
  const safe = path.posix.normalize(relPath.replace(/\\/g, "/"));
  if (safe.startsWith("..") || path.isAbsolute(safe))
    throw new Error("Invalid path");
  return path.join(WORKSPACES_DIR, workspaceId, safe);
}

// Track connected clients
const clients = new Map();
// Simple debounce map for file saves: Map<string (workspace+path), NodeJS.Timeout>
const saveTimeouts = new Map();
// Simple rate limiting: Map<ws, { tokens, lastRefill }>
const rateLimits = new Map();

function getRandomColor() {
  const colors = [
    "#FF5733",
    "#33FF57",
    "#3357FF",
    "#FF33F5",
    "#F5FF33",
    "#33FFF5",
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function log(event, info) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${event}: ${JSON.stringify(info)}`);
}

function checkRateLimit(ws) {
  const now = Date.now();
  if (!rateLimits.has(ws)) {
    rateLimits.set(ws, { tokens: 50, lastRefill: now });
  }
  const rl = rateLimits.get(ws);
  const timePassed = now - rl.lastRefill;
  rl.tokens = Math.min(50, rl.tokens + timePassed * 0.05); // 50 msg/sec max replenish
  rl.lastRefill = now;

  if (rl.tokens < 1) return false;
  rl.tokens -= 1;
  return true;
}

wss.on("connection", (ws) => {
  ws.on("message", async (message) => {
    if (!checkRateLimit(ws)) {
      ws.send(
        JSON.stringify({ type: "error", message: "Rate limit exceeded" }),
      );
      return;
    }

    // Max Payload check for WS
    if (message.length > 5 * 1024 * 1024) {
      // 5MB Limit
      ws.send(JSON.stringify({ type: "error", message: "Payload too large" }));
      return;
    }

    try {
      const data = JSON.parse(message);

      // Basic validation
      if (!data.type) return;

      if (data.type === "join") {
        if (!data.workspaceId || !data.userId || !data.filePath) return;

        // Simple Auth Demo: Require token to match workspaceId (mocking shared secret)
        // In real app, check against a DB. Here we just enforce it exists.
        if (data.token !== `${data.workspaceId}-secret` && data.token !== "") {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Invalid workspace token",
            }),
          );
          return;
        }

        const color = getRandomColor();
        clients.set(ws, {
          workspaceId: data.workspaceId,
          userId: data.userId,
          filePath: data.filePath,
          color,
        });

        const workspacePath = path.join(WORKSPACES_DIR, data.workspaceId);
        if (!fs.existsSync(workspacePath))
          await fsp.mkdir(workspacePath, { recursive: true });

        log("JOIN", {
          user: data.userId,
          workspace: data.workspaceId,
          file: data.filePath,
        });

        try {
          const abs = getAbsoluteFilePath(data.workspaceId, data.filePath);
          const content = await fsp.readFile(abs, "utf8");
          ws.send(
            JSON.stringify({ type: "init", filePath: data.filePath, content }),
          );
        } catch {}

        broadcast(ws, {
          type: "cursor",
          userId: data.userId,
          color,
          startLine: 0,
          startChar: 0,
          endLine: 0,
          endChar: 0,
        });
      }

      if (data.type === "edit") {
        const clientInfo = clients.get(ws);
        if (!clientInfo || clientInfo.filePath !== data.filePath) return;

        broadcast(ws, {
          type: "edit",
          filePath: data.filePath,
          userId: clientInfo.userId,
          changes: data.changes,
        });

        // Debounced Save
        const fileKey = `${clientInfo.workspaceId}:${clientInfo.filePath}`;
        if (saveTimeouts.has(fileKey)) clearTimeout(saveTimeouts.get(fileKey));

        saveTimeouts.set(
          fileKey,
          setTimeout(async () => {
            try {
              const abs = getAbsoluteFilePath(
                clientInfo.workspaceId,
                clientInfo.filePath,
              );
              await fsp.mkdir(path.dirname(abs), { recursive: true });
              await fsp.writeFile(abs, data.fullContent, "utf8");
              log("SAVE", { file: fileKey });
            } catch (e) {
              console.error("Save error:", e.message);
            }
            saveTimeouts.delete(fileKey);
          }, 800),
        ); // 800ms debounce
      }

      if (data.type === "cursor") {
        const clientInfo = clients.get(ws);
        if (!clientInfo || clientInfo.filePath !== data.filePath) return;

        broadcast(ws, {
          type: "cursor",
          filePath: data.filePath,
          userId: clientInfo.userId,
          color: clientInfo.color,
          startLine: data.startLine,
          startChar: data.startChar,
          endLine: data.endLine,
          endChar: data.endChar,
        });
      }

      if (data.type === "leave") {
        handleLeave(ws);
      }
    } catch (e) {
      log("ERROR", { msg: e.message });
    }
  });

  ws.on("close", () => handleLeave(ws));
  ws.on("error", (e) => log("WS_ERROR", { msg: e.message }));
});

function handleLeave(ws) {
  const info = clients.get(ws);
  if (info) {
    log("LEAVE", { user: info.userId });
    broadcast(ws, { type: "leave", userId: info.userId });
  }
  clients.delete(ws);
  rateLimits.delete(ws);
}

function broadcast(senderWs, message) {
  const senderInfo = clients.get(senderWs);
  if (!senderInfo) return;

  const msgStr = JSON.stringify(message);
  for (const [clientWs, info] of clients.entries()) {
    if (
      clientWs !== senderWs &&
      clientWs.readyState === WebSocket.OPEN &&
      info.workspaceId === senderInfo.workspaceId &&
      info.filePath === senderInfo.filePath
    ) {
      clientWs.send(msgStr);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Collab WS server running on http://localhost:${PORT}`);
});
