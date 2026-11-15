import type { ActivityCategory, ActivityEntry, AuditEvent } from "@/types";

export const activityCategories: ActivityCategory[] = ["install", "tunnel", "server", "node", "settings", "other"];

export function isActivityCategory(value: string): value is ActivityCategory {
  return (activityCategories as readonly string[]).includes(value);
}

export function activityCategory(action: string): ActivityCategory {
  const value = action.toLowerCase();
  if (value.includes("tunnel")) return "tunnel";
  if (value.startsWith("provision") || value.startsWith("deploy") || value.startsWith("install") || value.startsWith("agent.")) return "install";
  if (value.startsWith("server") || value === "setservermaintenance" || value === "updateservernotes") return "server";
  if (value.startsWith("node.") || value === "updatenodesettings" || value.startsWith("v2board")) return "node";
  if (
    value.startsWith("settings") || value === "updatesettings" || value.startsWith("integration") || value.startsWith("notify") ||
    value === "failover.defaults" || value === "failover.policy" || value.startsWith("maintenance") ||
    value === "addwindow" || value === "removewindow"
  ) return "settings";
  return "other";
}

export function activityOutcome(action: string, detail: string): ActivityEntry["outcome"] {
  if (detail.includes("ناموفق") || /(?:^|[._])fail(?:ed|ure)?(?:[._]|$)/i.test(action) || /\bfailed\b/i.test(detail)) return "failed";
  if (detail.includes("نیاز به بررسی") || /(?:^|[._])review(?:[._]|$)/i.test(action)) return "info";
  return "success";
}

export function activityLinks(action: string, target: string): Pick<ActivityEntry, "serverId" | "nodeId" | "tunnelId"> {
  if (!target) return {};
  if (
    action === "tunnels.detach" || action.startsWith("provision.") || action.startsWith("servers.") ||
    action.startsWith("server.") || action.startsWith("install.") || action.startsWith("agent.")
  ) return { serverId: target };
  if (action.startsWith("tunnel")) return { tunnelId: target };
  if (action.startsWith("node.") || action === "updateNodeSettings" || action.startsWith("v2board")) return { nodeId: target };
  return {};
}

export function activityFromAudit(entry: Pick<AuditEvent, "id" | "at" | "actor" | "role" | "action" | "target" | "detail">): ActivityEntry {
  return {
    id: entry.id,
    at: entry.at,
    category: activityCategory(entry.action),
    action: entry.action,
    actor: entry.actor,
    role: entry.role,
    target: entry.target,
    detail: entry.detail,
    outcome: activityOutcome(entry.action, entry.detail),
    ...activityLinks(entry.action, entry.target),
  };
}
