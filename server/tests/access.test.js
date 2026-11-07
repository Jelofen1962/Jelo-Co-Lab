const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { authenticate } = require("../access");

test("workspace-scoped credentials enforce membership and roles", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-access-"));
  const filename = path.join(directory, "access.json");
  const salt = crypto.randomBytes(16).toString("hex");
  const token = "member-token-do-not-store-in-cleartext";
  const hash = crypto.scryptSync(token, salt, 64).toString("hex");
  await fs.writeFile(filename, JSON.stringify({ version: 1, workspaces: {
    team: { members: { readonly: { salt, hash, role: "viewer", createdAt: "2026-01-01T00:00:00.000Z" } } },
  } }));
  assert.equal((await authenticate({ filename, workspaceId: "team", userId: "readonly", token, bootstrapToken: "bootstrap-secret-012345678901" })).role, "viewer");
  assert.equal(await authenticate({ filename, workspaceId: "team", userId: "unknown", token, bootstrapToken: "bootstrap-secret-012345678901" }), null);
  assert.equal(await authenticate({ filename, workspaceId: "team", userId: "readonly", token: "wrong", bootstrapToken: "bootstrap-secret-012345678901" }), null);
  assert.equal((await authenticate({ filename, workspaceId: "unmanaged", userId: "root", token: "bootstrap-secret-012345678901", bootstrapToken: "bootstrap-secret-012345678901" })).role, "admin");
  await fs.rm(directory, { recursive: true, force: true });
});
