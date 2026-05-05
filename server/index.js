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

const PORT = 3000;
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
// clients = Map<WebSocket, { workspaceId, userId, filePath, color }>
const clients = new Map();

// Generate a random color for cursors
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

wss.on("connection", (ws) => {
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "join") {
        const color = getRandomColor();
        clients.set(ws, {
          workspaceId: data.workspaceId,
          userId: data.userId,
          filePath: data.filePath,
          color,
        });

        // Send initial file state if it exists
        try {
          const abs = getAbsoluteFilePath(data.workspaceId, data.filePath);
          const content = await fsp.readFile(abs, "utf8");
          ws.send(JSON.stringify({ type: "init", content }));
        } catch {
          // File doesn't exist yet
        }

        // Notify others that a user joined
        broadcast(ws, {
          type: "cursor",
          userId: data.userId,
          color,
          line: 0,
          character: 0,
        });
      }

      if (data.type === "edit") {
        const clientInfo = clients.get(ws);
        if (!clientInfo) return;

        // Broadcast edit to everyone else in the same file
        broadcast(ws, {
          type: "edit",
          userId: clientInfo.userId,
          changes: data.changes,
        });

        // Save latest state to disk (debouncing in production is recommended)
        try {
          const abs = getAbsoluteFilePath(
            clientInfo.workspaceId,
            clientInfo.filePath,
          );
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, data.fullContent, "utf8");
        } catch (e) {
          console.error("Save error:", e.message);
        }
      }

      if (data.type === "cursor") {
        const clientInfo = clients.get(ws);
        if (!clientInfo) return;

        broadcast(ws, {
          type: "cursor",
          userId: clientInfo.userId,
          color: clientInfo.color,
          line: data.line,
          character: data.character,
          selectionLength: data.selectionLength,
        });
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (info) {
      broadcast(ws, { type: "leave", userId: info.userId });
    }
    clients.delete(ws);
  });
});

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
