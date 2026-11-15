import type { Alert, DemoSnapshot, V2BoardCatalogEntry } from "@/types";

type AlertContext = Pick<DemoSnapshot, "servers" | "nodes" | "tunnels">;
const line = (value: string | undefined, limit = 160) => value?.replace(/\s+/gu, " ").trim().slice(0, limit) || "نامشخص";
const ip = (value: string | undefined) => `\u2066${line(value, 64)}\u2069`;

export function formatTelegramAlert(state: AlertContext, alert: Alert, panelNodes: Pick<V2BoardCatalogEntry, "key" | "name">[] = []) {
  const severity = { info: "ℹ️ اطلاع‌رسانی", warning: "⚠️ هشدار", critical: "🔴 بحرانی" }[alert.severity];
  const tunnel = state.tunnels.find(t => t.id === alert.tunnelId);
  const server = state.servers.find(s => s.id === alert.serverId);
  const nodes = state.nodes.filter(node => tunnel && (
    tunnel.nodeIds.includes(node.id) || tunnel.nodeRef?.kind === "inventory" && tunnel.nodeRef.id === node.id ||
    node.primaryTunnelId === tunnel.id || node.backupTunnelId === tunnel.id || node.tunnelIds?.includes(tunnel.id)
  ));
  const ref = tunnel?.nodeRef;
  const panel = ref?.kind === "v2board" ? panelNodes.find(node => node.key === ref.key) : undefined;
  const nodeNames = [...new Set(panel ? [panel.name] : nodes.map(node => node.name))].map(name => line(name)).join("، ");
  const at = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "medium" }).format(new Date(alert.createdAt));
  const parts = ["NodeGuard | " + severity, "", "📋 قانون: " + line(alert.title)];
  if (tunnel) {
    parts.push("🧩 نود: " + (nodeNames ? line(nodeNames, 400) : "متصل نیست"), "🔗 تونل: " + line(tunnel.name));
    for (const [label, endpoint] of [["🌍 سرور خارج", tunnel.foreignEndpoint], ["🇮🇷 سرور ایران", tunnel.iranEndpoint]] as const) {
      const host = state.servers.find(item => item.id === endpoint.serverId);
      parts.push("", label, "نام: " + line(host?.name), "IP: " + ip(host?.publicIpv4 || endpoint.publicIp), "ارائه‌دهنده: " + line(host?.provider));
    }
  } else if (server) {
    parts.push("", "🖥 سرور: " + line(server.name), "IP: " + ip(server.publicIpv4), "ارائه‌دهنده: " + line(server.provider));
  }
  parts.push("", "📝 شرح: " + line(alert.detail, 900), "🕒 زمان (تهران): " + at);
  return parts.join("\n");
}
