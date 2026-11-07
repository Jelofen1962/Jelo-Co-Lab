#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { readStore } = require("./access");

const [command, workspaceId, userId, requestedRole] = process.argv.slice(2);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const filename = path.join(dataDir, "access.json");
const auditFile = path.join(dataDir, "audit.jsonl");
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const roles = new Set(["admin", "editor", "viewer"]);

async function writeStore(store) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function appendAudit(event, details) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.stat(auditFile);
    if (stat.size >= 10 * 1024 * 1024) {
      await fs.rm(`${auditFile}.1`, { force: true });
      await fs.rename(auditFile, `${auditFile}.1`);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.appendFile(auditFile, JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + "\n", { mode: 0o600 });
}

async function main() {
  if (!command || !workspaceId || !idPattern.test(workspaceId)) {
    throw new Error("Usage: node manage-access.js add|rotate|remove|list <workspaceId> [userId] [admin|editor|viewer]");
  }
  if (!["add", "rotate", "remove", "list"].includes(command)) throw new Error("Unknown command. Use add, rotate, remove or list.");

  const store = await readStore(filename);
  const isNewWorkspace = !store.workspaces[workspaceId];
  const workspace = store.workspaces[workspaceId] ||= { members: {} };
  workspace.members ||= {};

  if (command === "list") {
    const members = Object.entries(workspace.members);
    if (!members.length) console.log(`${workspaceId}: no members configured`);
    for (const [id, member] of members) console.log(`${id}\t${member.role}\t${member.createdAt}`);
    return;
  }

  if (!userId || !idPattern.test(userId)) throw new Error("A valid userId is required.");
  if (command === "remove") {
    const member = workspace.members[userId];
    if (!member) throw new Error("Member does not exist.");
    if (member.role === "admin" && Object.values(workspace.members).filter((item) => item.role === "admin").length <= 1) {
      throw new Error("Cannot remove the last workspace administrator.");
    }
    delete workspace.members[userId];
    await writeStore(store);
    await appendAudit("MEMBER_REMOVED", { workspace: workspaceId, user: userId });
    console.log(`Removed ${workspaceId}/${userId}.`);
    return;
  }

  let role = requestedRole || workspace.members[userId]?.role || "editor";
  if (!roles.has(role)) throw new Error("Role must be admin, editor or viewer.");
  if (command === "add" && workspace.members[userId]) throw new Error("Member already exists; use rotate to replace their token.");
  if (isNewWorkspace && command === "add" && role !== "admin") {
    throw new Error("The first member of a workspace must be an admin. Add that admin first, then add editors/viewers.");
  }
  if (command === "rotate" && !workspace.members[userId]) throw new Error("Member does not exist; use add instead.");
  if (command === "rotate" && workspace.members[userId]?.role === "admin" && role !== "admin" &&
      Object.values(workspace.members).filter((item) => item.role === "admin").length <= 1) {
    throw new Error("Cannot demote the last workspace administrator.");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(token, salt, 64).toString("hex");
  workspace.members[userId] = { salt, hash, role, createdAt: workspace.members[userId]?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeStore(store);
  await appendAudit(command === "add" ? "MEMBER_ADDED" : "MEMBER_TOKEN_ROTATED", { workspace: workspaceId, user: userId, role });
  console.log(`Workspace: ${workspaceId}\nUser: ${userId}\nRole: ${role}\nToken: ${token}\nStore: ${filename}`);
  console.log("Copy the token now. It cannot be recovered; rotate it to issue a replacement.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
