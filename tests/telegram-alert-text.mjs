import assert from "node:assert/strict";
import { formatTelegramAlert } from "../src/lib/telegram-alert-text.ts";

const state = {
  servers: [{ id: "ir", name: "Iran", publicIpv4: "192.0.2.10", provider: "Iran Provider" },
    { id: "de", name: "Germany", publicIpv4: "198.51.100.20", provider: "Foreign Provider" }],
  nodes: [{ id: "node", name: "Premium Node", primaryTunnelId: "tunnel" }],
  tunnels: [{ id: "tunnel", name: "GRE Route", nodeIds: [], iranEndpoint: { serverId: "ir", publicIp: "192.0.2.11" },
    foreignEndpoint: { serverId: "de", publicIp: "198.51.100.21" } }],
};
const alert = { serverId: "de", tunnelId: "tunnel", severity: "warning", title: "Packet Loss", detail: "Loss 25% > 10%", createdAt: "2026-11-15T12:00:00Z" };
const text = formatTelegramAlert(state, alert);
assert.match(text, /نود: Premium Node/);
assert.match(text, /سرور خارج\nنام: Germany\nIP: .*198\.51\.100\.20.*\nارائه‌دهنده: Foreign Provider/u);
assert.match(text, /سرور ایران\nنام: Iran\nIP: .*192\.0\.2\.10.*\nارائه‌دهنده: Iran Provider/u);
assert.ok(text.includes("شرح: Loss 25% > 10%"));
state.tunnels[0].nodeRef = { kind: "v2board", key: "vless:7" };
assert.match(formatTelegramAlert(state, alert, [{ key: "vless:7", name: "Live Panel Name" }]), /نود: Live Panel Name/);
state.servers = [];
state.nodes = [];
const missing = formatTelegramAlert(state, alert);
assert.ok(missing.includes("198.51.100.21") && missing.includes("192.0.2.11"));
assert.ok(missing.includes("ارائه‌دهنده: نامشخص") && missing.includes("نود: متصل نیست"));
assert.ok(!missing.includes("undefined"));
state.servers = [{ id: "de", name: "Germany", publicIpv4: "198.51.100.20", provider: "Foreign Provider" }];
const serverAlert = formatTelegramAlert(state, { ...alert, tunnelId: undefined });
assert.ok(serverAlert.includes("سرور: Germany") && serverAlert.includes("Foreign Provider"));
assert.ok(!serverAlert.includes("سرور ایران"));
assert.ok(formatTelegramAlert(state, { ...alert, detail: "x".repeat(10000) }).length < 4000);
console.log("PASS: Telegram alert node names, endpoint roles, providers, missing inventory and message limits");
