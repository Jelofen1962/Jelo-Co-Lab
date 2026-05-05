const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = 3000;
const DATA_DIR = path.join(__dirname, "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const META_FILE = path.join(DATA_DIR, "meta.json");

const LOCK_TTL_MS = 15000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) {
  fs.writeFileSync(
    META_FILE,
    JSON.stringify({ workspaces: {} }, null, 2),
    "utf8"
  );
}

function now() {
  return Date.now();
}

async function loadMeta() {
  const raw = await fsp.readFile(META_FILE, "utf8");
  return JSON.parse(raw);
}

async function saveMeta(meta) {
  await fsp.writeFile(META_FILE, JSON.stringify(meta, null, 2), "utf8");
}

function ensureWorkspaceMeta(meta, workspaceId) {
  if (!meta.workspaces[workspaceId]) {
    meta.workspaces[workspaceId] = {
      files: {},
      locks: {}
    };
  }
}

function workspaceDir(workspaceId) {
  return path.join(WORKSPACES_DIR, workspaceId);
}

async function ensureWorkspaceDir(workspaceId) {
  await fsp.mkdir(workspaceDir(workspaceId), { recursive: true });
}

function sanitizeRelativePath(relPath) {
  const normalized = path.posix.normalize(relPath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid path");
  }
  return normalized;
}

function getAbsoluteFilePath(workspaceId, relPath) {
  const safe = sanitizeRelativePath(relPath);
  return path.join(workspaceDir(workspaceId), safe);
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

function cleanupExpiredLocks(workspaceMeta) {
  const t = now();
  for (const [filePath, lock] of Object.entries(workspaceMeta.locks)) {
    if (t - lock.timestamp > LOCK_TTL_MS) {
      delete workspaceMeta.locks[filePath];
    }
  }
}

app.get("/health", async (_req, res) => {
  res.json({ ok: true, ts: now() });
});

app.post("/workspace/init", async (req, res) => {
  try {
    const { workspaceId } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    await ensureWorkspaceDir(workspaceId);
    await saveMeta(meta);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/lock/acquire", async (req, res) => {
  try {
    const { workspaceId, userId, filePath } = req.body;
    if (!workspaceId || !userId || !filePath) {
      return res.status(400).json({ error: "workspaceId, userId, filePath required" });
    }

    const safePath = sanitizeRelativePath(filePath);
    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    const ws = meta.workspaces[workspaceId];
    cleanupExpiredLocks(ws);

    const lock = ws.locks[safePath];
    if (!lock || lock.userId === userId) {
      ws.locks[safePath] = {
        userId,
        timestamp: now()
      };
      await saveMeta(meta);
      return res.json({ ok: true, locked: true, owner: userId });
    }

    await saveMeta(meta);
    return res.json({ ok: true, locked: false, owner: lock.userId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/lock/heartbeat", async (req, res) => {
  try {
    const { workspaceId, userId, filePath } = req.body;
    if (!workspaceId || !userId || !filePath) {
      return res.status(400).json({ error: "workspaceId, userId, filePath required" });
    }

    const safePath = sanitizeRelativePath(filePath);
    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    const ws = meta.workspaces[workspaceId];
    cleanupExpiredLocks(ws);

    const lock = ws.locks[safePath];
    if (lock && lock.userId === userId) {
      lock.timestamp = now();
      await saveMeta(meta);
      return res.json({ ok: true, held: true });
    }

    await saveMeta(meta);
    return res.json({ ok: true, held: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/lock/release", async (req, res) => {
  try {
    const { workspaceId, userId, filePath } = req.body;
    if (!workspaceId || !userId || !filePath) {
      return res.status(400).json({ error: "workspaceId, userId, filePath required" });
    }

    const safePath = sanitizeRelativePath(filePath);
    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    const ws = meta.workspaces[workspaceId];

    if (ws.locks[safePath] && ws.locks[safePath].userId === userId) {
      delete ws.locks[safePath];
    }

    await saveMeta(meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/lock/status", async (req, res) => {
  try {
    const { workspaceId, filePath } = req.query;
    if (!workspaceId || !filePath) {
      return res.status(400).json({ error: "workspaceId, filePath required" });
    }

    const safePath = sanitizeRelativePath(filePath);
    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    const ws = meta.workspaces[workspaceId];
    cleanupExpiredLocks(ws);

    const lock = ws.locks[safePath] || null;
    await saveMeta(meta);

    res.json({ ok: true, lock });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/file/push", async (req, res) => {
  try {
    const { workspaceId, userId, filePath, content, version } = req.body;
    if (!workspaceId || !userId || !filePath || typeof content !== "string") {
      return res.status(400).json({ error: "workspaceId, userId, filePath, content required" });
    }

    const safePath = sanitizeRelativePath(filePath);
    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    await ensureWorkspaceDir(workspaceId);

    const ws = meta.workspaces[workspaceId];
    cleanupExpiredLocks(ws);

    const lock = ws.locks[safePath];
    if (!lock || lock.userId !== userId) {
      await saveMeta(meta);
      return res.status(409).json({
        error: "File locked by another user or not locked by you",
        lock: lock || null
      });
    }

    const current = ws.files[safePath] || { version: 0, updatedAt: 0 };
    if (typeof version === "number" && version !== current.version) {
      await saveMeta(meta);
      return res.status(409).json({
        error: "Version conflict",
        serverVersion: current.version
      });
    }

    const abs = getAbsoluteFilePath(workspaceId, safePath);
    await ensureParentDir(abs);
    await fsp.writeFile(abs, content, "utf8");

    ws.files[safePath] = {
      version: current.version + 1,
      updatedAt: now(),
      updatedBy: userId
    };

    await saveMeta(meta);
    res.json({
      ok: true,
      version: ws.files[safePath].version,
      updatedAt: ws.files[safePath].updatedAt
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/changes", async (req, res) => {
  try {
    const { workspaceId, since = "0" } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    const sinceTs = Number(since);
    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    const ws = meta.workspaces[workspaceId];
    cleanupExpiredLocks(ws);

    const changedFiles = [];
    for (const [filePath, info] of Object.entries(ws.files)) {
      if (info.updatedAt > sinceTs) {
        const abs = getAbsoluteFilePath(workspaceId, filePath);
        let content = "";
        try {
          content = await fsp.readFile(abs, "utf8");
        } catch {
          continue;
        }
        changedFiles.push({
          filePath,
          content,
          version: info.version,
          updatedAt: info.updatedAt,
          updatedBy: info.updatedBy
        });
      }
    }

    await saveMeta(meta);
    res.json({
      ok: true,
      serverTime: now(),
      files: changedFiles
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/manifest", async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    const meta = await loadMeta();
    ensureWorkspaceMeta(meta, workspaceId);
    const ws = meta.workspaces[workspaceId];
    cleanupExpiredLocks(ws);
    await saveMeta(meta);

    res.json({
      ok: true,
      files: ws.files,
      locks: ws.locks
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Collab MVP server running on http://localhost:${PORT}`);
});
