const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function validateWorkspaceId(value) {
  if (typeof value !== "string" || !WORKSPACE_ID_RE.test(value)) {
    throw new Error("Invalid workspace ID");
  }
  return value;
}

function getAbsoluteFilePath(workspacesDir, workspaceId, relativePath) {
  validateWorkspaceId(workspaceId);
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) {
    throw new Error("Invalid file path");
  }

  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Absolute paths are not allowed");
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid file path");
  }

  const workspaceRoot = path.resolve(workspacesDir, workspaceId);
  const target = path.resolve(workspaceRoot, ...parts);
  if (!target.startsWith(workspaceRoot + path.sep)) {
    throw new Error("Path escapes workspace");
  }
  return target;
}

async function assertDirectory(pathname, create = false) {
  if (create) await fs.mkdir(pathname, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(pathname);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Unsafe directory in workspace path");
  }
  await fs.chmod(pathname, 0o700);
}

async function resolveSafeFilePath(workspacesDir, workspaceId, relativePath, createParents = false) {
  const target = getAbsoluteFilePath(workspacesDir, workspaceId, relativePath);
  const base = path.resolve(workspacesDir);
  const workspaceRoot = path.resolve(base, workspaceId);

  await assertDirectory(base, true);
  await assertDirectory(workspaceRoot, true);

  const parts = path.relative(workspaceRoot, target).split(path.sep);
  let current = workspaceRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!createParents || index === parts.length - 1) continue;
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }

    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in synchronized paths");
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error("A parent component is not a directory");
      await fs.chmod(current, 0o700);
    }
    if (index === parts.length - 1) {
      if (!stat.isFile()) throw new Error("The target path is not a regular file");
      await fs.chmod(current, 0o600);
    }
  }
  return target;
}

async function readWorkspaceFile(workspacesDir, workspaceId, relativePath) {
  const target = await resolveSafeFilePath(workspacesDir, workspaceId, relativePath);
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeWorkspaceFile(workspacesDir, workspaceId, relativePath, content) {
  const target = await resolveSafeFilePath(workspacesDir, workspaceId, relativePath, true);
  const tempPath = path.join(path.dirname(target), `.jelo-${crypto.randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

module.exports = {
  validateWorkspaceId,
  getAbsoluteFilePath,
  resolveSafeFilePath,
  readWorkspaceFile,
  writeWorkspaceFile,
};
