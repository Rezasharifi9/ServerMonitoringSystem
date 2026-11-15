import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const upstream = globalThis.fetch;
const created = [];
let reads = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "panel.nodeguard.example") return upstream(input, init);
  if (url.pathname === "/api/v1/passport/auth/login") {
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), null);
    const { email, password } = JSON.parse(init.body);
    if (password !== "fixture-admin-password") return new Response(null, { status: 401 });
    return Response.json({ data: { is_admin: email === "admin@nodeguard" ? 1 : 0,
      auth_data: "fixture.v2board.admin-session", token: "fixture-user-subscription-token" } });
  }
  assert.ok(["Bearer fixture-panel-token", "fixture.v2board.admin-session"].includes(new Headers(init.headers).get("Authorization")));
  if (url.pathname.endsWith("/server/group/fetch")) return Response.json({ data: [{ id: 1, name: "Canary group" }] });
  if (url.pathname.endsWith("/server/route/fetch")) return Response.json({ data: [{ id: 2, remarks: "Canary route" }] });
  const nodeType = /\/server\/(vless|hysteria)\/save$/.exec(url.pathname)?.[1];
  if (nodeType) {
    assert.equal(init.method, "POST");
    const { id, ...fields } = JSON.parse(init.body);
    const record = { ...fields, id: id ?? 10, type: nodeType };
    const index = created.findIndex((item) => item.type === nodeType && item.id === id);
    if (index === -1) created.push(record);
    else created[index] = record;
    return Response.json({ data: true });
  }
  assert.equal(url.pathname, "/api/v1/fixture-admin/server/manage/getNodes");
  assert.equal(init.method, "GET");
  const stateFile = process.env.NODEGUARD_V2BOARD_TEST_STATE;
  const state = stateFile ? JSON.parse(await readFile(stateFile, "utf8")) : {};
  if (stateFile) {
    const temporary = stateFile + ".pending";
    await writeFile(temporary, JSON.stringify({ ...state, requests: (state.requests ?? 0) + 1 }));
    await rename(temporary, stateFile);
  }
  if (state.delayMs) await delay(state.delayMs);
  if (state.failure) return new Response("", { status: 502 });
  reads += 1;
  return Response.json({ data: [
    { id: 7, type: "vmess", name: "Mapped V2Board node", host: "de.nodeguard.example", port: "443", tls: 1, network: "ws", online: reads, secret: "discard this field" },
    { id: 8, type: "vless", name: "New inventory node", host: "192.0.2.77", port: "8443", server_port: "9443", tls: 2, network: "tcp", online: "11", parent_id: "1", tls_settings: { private_key: "discard private key" } },
    { id: 9, type: "hysteria", version: 2, name: "Hysteria2 node", host: "hy.nodeguard.example", port: "443-445", transport: "udp", online: null, online_user: 3, parent_id: 0 },
    ...created,
  ].filter((item) => item.id !== state.omit) });
};
