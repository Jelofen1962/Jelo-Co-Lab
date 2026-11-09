#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync, spawn } = require("node:child_process");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const APP_DIR = __dirname;
const SERVICE = process.env.JELO_SERVICE || "jelo-colab";
const ENV_FILE = process.env.JELO_ENV_FILE || "/etc/jelo-colab.env";
function readEnvironment() {
  try {
    const values = {};
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2];
    }
    return values;
  } catch { return {}; }
}
const FILE_ENV = readEnvironment();
const DATA_DIR = process.env.DATA_DIR || FILE_ENV.DATA_DIR || "/var/lib/jelo-colab";
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", blue: "\x1b[34m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", white: "\x1b[97m" };
const color = (value, shade) => stdout.isTTY ? `${C[shade] || ""}${value}${C.reset}` : String(value);

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout || 30_000, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim());
  return result;
}

function serviceState() {
  return run("systemctl", ["is-active", SERVICE], { allowFailure: true }).stdout.trim() || "unknown";
}

async function health() {
  const env = readEnvironment();
  const port = Number(env.PORT || process.env.PORT || 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    const payload = await response.json();
    return response.ok ? payload : null;
  } catch { return null; }
}

function localAddresses() {
  const values = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) if (!item.internal && (item.family === "IPv4" || item.family === 4)) values.push({ name, address: item.address });
  }
  return values;
}

function bytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value, index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function uptime(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function boxLine(text, width = 76) {
  // The manager is used from SSH and narrow split terminals as well as full screens.
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, "");
  const maxText = Math.max(1, width - 2);
  const characters = Array.from(clean);
  const fitted = characters.length > maxText
    ? `${characters.slice(0, maxText - 1).join("")}…`
    : clean;
  const visible = Array.from(fitted).length;
  return `│ ${fitted}${" ".repeat(Math.max(0, maxText - visible))} │`;
}

function drawFrame(lines) {
  // Keep a readable minimum while using the available SSH/terminal width.
  const width = Math.max(42, Math.min(88, (stdout.columns || 80) - 4));
  const top = `┌${"─".repeat(width)}┐`;
  const bottom = `└${"─".repeat(width)}┘`;
  console.log(color(top, "cyan"));
  for (const line of lines) console.log(color(boxLine(line, width), "cyan"));
  console.log(color(bottom, "cyan"));
}

function clear() { if (stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H"); }

async function dashboard() {
  const pkg = require(path.join(APP_DIR, "package.json"));
  const [healthData, disk] = await Promise.all([
    health(),
    Promise.resolve().then(() => { try { return fs.statfsSync(DATA_DIR); } catch { return null; } }),
  ]);
  const service = serviceState();
  const status = healthData ? color("● HEALTHY", "green") : color("● UNAVAILABLE", "red");
  const diskText = disk ? `${bytes(disk.bavail * disk.bsize)} free / ${bytes(disk.blocks * disk.bsize)}` : "not available";
  const ips = localAddresses().map((entry) => `${entry.address} (${entry.name})`).join(", ") || "No LAN IPv4 address detected";
  const lines = [
    `${color("JELO CO-LAB", "bold")}  ${color(`SERVER MANAGER  v${pkg.version}`, "dim")}`,
    "",
    `${color("SERVICE", "bold")}  ${service === "active" ? color(service.toUpperCase(), "green") : color(service.toUpperCase(), "red")}     ${color("API", "bold")}  ${status}`,
    `${color("UPTIME", "bold")}   ${healthData ? uptime(healthData.uptimeSeconds) : "—"}     ${color("CLIENTS", "bold")}  ${healthData?.connections ?? "—"}`,
    `${color("MEMORY", "bold")}  ${healthData ? bytes(healthData.memoryBytes) : "—"}     ${color("DISK", "bold")}  ${diskText}`,
    "",
    `${color("VERSION", "bold")}  ${healthData?.version || pkg.version}`,
    `${color("DATA", "bold")}     ${DATA_DIR}`,
    `${color("NETWORK", "bold")}  ${ips}`,
    "",
    color("QUICK ACTIONS", "bold"),
    "  1  Service status       2  Restart service",
    "  3  Start / stop         4  Live logs",
    "  5  Workspace members   6  Create backup",
    "  7  Restore backup      8  Configure TLS (Caddy)",
    "  9  Network addresses  10  Run diagnostics",
    "  0  Exit",
    "",
    color("Tip: run `sudo jelo-colab` any time to reopen this manager.", "dim"),
  ];
  clear();
  drawFrame(lines);
}

async function prompt(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function pause() { await prompt(`\n${color("Press Enter to return to the dashboard...", "dim")}`); }

function showCommand(title, command, args, options = {}) {
  console.log(`\n${color(title, "bold")}`);
  const result = run(command, args, { allowFailure: true, timeout: options.timeout || 30_000 });
  if (result.stdout) console.log(result.stdout.trimEnd());
  if (result.stderr) console.error(result.stderr.trimEnd());
  if (result.status !== 0) console.log(color(`Command exited with status ${result.status}.`, "yellow"));
  return result;
}

async function liveLogs() {
  console.log(color("Live service logs · press Ctrl+C to return", "bold"));
  await new Promise((resolve) => {
    const child = spawn("journalctl", ["-u", SERVICE, "-f", "-n", "80", "--no-pager"], { stdio: "inherit" });
    const finish = () => { child.kill("SIGTERM"); resolve(); };
    process.once("SIGINT", finish);
    child.once("exit", () => { process.removeListener("SIGINT", finish); resolve(); });
  });
}

function memberCommand(args) {
  const script = path.join(APP_DIR, "manage-access.js");
  const runner = fs.existsSync("/usr/sbin/runuser") ? "/usr/sbin/runuser" : "runuser";
  return run(runner, ["-u", "jelo-colab", "--", "env", `DATA_DIR=${DATA_DIR}`, process.execPath, script, ...args], { allowFailure: true, timeout: 60_000 });
}

async function manageMembers() {
  const workspace = await prompt("Workspace ID: ");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) throw new Error("Invalid workspace ID.");
  console.log("\n1 List members  2 Add member  3 Rotate token  4 Remove member");
  const choice = await prompt("Select: ");
  if (choice === "1") {
    const storePath = path.join(DATA_DIR, "access.json");
    let store = { workspaces: {} };
    try { store = JSON.parse(fs.readFileSync(storePath, "utf8")); } catch {}
    const members = store.workspaces?.[workspace]?.members || {};
    console.log(`\n${workspace}: ${Object.keys(members).length} member(s)`);
    for (const [id, member] of Object.entries(members)) console.log(`  ${id.padEnd(24)} ${member.role.padEnd(8)} joined ${member.createdAt || "unknown"}`);
    if (!Object.keys(members).length) console.log("  No members configured.");
    return;
  }
  const user = await prompt("User ID: ");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(user)) throw new Error("Invalid user ID.");
  let args;
  if (choice === "2" || choice === "3") {
    const role = await prompt("Role (admin/editor/viewer) [editor]: ") || "editor";
    if (!["admin", "editor", "viewer"].includes(role)) throw new Error("Invalid role.");
    args = [choice === "2" ? "add" : "rotate", workspace, user, role];
  } else if (choice === "4") {
    const confirm = await prompt(`Type REMOVE to remove ${user}: `);
    if (confirm !== "REMOVE") { console.log("Cancelled."); return; }
    args = ["remove", workspace, user];
  } else throw new Error("Unknown member action.");
  const result = memberCommand(args);
  if (result.stdout) console.log(result.stdout.trimEnd());
  if (result.stderr) console.error(result.stderr.trimEnd());
  if (result.status !== 0) throw new Error("Member operation failed.");
  if (choice === "2" || choice === "3") console.log(color("Save the token shown above now. It cannot be recovered later.", "yellow"));
}

async function backup() {
  showCommand("Creating a verified backup", "bash", [path.join(APP_DIR, "scripts", "backup-server.sh")], { timeout: 120_000 });
}

async function restore() {
  const archive = await prompt("Absolute path to backup .tar.gz: ");
  if (!path.isAbsolute(archive) || !fs.existsSync(archive)) throw new Error("Backup archive path does not exist or is not absolute.");
  const confirm = await prompt("Restore replaces current workspace data. Type RESTORE to continue: ");
  if (confirm !== "RESTORE") { console.log("Cancelled."); return; }
  showCommand("Restoring backup", "bash", [path.join(APP_DIR, "scripts", "restore-server.sh"), archive], { timeout: 180_000 });
}

async function configureTls() {
  const domain = await prompt("Public DNS domain (for example collab.example.com): ");
  if (!/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(domain)) throw new Error("Enter a valid public DNS domain.");
  showCommand("Configuring Caddy TLS reverse proxy", "bash", [path.join(APP_DIR, "scripts", "configure-caddy.sh"), domain], { timeout: 180_000 });
}

async function networkAddresses() {
  console.log(`\n${color("LAN IPv4 addresses", "bold")}`);
  for (const item of localAddresses()) console.log(`  ${item.name.padEnd(14)} ${item.address}`);
  console.log("\nPublic IP lookup requires an external service and is performed only when requested.");
  if ((await prompt("Look up public IP via api.ipify.org? [y/N]: ")).toLowerCase() === "y") {
    showCommand("Public IP", "curl", ["-fsS", "--max-time", "5", "https://api.ipify.org"]);
  }
}

async function diagnostics() {
  console.log(`\n${color("Jelo Co-Lab diagnostics", "bold")}`);
  showCommand("Systemd", "systemctl", ["--no-pager", "--full", "status", SERVICE]);
  const data = await health();
  console.log("\nHealth endpoint:");
  console.log(data ? JSON.stringify(data, null, 2) : color("Unavailable: check service logs and environment configuration.", "red"));
  showCommand("Recent errors", "journalctl", ["-u", SERVICE, "-p", "err", "-n", "30", "--no-pager"]);
  console.log(`\nNode: ${process.version}`);
}

async function main() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("Run the server manager with sudo: sudo jelo-colab");
    process.exit(1);
  }
  while (true) {
    await dashboard();
    const choice = await prompt("\nChoose an action [0-10]: ");
    try {
      switch (choice) {
        case "1": showCommand("Service status", "systemctl", ["--no-pager", "--full", "status", SERVICE]); await pause(); break;
        case "2": showCommand("Restarting service", "systemctl", ["restart", SERVICE]); await pause(); break;
        case "3": {
          const state = serviceState();
          showCommand(state === "active" ? "Stopping service" : "Starting service", "systemctl", [state === "active" ? "stop" : "start", SERVICE]);
          await pause(); break;
        }
        case "4": await liveLogs(); break;
        case "5": await manageMembers(); await pause(); break;
        case "6": await backup(); await pause(); break;
        case "7": await restore(); await pause(); break;
        case "8": await configureTls(); await pause(); break;
        case "9": await networkAddresses(); await pause(); break;
        case "10": await diagnostics(); await pause(); break;
        case "0": return;
        default: console.log(color("Choose a menu item from 0 to 10.", "yellow")); await pause();
      }
    } catch (error) {
      console.error(color(`\n${error.message}`, "red"));
      await pause();
    }
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
