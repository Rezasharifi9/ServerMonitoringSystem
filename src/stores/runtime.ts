import { activeServerId, decorateNodes } from "@/lib/health";
import { t } from "@/i18n/runtime";
import { can, type AppAction } from "@/lib/rbac";
import { uid } from "@/lib/utils";
import type {
  Alert,
  AuditEvent,
  DemoSnapshot,
  FailoverRun,
  FailoverScenario,
  Incident,
} from "@/types";

export interface RuntimeBag extends DemoSnapshot {
  currentUserId: string;
  failoverRun: FailoverRun | null;
}

export interface WorkflowClock {
  pause(ms: number): Promise<void>;
  interval(fn: () => void, ms: number): number;
  cancelInterval(id: number): void;
  later(fn: () => void, ms: number): void;
  track(task: Promise<void>): void;
}

const browserClock: WorkflowClock = {
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  interval: (fn, ms) => window.setInterval(fn, ms),
  cancelInterval: (id) => window.clearInterval(id),
  later: (fn, ms) => { setTimeout(fn, ms); },
  track: (task) => { void task; },
};

export function createWorkflowRuntime(clock = browserClock) {
  return {
    clock,
    failoverToken: 0,
    savedHosts: new Map<string, Pick<DemoSnapshot["servers"][number], "status" | "cpu" | "ram" | "rxMbps" | "txMbps">>(),
  };
}

export type WorkflowRuntime = ReturnType<typeof createWorkflowRuntime>;

export function actorOf(state: RuntimeBag) {
  return state.users.find((user) => user.id === state.currentUserId) ?? state.users[0];
}

export function guardOf(state: RuntimeBag, action: AppAction) {
  if (!can(actorOf(state).role, action)) return t("common.permissionDenied");
  return null;
}

export function decorate(state: RuntimeBag, patch: Partial<DemoSnapshot> = {}) {
  const servers = patch.servers ?? state.servers;
  const tunnels = patch.tunnels ?? state.tunnels;
  const dns = patch.dns ?? state.dns;
  const settings = patch.settings ?? state.settings;
  const nodes = decorateNodes(patch.nodes ?? state.nodes, servers, tunnels, dns, settings);
  return { ...patch, servers, tunnels, dns, settings, nodes };
}

export function auditOf(state: RuntimeBag, action: string, target: string, detail: string): AuditEvent {
  const user = actorOf(state);
  return {
    id: uid("au"),
    at: new Date().toISOString(),
    actor: user.name,
    role: user.role,
    action,
    target,
    detail,
    simulated: true,
  };
}

export function incidentBundle(
  state: RuntimeBag,
  input: Omit<Incident, "id" | "timeline" | "updatedAt" | "openedAt">,
): Pick<DemoSnapshot, "incidents" | "alerts"> {
  const openedAt = new Date().toISOString();
  const incident: Incident = {
    ...input,
    id: uid("inc"),
    openedAt,
    updatedAt: openedAt,
    timeline: [{ at: openedAt, text: input.summary }],
  };
  const alert: Alert = {
    id: uid("al"),
    incidentId: incident.id,
    title: input.title,
    severity: input.severity,
    category: input.category,
    nodeId: input.nodeId,
    serverId: input.serverId,
    tunnelId: input.tunnelId,
    createdAt: openedAt,
    acked: false,
    resolved: input.status === "resolved",
    detail: input.summary,
  };
  return {
    incidents: [incident, ...state.incidents].slice(0, 80),
    alerts: [alert, ...state.alerts].slice(0, 120),
  };
}

export function activeId(node: DemoSnapshot["nodes"][number]) {
  return activeServerId(node);
}

export type ScenarioName = FailoverScenario | "manual" | "rollback";
