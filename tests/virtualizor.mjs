import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(join(root, "src", specifier.slice(2))).href;
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(fileURLToPath(url) + ".ts")) specifier = url.href + ".ts";
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes("/src/i18n/") && url.endsWith(".json")) return { format: "module", source: "export default " + readFileSync(new URL(url), "utf8"), shortCircuit: true };
    return next(url, context);
  },
});

const temp = await mkdtemp(join(tmpdir(), "nodeguard-virtualizor-"));
process.env.NODEGUARD_DB_PATH = join(temp, "test.sqlite");
process.env.NODEGUARD_WORKSPACE_MODE = "monitor";
process.env.NODEGUARD_INVENTORY_PATH = join(root, "inventory.example.json");
process.env.NODEGUARD_CREDENTIAL_KEY = "a".repeat(64);
const api = await import("../src/server/virtualizor.ts");
const { database } = await import("../src/server/database.ts");
const actor = { id: "admin", name: "Admin", role: "super-admin", email: "" };
const readonly = { ...actor, role: "readonly" };
const originalFetch = globalThis.fetch;
let requests = [];
let response = { info: { vps: { vpsid: "123", hostname: "ir.example.com", ram: "2048", space: "30", cores: "2", password: "do-not-return" }, virt: "kvm", ip: ["5.1.2.3"], status: 1 } };
globalThis.fetch = async (url, options) => {
  requests.push(new URL(url));
  assert.equal(options.redirect, "error");
  assert.equal(new URL(url).searchParams.get("apikey"), "fixture-key");
  return Response.json(response);
};
try {
  assert.throws(() => api.virtualizorSettings(readonly), (e) => e.code === "FORBIDDEN");
  assert.throws(() => api.saveVirtualizorSettings(actor, { endpoint: "http://127.0.0.1:4083", apiKey: "fixture-key", apiPassword: "fixture-secret" }));
  const settings = api.saveVirtualizorSettings(actor, { endpoint: "https://panel.example.com:4083", apiKey: "fixture-key", apiPassword: "fixture-secret" });
  assert.equal(settings.configured, true);
  assert.ok(!JSON.stringify(settings).includes("fixture-secret"));
  const sealed = database().prepare("SELECT sealed FROM provider_credentials WHERE provider='virtualizor'").get().sealed;
  assert.ok(!sealed.includes("fixture-secret"));
  assert.equal((await api.serverVirtualizor(actor, "ir-main")).info, null);
  await assert.rejects(api.serverVirtualizor(actor, "exit-1"));
  await assert.rejects(api.bindVirtualizor(readonly, "ir-main", { vpsId: "123" }));
  await assert.rejects(api.bindVirtualizor(actor, "ir-main", { vpsId: "0" }));
  const bound = await api.bindVirtualizor(actor, "ir-main", { vpsId: "123" });
  assert.equal(bound.info.ramMb, "2048");
  assert.equal(bound.info.status, "online");
  assert.equal(bound.info.ip, "5.1.2.3");
  assert.ok(!JSON.stringify(bound).includes("do-not-return"));
  assert.equal(requests.at(-1).searchParams.get("act"), "vpsmanage");
  assert.equal(requests.at(-1).searchParams.has("do"), false);
  await assert.rejects(api.controlVirtualizor(readonly, "ir-main", { action: "restart" }));
  await assert.rejects(api.controlVirtualizor(actor, "ir-main", { action: "delete" }));
  response = { info: { vps: { vpsid: "999" } } };
  await assert.rejects(api.bindVirtualizor(actor, "ir-main", { vpsId: "123" }));
  await assert.rejects(api.controlVirtualizor(actor, "ir-main", { action: "restart" }));
  response = { vpsid: 123, vpsinfo: { vpsid: "123", hostname: "ir.example.com", status: "online" } };
  const infoResponse = response;
  globalThis.fetch = async (url) => { const u = new URL(url); requests.push(u); return Response.json(u.searchParams.get("act") === "vpsmanage" ? infoResponse : { done: { msg: "success" }, status: 0 }); };
  assert.deepEqual(await api.controlVirtualizor(actor, "ir-main", { action: "restart" }), { accepted: true });
  assert.equal(requests.at(-1).searchParams.get("do"), "1");
  assert.equal(requests.at(-1).searchParams.get("svs"), "123");
  globalThis.fetch = async () => Response.json({ error: ["fixture-secret"] });
  await assert.rejects(api.serverVirtualizor(actor, "ir-main"), (e) => e.code === "VIRTUALIZOR_UPSTREAM" && !e.message.includes("fixture-secret"));
  api.saveVirtualizorSettings(actor, { endpoint: "https://other.example.com:4083", apiKey: "fixture-key", apiPassword: "fixture-secret" });
  assert.equal((await api.serverVirtualizor(actor, "ir-main")).info, null);
  await assert.rejects(api.controlVirtualizor(actor, "ir-main", { action: "start" }));
  api.unbindVirtualizor(actor, "ir-main");
  assert.equal((await api.serverVirtualizor(actor, "ir-main")).vpsId, "");
  console.log("PASS: Virtualizor encryption, permissions, Iran scope, binding, response filtering and power commands");
} finally { globalThis.fetch = originalFetch; database().close(); await rm(temp, { recursive: true, force: true }); }
