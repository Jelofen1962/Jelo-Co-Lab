const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
  await runTests({
    version: "stable",
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--disable-workspace-trust", "--skip-welcome"],
  });
}

main().catch((error) => {
  console.error("Jelo Co-Lab Extension Host tests failed:", error);
  process.exitCode = 1;
});
