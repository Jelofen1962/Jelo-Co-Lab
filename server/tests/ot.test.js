const test = require("node:test");
const assert = require("node:assert/strict");
const { diffText, applyOperation, changesToOperation, transformOperation } = require("../ot");

test("concurrent inserts at the same position converge deterministically", () => {
  const base = "abcd";
  const alice = diffText(base, "abAlice-cd");
  const bob = diffText(base, "abBob-cd");
  const aliceFirst = applyOperation(applyOperation(base, alice), transformOperation(bob, alice, false));
  const bobFirst = applyOperation(applyOperation(base, bob), transformOperation(alice, bob, true));
  assert.equal(aliceFirst, bobFirst);
});

test("overlapping replacements and deletes converge", () => {
  const scenarios = [
    ["abcdef", "aXef", "abcYf"],
    ["abcdef", "abef", "aZZdef"],
    ["hello world", "hello! world", "hello earth"],
    ["0123456789", "01A56789", "01234B89"],
  ];
  for (const [base, firstText, secondText] of scenarios) {
    const first = diffText(base, firstText);
    const second = diffText(base, secondText);
    const firstThenSecond = applyOperation(applyOperation(base, first), transformOperation(second, first, true));
    const secondThenFirst = applyOperation(applyOperation(base, second), transformOperation(first, second, false));
    assert.equal(firstThenSecond, secondThenFirst, `${base}: ${firstThenSecond} !== ${secondThenFirst}`);
  }
});

test("operations reject malformed ranges and preserve UTF-16 content", () => {
  const base = "A😀B";
  const next = "A🚀BC";
  const operation = diffText(base, next);
  assert.equal(applyOperation(base, operation), next);
  assert.throws(() => applyOperation("abc", [{ type: "retain", count: 4 }]));
});


test("many deterministic concurrent edits converge", () => {
  let seed = 0x12345678;
  const random = (limit) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const base = Array.from({ length: random(16) }, () => String.fromCharCode(97 + random(5))).join("");
    const edit = () => {
      const start = random(base.length + 1);
      const end = start + random(base.length - start + 1);
      const insert = Array.from({ length: random(5) }, () => String.fromCharCode(88 + random(3))).join("");
      return base.slice(0, start) + insert + base.slice(end);
    };
    const first = diffText(base, edit());
    const second = diffText(base, edit());
    const firstThenSecond = applyOperation(applyOperation(base, first), transformOperation(second, first, false));
    const secondThenFirst = applyOperation(applyOperation(base, second), transformOperation(first, second, true));
    assert.equal(firstThenSecond, secondThenFirst, `Concurrent OT did not converge on iteration ${iteration}`);
  }
});


test("multiple disjoint editor changes retain untouched text between them", () => {
  const before = "abcdefgh";
  const changes = [
    { rangeOffset: 6, rangeLength: 1, text: "Y" },
    { rangeOffset: 1, rangeLength: 1, text: "X" },
  ];
  const after = "aXcdefYh";
  const operation = changesToOperation(before, changes, after);
  assert.equal(applyOperation(before, operation), after);
  assert.ok(operation.some((part) => part.type === "retain" && part.count === 4));
});


test("three collaborators with queued local edits converge under interleaved server ordering", () => {
  let seed = 0x6d2b79f5;
  const random = (limit) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % limit;
  };
  const edit = (text) => {
    const start = random(text.length + 1);
    const end = start + random(text.length - start + 1);
    const inserted = Array.from({ length: random(4) }, () => String.fromCharCode(65 + random(26))).join("");
    return text.slice(0, start) + inserted + text.slice(end);
  };

  for (let trial = 0; trial < 300; trial += 1) {
    const base = Array.from({ length: random(18) }, () => String.fromCharCode(97 + random(6))).join("");
    const clients = ["alice", "bob", "carol"].map((id) => ({ id, text: base, revision: 0, pending: [] }));
    for (const client of clients) {
      for (let operation = 0; operation < 3; operation += 1) {
        const next = edit(client.text);
        const ops = diffText(client.text, next);
        if (next !== client.text) client.pending.push({ ops, opId: `${client.id}-${trial}-${operation}` });
        client.text = next;
      }
    }

    let serverText = base;
    const history = [];
    let revision = 0;
    while (clients.some((client) => client.pending.length)) {
      const ready = clients.filter((client) => client.pending.length);
      const sender = ready[random(ready.length)];
      let operation = sender.pending[0].ops;
      for (const previous of history) {
        if (previous.revision > sender.revision) {
          operation = transformOperation(operation, previous.ops, sender.id < previous.clientId);
        }
      }
      const baseRevision = revision;
      serverText = applyOperation(serverText, operation);
      revision += 1;
      const entry = { baseRevision, revision, clientId: sender.id, opId: sender.pending[0].opId, ops: operation };
      history.push(entry);

      for (const client of clients) {
        if (client === sender) {
          client.pending.shift();
          client.revision = revision;
          continue;
        }
        let remote = operation;
        for (const pending of client.pending) {
          const beforeRemote = remote;
          remote = transformOperation(beforeRemote, pending.ops, entry.clientId < client.id);
          pending.ops = transformOperation(pending.ops, beforeRemote, client.id < entry.clientId);
        }
        client.text = applyOperation(client.text, remote);
        client.revision = revision;
      }
    }
    assert.equal(clients[0].text, serverText, `alice diverged on trial ${trial}`);
    assert.equal(clients[1].text, serverText, `bob diverged on trial ${trial}`);
    assert.equal(clients[2].text, serverText, `carol diverged on trial ${trial}`);
    assert.ok(clients.every((client) => client.revision === revision));
  }
});
