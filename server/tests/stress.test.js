const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { diffText } = require("../ot");

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
  forceKill.unref();
  await exited;
  clearTimeout(forceKill);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}
function waitForHealth(url, child) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = async () => {
      if (child.exitCode !== null) return reject(new Error(`server exited ${child.exitCode}`));
      try { const response = await fetch(url); if (response.ok) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error("server health timeout"));
      setTimeout(poll, 100);
    };
    poll();
  });
}
function connect(url) {
  return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.once("open", () => resolve(ws)); ws.once("error", reject); });
}
function next(ws, predicate, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error("message timeout")); }, timeout);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) { clearTimeout(timer); ws.off("message", onMessage); resolve(message); }
    }
    ws.on("message", onMessage);
  });
}
function send(ws, data) { ws.send(JSON.stringify(data)); }

test("40 concurrent collaborators converge through real WebSocket sessions", { timeout: 90000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-stress-"));
  const workspace = path.join(temp, "workspaces", "stress-team");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "main.txt"), "");
  const port = await reservePort();
  const token = "stress-test-token-0123456789abcdef";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const clients = [];
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    const url = `ws://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i += 1) {
      const client = await connect(url); clients.push(client);
      const joined = next(client, (m) => m.type === "joined");
      const initialized = next(client, (m) => m.type === "init" && m.filePath === "main.txt");
      send(client, { type: "join", workspaceId: "stress-team", userId: `user-${String(i).padStart(2, "0")}`, token, filePath: "main.txt" });
      await Promise.all([joined, initialized]);
    }
    const acknowledgments = clients.map((client, index) => {
      const opId = `stress-op-${String(index).padStart(3, "0")}`;
      const ack = next(client, (m) => m.type === "ack" && m.opId === opId);
      send(client, { type: "edit", filePath: "main.txt", clientId: `user-${String(index).padStart(2, "0")}`,
        opId, baseRevision: 0, ops: diffText("", `writer-${index}\n`) });
      return ack;
    });
    await Promise.all(acknowledgments);
    const observer = await connect(url); clients.push(observer);
    const joined = next(observer, (m) => m.type === "joined");
    const snapshot = next(observer, (m) => m.type === "init" && m.filePath === "main.txt");
    send(observer, { type: "join", workspaceId: "stress-team", userId: "observer", token, filePath: "main.txt" });
    await joined;
    const content = (await snapshot).content;
    for (let i = 0; i < 40; i += 1) assert.ok(content.includes(`writer-${i}\n`), `writer ${i} missing`);
    assert.equal((content.match(/writer-/g) || []).length, 40);
  } finally {
    for (const client of clients) client.close();
    child.kill("SIGTERM");
    await stopChild(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
