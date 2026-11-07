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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy in time");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
  forceKill.unref();
  await exited;
  clearTimeout(forceKill);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function nextMessage(client, predicate = () => true, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for WebSocket message")); }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup(); resolve(message);
    };
    function cleanup() { clearTimeout(timeout); client.off("message", onMessage); }
    client.on("message", onMessage);
  });
}

function send(client, message) { client.send(JSON.stringify(message)); }

async function join(client, token, userId, filePath = "src/main.txt", workspaceId = "team-1") {
  const joined = nextMessage(client, (message) => message.type === "joined");
  const init = nextMessage(client, (message) => message.type === "init" && message.filePath === filePath);
  send(client, { type: "join", workspaceId, userId, token, filePath });
  return { joined: await joined, init: await init };
}

function sendBinaryChunk(client, transferId, index, bytes) {
  const requestId = crypto.randomUUID();
  const header = Buffer.from(JSON.stringify({ type: "file_chunk_binary", transferId, index, requestId }));
  const frame = Buffer.allocUnsafe(4 + header.length + bytes.length);
  frame.writeUInt32BE(header.length, 0); header.copy(frame, 4); bytes.copy(frame, 4 + header.length);
  client.send(frame, { binary: true });
  return requestId;
}

async function uploadChunkWithRetry(client, transferId, index, payload, timeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const requestId = sendBinaryChunk(client, transferId, index, payload);
    const response = await nextMessage(client, (message) => message.requestId === requestId &&
      ((message.type === "file_chunk_ack" && message.transferId === transferId && message.index === index) || message.type === "error"), timeoutMs);
    if (response.type === "file_chunk_ack") return response;
    lastError = response;
    const retryAfterMs = Number(response.retryAfterMs);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 10000 || !/throughput limit/i.test(response.message || "")) {
      throw new Error(`Upload chunk ${index} rejected: ${response.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs + 25));
  }
  throw new Error(`Upload chunk ${index} remained throttled: ${lastError?.message || "retry budget exhausted"}`);
}

async function uploadFile(client, filePath, bytes, timeoutMs = 15000) {
  const transferId = crypto.randomUUID();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const beginAck = nextMessage(client, (message) => message.type === "file_begin_ack" && message.transferId === transferId);
  send(client, { type: "file_begin", transferId, path: filePath, size: bytes.length, mtime: Date.now(), sha256 });
  await beginAck;
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
    const payload = bytes.subarray(offset, offset + 48 * 1024);
    await uploadChunkWithRetry(client, transferId, index, payload, timeoutMs);
    if (index === 0) {
      await uploadChunkWithRetry(client, transferId, index, payload, timeoutMs); // Duplicate acknowledgements must not append bytes twice.
    }
    index += 1;
  }
  const complete = nextMessage(client, (message) => message.type === "file_ack" && message.transferId === transferId);
  send(client, { type: "file_end", transferId, sha256 });
  return complete;
}

test("revisioned OT, resume, chunked file transfer, multi-file subscriptions and file operations", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-phase2-test-"));
  const workspace = path.join(temp, "workspaces", "team-1");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "main.txt"), "abcd");
  await fs.writeFile(path.join(workspace, "README.md"), "readme");
  await fs.mkdir(path.join(workspace, "assets", "cleanup"), { recursive: true });
  await fs.writeFile(path.join(workspace, "assets", "cleanup", "closed.txt"), "stale-state");
  await fs.mkdir(path.join(temp, "state"), { recursive: true });
  const staleStateId = crypto.createHash("sha256").update("team-1\0assets/cleanup/closed.txt").digest("hex");
  await fs.writeFile(path.join(temp, "state", `${staleStateId}.json`), JSON.stringify({
    version: 1, workspaceId: "team-1", filePath: "assets/cleanup/closed.txt", revision: 4, text: "stale-state", history: [],
  }));
  const port = await reservePort();
  const token = "phase-two-test-token-0123456789abcdef";
  let child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let clientA, clientB, clientC;
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    assert.equal(health.status, "ok");
    const url = `ws://127.0.0.1:${port}`;
    clientA = await connect(url);
    clientB = await connect(url);
    const aJoin = await join(clientA, token, "alice");
    const bJoin = await join(clientB, token, "bob");
    assert.equal(aJoin.init.content, "abcd");
    assert.equal(bJoin.init.content, "abcd");
    assert.equal(aJoin.joined.role, "admin");

    const snapshotBlocked = nextMessage(clientA, (message) => message.type === "error");
    send(clientA, { type: "file_begin", transferId: "blocked-file-001", path: "src/main.txt", size: 1, mtime: Date.now() });
    assert.match((await snapshotBlocked).message, /live collaboration/);
    const secretBlocked = nextMessage(clientA, (message) => message.type === "error");
    send(clientA, { type: "file_get", path: ".env", requestId: "secret-path-request-01" });
    const secretError = await secretBlocked;
    assert.match(secretError.message, /Invalid file path/);
    assert.equal(secretError.requestId, "secret-path-request-01");
    const missingFileError = nextMessage(clientB, (message) => message.type === "error" && message.path === "assets/missing.bin");
    send(clientB, { type: "file_get", path: "assets/missing.bin" });
    assert.match((await missingFileError).message, /does not exist/);

    // Both operations are based on revision zero and arrive concurrently.
    const opA = diffText("abcd", "aXbcd");
    const opB = diffText("abcd", "abYcd");
    const ackA = nextMessage(clientA, (message) => message.type === "ack");
    const ackB = nextMessage(clientB, (message) => message.type === "ack");
    const receivedAtA = nextMessage(clientA, (message) => message.type === "operation");
    const receivedAtB = nextMessage(clientB, (message) => message.type === "operation");
    send(clientA, { type: "edit", filePath: "src/main.txt", clientId: "alice", opId: "alice-op-0001", baseRevision: 0, ops: opA });
    send(clientB, { type: "edit", filePath: "src/main.txt", clientId: "bob", opId: "bob-op-0001", baseRevision: 0, ops: opB });
    const [aAck, bAck] = await Promise.all([ackA, ackB]);
    await Promise.all([receivedAtA, receivedAtB]);
    assert.deepEqual([aAck.revision, bAck.revision].sort(), [1, 2]);
    const replayAck = nextMessage(clientA, (message) => message.type === "ack" && message.opId === "alice-op-0001");
    send(clientA, { type: "edit", filePath: "src/main.txt", clientId: "alice", opId: "alice-op-0001", baseRevision: 0, ops: opA });
    assert.ok((await replayAck).revision <= 2, "Replayed operation must be acknowledged without a second apply");

    // A third client receives the authoritative merged snapshot.
    clientC = await connect(url);
    const cJoin = await join(clientC, token, "carol");
    let merged = cJoin.init.content;
    assert.equal(merged.length, 6);
    assert.ok(merged.includes("X") && merged.includes("Y"));

    // Existing collaborator cursors move with remote edits rather than becoming stale.
    const initialCursor = nextMessage(clientB, (message) => message.type === "cursor" && message.userId === "alice");
    send(clientA, { type: "cursor", filePath: "src/main.txt", startLine: 0, startChar: 2, endLine: 0, endChar: 2 });
    await initialCursor;
    const cursorAfterEdit = nextMessage(clientB, (message) => message.type === "cursor" && message.userId === "alice");
    const cursorEditAck = nextMessage(clientB, (message) => message.type === "ack" && message.opId === "bob-cursor-op-0001");
    send(clientB, { type: "edit", filePath: "src/main.txt", clientId: "bob", opId: "bob-cursor-op-0001",
      baseRevision: 2, ops: diffText(merged, `Z${merged}`) });
    await cursorEditAck;
    const updatedCursor = await cursorAfterEdit;
    assert.equal(updatedCursor.startChar, 3);
    assert.equal(updatedCursor.endChar, 3);
    merged = `Z${merged}`;

    // Multiple documents can be subscribed on one socket.
    const fileJoined = nextMessage(clientA, (message) => message.type === "file_joined" && message.filePath === "README.md");
    const readmeInit = nextMessage(clientA, (message) => message.type === "init" && message.filePath === "README.md");
    send(clientA, { type: "open_file", filePath: "README.md" });
    await fileJoined;
    assert.equal((await readmeInit).content, "readme");

    // Resume returns every operation since the client's last acknowledged revision.
    const resumed = nextMessage(clientB, (message) => message.type === "resume_history");
    send(clientB, { type: "resume", filePath: "src/main.txt", baseRevision: 0 });
    const history = await resumed;
    assert.equal(history.revision, 3);
    assert.equal(history.entries.length, 3);

    // Workspace manifest is paged and contains stable hashes for eligible files only.
    const manifestPage = nextMessage(clientA, (message) => message.type === "manifest_page" && message.page === 0);
    send(clientA, { type: "manifest_get", page: 0, requestId: "manifest-test-0001" });
    const manifest = await manifestPage;
    assert.ok(manifest.entries.some((entry) => entry.path === "README.md" && /^[a-f0-9]{64}$/.test(entry.sha256)));
    assert.ok(manifest.entries.some((entry) => entry.path === "src/main.txt"));

    // Checksum-protected chunks are acknowledged, stored, and downloadable by peers.
    const fileAvailable = nextMessage(clientB, (message) => message.type === "file_available" && message.path === "assets/blob.bin");
    const blob = crypto.randomBytes(130_000);
    const uploadAck = uploadFile(clientA, "assets/blob.bin", blob);
    await Promise.all([fileAvailable, uploadAck]);
    const download = new Promise((resolve, reject) => {
      let begin;
      const receivedChunks = [];
      const timeout = setTimeout(() => { clientB.off("message", onDownload); reject(new Error("Timed out downloading peer file")); }, 5000);
      function acknowledge(message, phase, index) {
        send(clientB, { type: "download_ack", transferId: message.transferId, phase, ...(index === undefined ? {} : { index }), status: "ok" });
      }
      function onDownload(raw, isBinary) {
        let message;
        if (isBinary) {
          const buffer = Buffer.from(raw);
          const headerLength = buffer.readUInt32BE(0);
          message = { ...JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8")), binaryData: buffer.subarray(4 + headerLength) };
        } else message = JSON.parse(raw.toString());
        if (message.type === "download_begin" && message.path === "assets/blob.bin") {
          begin = message;
          // While the server waits for this download ACK, normal commands on the same
          // connection must still be processed. Otherwise this resume request deadlocks.
          const resumeProbe = nextMessage(clientB, (item) => item.type === "resume_history" && item.filePath === "src/main.txt");
          send(clientB, { type: "resume", filePath: "src/main.txt", baseRevision: 0 });
          void resumeProbe.then(() => acknowledge(message, "begin"), reject);
        } else if (begin && message.transferId === begin.transferId && message.type === "download_chunk_binary") {
          receivedChunks.push(message);
          acknowledge(message, "chunk", message.index);
        } else if (begin && message.transferId === begin.transferId && message.type === "download_end") {
          acknowledge(message, "complete");
          clearTimeout(timeout); clientB.off("message", onDownload); resolve({ begin, receivedChunks, complete: message });
        }
      }
      clientB.on("message", onDownload);
    });
    send(clientB, { type: "file_get", path: "assets/blob.bin" });
    const downloaded = await download;
    const received = Buffer.concat(downloaded.receivedChunks.map((message) => message.binaryData));
    assert.equal(downloaded.complete.chunks, downloaded.receivedChunks.length);
    assert.deepEqual(received, blob);

    const moveOperation = { type: "file_move", from: "assets/blob.bin", to: "assets/renamed.bin", operationId: "move-retry-0001" };
    const moved = nextMessage(clientA, (message) => message.type === "file_operation_ack" && message.operation === "move");
    send(clientA, moveOperation);
    await moved;
    assert.deepEqual(await fs.readFile(path.join(workspace, "assets", "renamed.bin")), blob);
    // A retried operation ID must not act on a new file recreated at the old source path.
    const recreatedSource = Buffer.from("new source content");
    await fs.writeFile(path.join(workspace, "assets", "blob.bin"), recreatedSource);
    const retriedMove = nextMessage(clientA, (message) => message.type === "file_operation_ack" && message.operationId === "move-retry-0001");
    send(clientA, moveOperation);
    await retriedMove;
    assert.deepEqual(await fs.readFile(path.join(workspace, "assets", "blob.bin")), recreatedSource);
    assert.deepEqual(await fs.readFile(path.join(workspace, "assets", "renamed.bin")), blob);

    const deleteOperation = { type: "file_delete", path: "assets/renamed.bin", operationId: "delete-retry-0001" };
    const deleted = nextMessage(clientA, (message) => message.type === "file_operation_ack" && message.operationId === "delete-retry-0001");
    send(clientA, deleteOperation);
    await deleted;
    await assert.rejects(fs.access(path.join(workspace, "assets", "renamed.bin")));
    await fs.writeFile(path.join(workspace, "assets", "renamed.bin"), "newer replacement");
    const retriedDelete = nextMessage(clientA, (message) => message.type === "file_operation_ack" && message.operationId === "delete-retry-0001");
    send(clientA, deleteOperation);
    await retriedDelete;
    assert.equal(await fs.readFile(path.join(workspace, "assets", "renamed.bin"), "utf8"), "newer replacement");

    const directoryDeleted = nextMessage(clientA, (message) => message.type === "file_operation_ack" && message.operationId === "delete-cleanup-0001");
    send(clientA, { type: "file_delete", path: "assets/cleanup", operationId: "delete-cleanup-0001" });
    await directoryDeleted;
    await assert.rejects(fs.access(path.join(temp, "state", `${staleStateId}.json`)));

    // The authoritative revision and text survive a server restart.
    const stateId = crypto.createHash("sha256").update("team-1\0src/main.txt").digest("hex");
    const storedState = JSON.parse(await fs.readFile(path.join(temp, "state", `${stateId}.json`), "utf8"));
    assert.equal(storedState.revision, 3);
    assert.equal(storedState.text, merged);

    // Persisted document state restores after a full server process restart.
    clientA.close(); clientB.close(); clientC.close();
    await stopChild(child);
    child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    const restoredClient = await connect(url);
    const restored = await join(restoredClient, token, "dave");
    assert.equal(restored.joined.revision, 3);
    assert.equal(restored.init.content, merged);
    restoredClient.close();
  } finally {
    clientA?.close(); clientB?.close(); clientC?.close();
    await stopChild(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("rejects invalid workspace IDs and credentials", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-auth-test-"));
  const port = await reservePort();
  const token = "phase-two-auth-token-0123456789abcdef";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token }, stdio: "ignore",
  });
  let client;
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    client = await connect(`ws://127.0.0.1:${port}`);
    const invalid = nextMessage(client, (message) => message.type === "error");
    send(client, { type: "join", workspaceId: "../escape", userId: "alice", token, filePath: "a.txt" });
    assert.match((await invalid).message, /Invalid workspace/);
    const auth = nextMessage(client, (message) => message.type === "error");
    send(client, { type: "join", workspaceId: "team-1", userId: "alice", token: "wrong-token", filePath: "a.txt" });
    assert.equal((await auth).message, "Authentication failed");
  } finally {
    client?.close();
    await stopChild(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("file uploads resume from durable acknowledged chunk offset after server restart", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-resume-test-"));
  const workspace = path.join(temp, "workspaces", "team-resume");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "resume test");
  const port = await reservePort();
  const token = "phase-two-resume-token-0123456789abcdef";
  const env = { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token };
  const startServer = () => spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"],
  });
  const stopServer = stopChild;
  let child = startServer();
  let first;
  let second;
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    first = await connect(`ws://127.0.0.1:${port}`);
    await join(first, token, "same-user", "README.md", "team-resume");
    const bytes = crypto.randomBytes(150_000);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const transferId = "resume-transfer-0001";
    const beginAck = nextMessage(first, (message) => message.type === "file_begin_ack" && message.transferId === transferId);
    send(first, { type: "file_begin", transferId, path: "assets/resume.bin", size: bytes.length, mtime: 1700000000000, sha256 });
    await beginAck;
    const firstChunkAck = nextMessage(first, (message) => message.type === "file_chunk_ack" && message.index === 0);
    sendBinaryChunk(first, transferId, 0, bytes.subarray(0, 48 * 1024));
    await firstChunkAck;
    first.close();
    await new Promise((resolve) => first.once("close", resolve));
    await stopServer(child);

    child = startServer();
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    second = await connect(`ws://127.0.0.1:${port}`);
    await join(second, token, "same-user", "README.md", "team-resume");
    const resumedAck = nextMessage(second, (message) => message.type === "file_begin_ack" && message.transferId === transferId);
    send(second, { type: "file_begin", transferId, path: "assets/resume.bin", size: bytes.length, mtime: 1700000000000, sha256 });
    const resumed = await resumedAck;
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.nextIndex, 1);
    let index = 1;
    for (let offset = 48 * 1024; offset < bytes.length; offset += 48 * 1024, index += 1) {
      const ack = nextMessage(second, (message) => message.type === "file_chunk_ack" && message.transferId === transferId && message.index === index);
      sendBinaryChunk(second, transferId, index, bytes.subarray(offset, offset + 48 * 1024));
      await ack;
    }
    const complete = nextMessage(second, (message) => message.type === "file_ack" && message.transferId === transferId);
    send(second, { type: "file_end", transferId, sha256 });
    await complete;
    assert.deepEqual(await fs.readFile(path.join(workspace, "assets", "resume.bin")), bytes);
  } finally {
    first?.close(); second?.close(); await stopServer(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("10 MiB binary transfer completes with matching SHA-256", { timeout: 120000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-large-file-test-"));
  const workspace = path.join(temp, "workspaces", "large-team");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "large file test");
  const port = await reservePort();
  const token = "large-file-test-token-0123456789abcdef";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let client;
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    client = await connect(`ws://127.0.0.1:${port}`);
    await join(client, token, "large-user", "README.md", "large-team");
    const payload = crypto.randomBytes(10 * 1024 * 1024);
    const ack = await uploadFile(client, "assets/large.bin", payload, 60000);
    assert.equal(ack.size, payload.length);
    assert.equal(ack.sha256, crypto.createHash("sha256").update(payload).digest("hex"));
    const saved = await fs.readFile(path.join(workspace, "assets", "large.bin"));
    assert.deepEqual(saved, payload);
  } finally {
    client?.close();
    await stopChild(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("viewer members can read but cannot edit or upload files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-viewer-test-"));
  const workspace = path.join(temp, "workspaces", "role-team");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "read only");
  const salt = crypto.randomBytes(16).toString("hex");
  const token = "viewer-token-0123456789abcdef012345";
  const hash = crypto.scryptSync(token, salt, 64).toString("hex");
  await fs.writeFile(path.join(temp, "access.json"), JSON.stringify({ version: 1, workspaces: {
    "role-team": { members: { reader: { salt, hash, role: "viewer", createdAt: new Date().toISOString() } } },
  } }));
  const port = await reservePort();
  const bootstrap = "role-team-bootstrap-token-0123456789";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp, COLLAB_TOKEN: bootstrap },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let client;
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    client = await connect(`ws://127.0.0.1:${port}`);
    const joined = await join(client, token, "reader", "README.md", "role-team");
    assert.equal(joined.joined.role, "viewer");
    const editError = nextMessage(client, (message) => message.type === "error");
    send(client, { type: "edit", filePath: "README.md", clientId: "reader", opId: "viewer-op-0001", baseRevision: 0, ops: [{ insert: "nope" }] });
    assert.match((await editError).message, /read-only/);
    const uploadError = nextMessage(client, (message) => message.type === "error");
    send(client, { type: "file_begin", transferId: "viewer-upload-01", path: "new.txt", size: 1, mtime: Date.now() });
    assert.match((await uploadError).message, /read-only/);
    assert.equal(await fs.readFile(path.join(workspace, "README.md"), "utf8"), "read only");
  } finally {
    client?.close();
    await stopChild(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("browser WebSocket origins are restricted to the configured allowlist", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-origin-test-"));
  const port = await reservePort();
  const token = "origin-test-token-0123456789abcdef";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp,
      COLLAB_TOKEN: token, ALLOWED_ORIGINS: "https://trusted.example" }, stdio: ["ignore", "ignore", "pipe"],
  });
  const originResult = (origin) => new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    client.once("open", () => { if (origin === "https://trusted.example") { client.close(); resolve("allowed"); } });
    client.once("close", (code) => resolve(code));
    client.once("error", reject);
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
    assert.equal(await originResult("https://trusted.example"), "allowed");
    assert.equal(await originResult("https://evil.example"), 1008);
  } finally {
    await stopChild(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
