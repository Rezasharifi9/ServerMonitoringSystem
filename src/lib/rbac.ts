import type { DemoRole } from "@/types";

export type AppAction =
  | "node.edit"
  | "server.restart"
  | "server.configure"
  | "agent.enroll"
  | "tunnel.mutate"
  | "tunnel.delete"
  | "tunnel.create"
  | "failover.run"
  | "failover.configure"
  | "dns.check"
  | "dns.switch"
  | "deploy.run"
  | "alert.manage"
  | "settings.edit"
  | "settings.security"
  | "integration.edit"
  | "report.export"
  | "speedtest.run";

const matrix: Record<DemoRole, AppAction[] | "*"> = {
  "super-admin": "*",
  "infra-admin": [
    "node.edit",
    "server.restart",
    "server.configure",
    "agent.enroll",
    "tunnel.mutate",
    "tunnel.delete",
    "tunnel.create",
    "failover.run",
    "failover.configure",
    "dns.check",
    "dns.switch",
    "deploy.run",
    "alert.manage",
    "settings.edit",
    "integration.edit",
    "report.export",
    "speedtest.run",
  ],
  operator: [
    "server.restart",
    "tunnel.mutate",
    "failover.run",
    "dns.check",
    "deploy.run",
    "alert.manage",
    "report.export",
    "speedtest.run",
  ],
  readonly: ["report.export"],
};

export function can(role: DemoRole, action: AppAction) {
  const allowed = matrix[role];
  return allowed === "*" || allowed.includes(action);
}
