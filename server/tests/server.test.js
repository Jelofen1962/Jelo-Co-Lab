const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy in time");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function nextMessage(client, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 4000);
    const onMessage = (raw) => {
      const data = JSON.parse(raw.toString());
      if (!predicate(data)) return;
      cleanup();
      resolve(data);
    };
    function cleanup() {
      clearTimeout(timeout);
      client.off("message", onMessage);
    }
    client.on("message", onMessage);
  });
}

test("health, auth, workspace join, nested file sync, and traversal rejection", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-server-test-"));
  const port = await reservePort();
  const token = "phase-one-test-token-0123456789abcdef";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const url = `ws://127.0.0.1:${port}`;
  let client;
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    assert.equal(health.status, "ok");

    client = await connect(url);
    client.send(JSON.stringify({ type: "join", workspaceId: "../escape", userId: "alice", token, filePath: "src/main.js" }));
    assert.match((await nextMessage(client)).message, /Invalid workspace/);

    client.send(JSON.stringify({ type: "join", workspaceId: "team-1", userId: "alice", token: "wrong-token", filePath: "src/main.js" }));
    assert.equal((await nextMessage(client)).message, "Authentication failed");
    await new Promise((resolve) => client.once("close", resolve));
    client = await connect(url);

    client.send(JSON.stringify({ type: "join", workspaceId: "team-1", userId: "alice", token, filePath: "src/main.js" }));
    const joined = await nextMessage(client, (message) => message.type === "joined");
    assert.equal(joined.hasRemoteFile, false);

    const bytes = Array.from(Buffer.from("phase one works", "utf8"));
    client.send(JSON.stringify({ type: "file_created", path: "src/deep/main.js", content: bytes }));
    const storedPath = path.join(temp, "workspaces", "team-1", "src", "deep", "main.js");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        assert.equal(await fs.readFile(storedPath, "utf8"), "phase one works");
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await fs.readFile(storedPath, "utf8"), "phase one works");

    const outside = path.join(temp, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(temp, "workspaces", "team-1", "linked"), "dir");
    client.send(JSON.stringify({ type: "file_created", path: "linked/escape.txt", content: [120] }));
    assert.match((await nextMessage(client, (message) => message.type === "error")).message, /could not be processed/);
    await assert.rejects(fs.access(path.join(outside, "escape.txt")));
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    await fs.rm(temp, { recursive: true, force: true });
  }
});
