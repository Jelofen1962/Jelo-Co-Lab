const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  getAbsoluteFilePath,
  readWorkspaceFile,
  resolveSafeFilePath,
  writeWorkspaceFile,
} = require("../security");

test("rejects workspace traversal and malformed IDs", () => {
  const root = path.join(os.tmpdir(), "jelo-test-workspaces");
  for (const id of ["../outside", "..", "/tmp", "bad/name", "", "has spaces"]) {
    assert.throws(() => getAbsoluteFilePath(root, id, "a.txt"));
  }
});

test("rejects traversal, absolute paths, and malformed path segments", () => {
  const root = path.join(os.tmpdir(), "jelo-test-workspaces");
  for (const file of ["../secret", "a/../../secret", "/etc/passwd", "C:\\secret", "a//b", "./x", "a/./b", "a/../b"]) {
    assert.throws(() => getAbsoluteFilePath(root, "team-1", file));
  }
});

test("writes atomically and creates safe nested directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-safe-write-"));
  try {
    await writeWorkspaceFile(root, "team-1", "src/deep/main.js", "console.log('ok')");
    assert.equal(await readWorkspaceFile(root, "team-1", "src/deep/main.js"), "console.log('ok')");
    const files = await fs.readdir(path.join(root, "team-1", "src", "deep"));
    assert.deepEqual(files, ["main.js"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinked workspace and nested path components", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-symlink-test-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "jelo-outside-"));
  try {
    await fs.mkdir(path.join(root, "team-1"), { recursive: true });
    await fs.symlink(outside, path.join(root, "team-1", "linked"), "dir");
    await assert.rejects(resolveSafeFilePath(root, "team-1", "linked/evil.txt", true), /Symbolic links/);
    await assert.rejects(writeWorkspaceFile(root, "team-1", "linked/evil.txt", "nope"), /Symbolic links/);
    await assert.rejects(fs.access(path.join(outside, "evil.txt")));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") t.skip("Symlink creation is unavailable on this platform");
    else throw error;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
