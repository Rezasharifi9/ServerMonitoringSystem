import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual sync functions with a slow transport and a changed session.
const source = await readFile(new URL("../src/services/backend.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("backend.ts", source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["syncBackend", "fetchWorkspace"].includes(node.name?.text)).map((node) => node.getText(ast).replace(/^export /, "")).join("\n");
let calls = 0;
let applied = 0;
let complete;
const state = { actor: { id: "admin" }, status: "connected" };
const context = vm.createContext({
  AbortSignal, BackendError: class extends Error {},
  request: () => { calls++; return new Promise((resolve) => { complete = resolve; }); },
  apply: () => { applied++; },
  useBackend: { getState: () => state, setState: (patch) => Object.assign(state, patch) },
});
vm.runInContext(ts.transpile(`let generation = 0; let workspaceSync; ${functions}`), context);
const first = context.syncBackend();
assert.equal(context.syncBackend(), first, "concurrent callers must share the request");
assert.equal(calls, 1);
complete({});
await first;
assert.equal(applied, 1);
const second = context.syncBackend();
assert.equal(calls, 2, "completed requests must release the lock");
vm.runInContext("generation++", context);
const oldComplete = complete;
const third = context.syncBackend();
assert.equal(calls, 3, "a new session must not reuse an old request");
oldComplete({});
await second;
assert.equal(applied, 1, "old sessions must not overwrite current data");
assert.equal(context.syncBackend(), third, "old cleanup must not release the current lock");
complete({});
await third;
assert.equal(applied, 2);
context.request = async () => { throw new Error("Fixture network failure"); };
await context.syncBackend();
assert.equal(state.status, "error", "failed requests must report failure without leaving a stuck lock");
context.request = async () => ({});
await context.syncBackend();
assert.equal(applied, 3, "a failed request must release the lock for recovery");
console.log("Workspace sync: coalescing, cleanup, session isolation and error recovery passed.");
