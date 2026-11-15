import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { readFileSync, writeFileSync } from "node:fs";

const recordId = "b".repeat(32);
const zone = "/client/v4/zones/" + "a".repeat(32) + "/dns_records";
const statePath = process.env.NODEGUARD_CF_TEST_STATE;
const domain = "de.nodeguard.example";

const initial = {
  record: {
    id: recordId, name: domain, type: "A", content: "192.0.2.10", proxied: false, ttl: 60,
    comment: "fixture original", modified_on: "2020-01-01T00:00:00.000Z", tags: ["nodeguard:managed"],
  },
  writes: 0,
};

function state() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(initial);
    throw error;
  }
}

const resolve4 = Resolver.prototype.resolve4;
Resolver.prototype.resolve4 = async function (name, ...args) {
  if (name !== domain) return resolve4.call(this, name, ...args);
  const data = state();
  const values = data.resolver?.a ?? (data.record.type === "A" ? [data.record.content] : []);
  return args[0]?.ttl ? values.map((address) => ({ address, ttl: 37 })) : values;
};

const resolve6 = Resolver.prototype.resolve6;
Resolver.prototype.resolve6 = async function (name, ...args) {
  if (name !== domain) return resolve6.call(this, name, ...args);
  const data = state();
  if (data.resolver?.v6Timeout) throw Object.assign(new Error("Fixture DNS timeout"), { code: "ETIMEOUT" });
  const values = data.resolver?.aaaa ?? [];
  return args[0]?.ttl ? values.map((address) => ({ address, ttl: 19 })) : values;
};

const resolveCname = Resolver.prototype.resolveCname;
Resolver.prototype.resolveCname = async function (name, ...args) {
  if (name !== domain) return resolveCname.call(this, name, ...args);
  const values = state().resolver?.cname ?? [];
  if (!values.length) throw Object.assign(new Error("Fixture DNS no answer"), { code: "ENODATA" });
  return values;
};

const upstream = globalThis.fetch;
const managedRecords = new Map();
const zoneId = "e".repeat(32);
const managedArvanId = "ba9b61c5-dd91-43bf-8161-15a7a0683eea";
function managedDns(url, init, arvan) {
  const path = arvan ? "/cdn/4.0/domains" : "/client/v4/zones";
  const recordsPath = arvan ? path + "/example.org/dns-records" : path + `/${zoneId}/dns_records`;
  const response = (value, list = false) => Response.json(arvan ? { data: value, ...(list && { meta: { current_page: 1, last_page: 1 } }) } :
    { success: true, result: value, ...(list && { result_info: { total_pages: 1 } }) });
  const recordKey = arvan ? managedArvanId : "d".repeat(32);
  if (url.pathname === path) return response([{ id: zoneId, name: "example.org", status: "active" }], true);
  assert.ok(url.pathname === recordsPath || url.pathname === `${recordsPath}/${recordKey}`);
  const current = managedRecords.get(recordKey);
  if (init.method === "GET") return url.pathname === recordsPath ? response(current ? [current] : [], true) : response(current);
  assert.equal(init.method, url.pathname === recordsPath ? "POST" : arvan ? "PUT" : "PATCH");
  const next = { ...current, ...JSON.parse(init.body), id: recordKey };
  managedRecords.set(recordKey, next);
  return response(next);
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const auth = new Headers(init?.headers).get("Authorization");
  if (url.hostname === "api.cloudflare.com" && auth === "Bearer fixture-managed-cf-key") return managedDns(url, init, false);
  if (url.hostname === "napi.arvancloud.ir" && auth === "Apikey fixture-managed-arvan-key") return managedDns(url, init, true);
  if (url.hostname === "napi.arvancloud.ir") {
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("Authorization"), "Apikey fixture-arvan-read-key");
    assert.equal(url.pathname, "/cdn/4.0/domains/nodeguard.example/dns-records");
    const number = Number(url.searchParams.get("page"));
    return Response.json({
      data: number === 1 ? [{ type: "a", name: "other", value: [{ ip: "192.0.2.99" }], ttl: 120, cloud: false }] :
        [{ type: "a", name: "de", value: [{ ip: "192.0.2.10" }], ttl: 120, cloud: false }],
      meta: { current_page: number, last_page: 2 },
    });
  }
  if (url.hostname !== "api.cloudflare.com") return upstream(input, init);
  const method = init.method;
  const authorization = new Headers(init.headers).get("Authorization");
  const data = state();
  if (method === "GET") {
    assert.equal(authorization, "Bearer fixture-dns-token");
    assert.equal(url.pathname, zone);
    assert.equal(url.searchParams.get("name.exact"), domain);
    if (data.readDelayMs) await new Promise((resolve) => setTimeout(resolve, data.readDelayMs));
    if (data.readError) return Response.json({ success: false }, { status: 503 });
    return Response.json({ success: true, result: [data.record, ...(data.additionalRecords ?? [])], result_info: { total_pages: 1 } });
  }
  assert.equal(method, "PATCH");
  assert.equal(authorization, "Bearer fixture-dns-write-token");
  assert.equal(url.pathname, zone + "/" + recordId);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ["comment", "content"]);
  assert.ok(["192.0.2.10", "192.0.2.11"].includes(body.content));
  assert.equal(typeof body.comment, "string");
  data.record = { ...data.record, ...body, modified_on: new Date(Date.now() + ++data.writes).toISOString() };
  const drop = data.dropNext;
  delete data.dropNext;
  writeFileSync(statePath, JSON.stringify(data));
  if (drop) throw new Error("Fixture lost write response");
  return Response.json({ success: true, result: data.record });
};
