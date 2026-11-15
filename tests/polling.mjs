import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib/polling.ts', import.meta.url), 'utf8');
const context = vm.createContext({ exports: {} });
vm.runInContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS }), context);
const { POLLING, pollingInterval, jobActive } = context.exports;
for (const state of ['pending', 'success', 'error']) {
  assert.equal(pollingInterval({state:{fetchStatus:'fetching',status:state}}, POLLING.job), false);
  assert.equal(pollingInterval({state:{fetchStatus:'paused',status:state}}, POLLING.job), false);
  assert.equal(pollingInterval({state:{fetchStatus:'idle',status:state}}, false), false);
}
assert.equal(pollingInterval({state:{fetchStatus:'idle',status:'success'}}, POLLING.job), 3000);
assert.equal(pollingInterval({state:{fetchStatus:'idle',status:'error'}}, POLLING.job), 60000);
assert.equal(pollingInterval({state:{fetchStatus:'idle',status:'error'}}, 120000), 120000);
for (const status of ['queued','running','deploying','applying','verifying','rolling_back']) assert.ok(jobActive({status}));
for (const status of ['succeeded','failed','review','cancelled','expired']) assert.ok(!jobActive({status}));
console.log('Polling policy: in-flight/offline suppression, error cooldown and active job detection passed.');
