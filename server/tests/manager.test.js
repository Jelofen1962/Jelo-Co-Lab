"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");

 test("server manager renders a useful non-TTY dashboard and exits cleanly", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jelo-manager-test-"));
  try {
    const managerPath = path.resolve(__dirname, "..", "manager.js");
    const source = `Object.defineProperty(process, "getuid", { value: () => 0 });\nrequire(${JSON.stringify(managerPath)});`;
    const result = spawnSync(process.execPath, ["-e", source], {
      input: "0\n",
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        JELO_ENV_FILE: path.join(dataDir, "missing.env"),
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /JELO CO-LAB/);
    assert.match(result.stdout, /SERVER MANAGER/);
    assert.match(result.stdout, /QUICK ACTIONS/);
    assert.match(result.stdout, /Network/);
    assert.match(result.stdout, /Choose an action/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
