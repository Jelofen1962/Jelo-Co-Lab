const assert = require("node:assert/strict");
const vscode = require("vscode");

const tests = [];

function test(name, runTest) {
  tests.push({ name, runTest });
}

test("activates and registers the collaboration commands", async () => {
  const extension = vscode.extensions.getExtension("jelofen.jelofen-co-lab");
  assert.ok(extension, "Jelo Co-Lab extension must be installed in the test host");
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    "collab.start", "collab.setConfig", "collab.quickStart", "collab.onboarding",
    "collab.pushDir", "collab.reconcile", "collab.conflicts", "collab.pauseTransfers",
    "collab.resumeTransfers", "collab.showDiagnostics", "collab.leaveWorkspace",
  ]) {
    assert.ok(commands.has(command), `Missing command: ${command}`);
  }
});

test("publishes the collaborator, transfer and conflict views", () => {
  const extension = vscode.extensions.getExtension("jelofen.jelofen-co-lab");
  assert.ok(extension, "Jelo Co-Lab extension must be installed in the test host");

  const views = extension.packageJSON.contributes.views["jelo-colab"].map((view) => view.id);
  assert.deepEqual(views, ["jelo.collaborators", "jelo.transfers", "jelo.conflicts"]);

  const welcomeViews = new Set(extension.packageJSON.contributes.viewsWelcome.map((view) => view.view));
  for (const view of views) {
    assert.ok(welcomeViews.has(view), `Missing empty-state guidance for ${view}`);
  }
});

test("keeps the remote-server transport policy secure by default", () => {
  const extension = vscode.extensions.getExtension("jelofen.jelofen-co-lab");
  assert.ok(extension, "Jelo Co-Lab extension must be installed in the test host");

  const properties = extension.packageJSON.contributes.configuration.properties;
  assert.equal(properties["collab.serverUrl"].default, "ws://localhost:3000");
  assert.match(properties["collab.serverUrl"].description, /wss:\/\//);
  assert.equal(properties["collab.autoReconcile"].default, true);
});

async function run() {
  const failures = [];

  for (const { name, runTest } of tests) {
    try {
      await runTest();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`  ✗ ${name}`);
      console.error(error);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${tests.length} Jelo Co-Lab Extension Host tests failed`);
  }

  console.log(`Jelo Co-Lab Extension Host: ${tests.length}/${tests.length} tests passed`);
}

// VS Code's Extension Host test loader calls the exported run() function.
// Keeping this tiny runner dependency-free avoids requiring Mocha in the test host.
module.exports = { run };
