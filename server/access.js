"use strict";
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const ROLES = new Set(["admin", "editor", "viewer"]);

async function readStore(filename) {
  try {
    const stat = await fs.stat(filename);
    if (stat.size > 2 * 1024 * 1024) throw new Error("Access store exceeds the 2 MiB safety limit");
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    if (value.version !== 1 || !value.workspaces || typeof value.workspaces !== "object" || Array.isArray(value.workspaces)) {
      throw new Error("Invalid access store format");
    }
    for (const [workspaceId, workspace] of Object.entries(value.workspaces)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workspaceId) || !workspace ||
          !workspace.members || typeof workspace.members !== "object" || Array.isArray(workspace.members)) {
        throw new Error("Invalid workspace access entry");
      }
      for (const [userId, member] of Object.entries(workspace.members)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(userId) || !member ||
            !/^[a-f0-9]{32}$/.test(member.salt || "") || !/^[a-f0-9]{128}$/.test(member.hash || "") ||
            !ROLES.has(member.role) || typeof member.createdAt !== "string") {
          throw new Error(`Invalid member access entry: ${workspaceId}/${userId}`);
        }
      }
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, workspaces: {} };
    throw error;
  }
}

function verifyMember(token, member) {
  if (typeof token !== "string" || token.length < 24 || token.length > 256 || !member) return false;
  const expected = Buffer.from(member.hash, "hex");
  const actual = crypto.scryptSync(token, member.salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function authenticate({ filename, workspaceId, userId, token, bootstrapToken }) {
  if (typeof workspaceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workspaceId) ||
      typeof userId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,63}$/.test(userId)) return null;
  const store = await readStore(filename);
  const workspace = store.workspaces[workspaceId];
  if (workspace) {
    const member = workspace.members?.[userId];
    if (!member || !verifyMember(token, member)) return null;
    return { role: member.role, memberSince: member.createdAt };
  }
  if (typeof token === "string" && typeof bootstrapToken === "string" && token.length >= 24 &&
      token.length === bootstrapToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(bootstrapToken))) {
    return { role: "admin", bootstrap: true };
  }
  return null;
}

module.exports = { readStore, verifyMember, authenticate };
