const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { authenticate, readStore } = require("../access");

function run(dataDir, ...args) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "manage-access.js"), ...args], {
    env: { ...process.env, DATA_DIR: dataDir }, encoding: "utf8",
  });
}

test("access CLI bootstraps an admin, enforces last-admin safety and issues scoped credentials", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-access-cli-"));
  try {
    const first = run(dataDir, "add", "team", "alice", "admin");
    assert.equal(first.status, 0, first.stderr);
    const aliceToken = first.stdout.match(/^Token: (.+)$/m)?.[1];
    assert.ok(aliceToken);
    assert.deepEqual(await authenticate({ filename: path.join(dataDir, "access.json"), workspaceId: "team", userId: "alice", token: aliceToken, bootstrapToken: "bootstrap-token-01234567890123456789" }), { role: "admin", memberSince: (await readStore(path.join(dataDir, "access.json"))).workspaces.team.members.alice.createdAt });

    const firstEditor = run(dataDir, "add", "team", "bob", "editor");
    assert.equal(firstEditor.status, 0, firstEditor.stderr);
    const bobToken = firstEditor.stdout.match(/^Token: (.+)$/m)?.[1];
    assert.ok(bobToken);
    assert.equal((await authenticate({ filename: path.join(dataDir, "access.json"), workspaceId: "team", userId: "bob", token: bobToken })).role, "editor");
    assert.equal(await authenticate({ filename: path.join(dataDir, "access.json"), workspaceId: "team", userId: "bob", token: aliceToken }), null);

    const removeLastAdmin = run(dataDir, "remove", "team", "alice");
    assert.notEqual(removeLastAdmin.status, 0);
    assert.match(removeLastAdmin.stderr, /last workspace administrator/);

    const list = run(dataDir, "list", "team");
    assert.equal(list.status, 0);
    assert.match(list.stdout, /alice\s+admin/);
    assert.match(list.stdout, /bob\s+editor/);

    const rotate = run(dataDir, "rotate", "team", "bob", "viewer");
    assert.equal(rotate.status, 0, rotate.stderr);
    const rotatedToken = rotate.stdout.match(/^Token: (.+)$/m)?.[1];
    assert.ok(rotatedToken && rotatedToken !== bobToken);
    assert.equal((await authenticate({ filename: path.join(dataDir, "access.json"), workspaceId: "team", userId: "bob", token: rotatedToken })).role, "viewer");
    assert.equal(await authenticate({ filename: path.join(dataDir, "access.json"), workspaceId: "team", userId: "bob", token: bobToken }), null);

    const audit = await fs.readFile(path.join(dataDir, "audit.jsonl"), "utf8");
    assert.match(audit, /MEMBER_ADDED/);
    assert.match(audit, /MEMBER_TOKEN_ROTATED/);
    assert.doesNotMatch(audit, new RegExp(rotatedToken));
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("first workspace member cannot be created as a viewer/editor", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-access-first-"));
  try {
    const result = run(dataDir, "add", "new-team", "alice", "viewer");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /first member.*must be an admin/i);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
