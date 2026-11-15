import { t } from "@/i18n/runtime";
import type { StateCreator } from "zustand/vanilla";
import { buildSeed, craftLog } from "@/data/seed";
import { launchFailover } from "@/stores/failover";
import {
  auditOf,
  decorate,
  guardOf,
  createWorkflowRuntime,
  type WorkflowClock,
  type RuntimeBag,
} from "@/stores/runtime";
import { uid } from "@/lib/utils";
import type {
  DeploymentJob,
  FailoverPolicy,
  NodeSettings,
  SpeedtestConfig,
  SpeedtestResult,
  SpeedtestRun,
  TimeRange,
  Tunnel,
} from "@/types";

export interface InfraState extends RuntimeBag {
  hydrated: boolean;
  range: TimeRange;
  speedtestRun: SpeedtestRun | null;
  liveLogs: boolean;
  setHydrated: () => void;
  setRange: (range: TimeRange) => void;
  switchUser: (userId: string) => void;
  resetDemo: () => void;
  updateSettings: (patch: Partial<InfraState["settings"]>) => string | null;
  applyFailoverDefaults: () => string | null;
  updatePolicy: (nodeId: string, patch: Partial<FailoverPolicy>) => string | null;
  updateNodeSettings: (nodeId: string, patch: Partial<NodeSettings> & { name?: string; domain?: string; port?: number }) => string | null;
  refreshMetrics: () => void;
  restartService: (serverId: string, serviceName: string) => Promise<string | null>;
  updateServerNotes: (serverId: string, notes: string) => string | null;
  tunnelAction: (tunnelId: string, action: "start" | "stop" | "restart") => Promise<string | null>;
  deleteTunnel: (tunnelId: string) => string | null;
  reconfigureTunnel: (tunnelId: string, mtu: number) => string | null;
  createTunnel: (input: { technology: Tunnel["technology"]; iranServerId: string; foreignServerId: string; mtu: number; port?: number; outcome: "success" | "fail" }) => Promise<string | null>;
  checkDns: (nodeId: string) => Promise<string | null>;
  simulateDnsSwitch: (nodeId: string, side: "primary" | "backup") => string | null;
  acknowledgeIncident: (incidentId: string) => string | null;
  resolveIncident: (incidentId: string) => string | null;
  assignIncident: (incidentId: string, assignee: string) => string | null;
  silenceAlert: (alertId: string, minutes: number) => string | null;
  archiveAlert: (alertId: string) => string | null;
  restoreAlert: (alertId: string) => string | null;
  testNotification: (channel: "telegram" | "email" | "webhook") => Promise<string | null>;
  testIntegration: (id: string) => Promise<string | null>;
  syncIntegration: (id: string) => Promise<string | null>;
  updateIntegration: (id: string, config: Record<string, string>) => string | null;
  startSpeedtest: (config: SpeedtestConfig) => string | null;
  stopSpeedtest: () => void;
  simulateFailover: (nodeId: string, scenario: Parameters<typeof launchFailover>[2]) => string | null;
  rollbackFailover: (nodeId: string) => string | null;
  createDeployment: (input: { serverId: string; component: string; options: Record<string, string>; outcome: DeploymentJob["outcome"] }) => string | null;
  rollbackDeployment: (jobId: string) => string | null;
  setLiveLogs: (enabled: boolean) => void;
}

export function createInfraWorkflows(seed = buildSeed(), clock?: WorkflowClock): StateCreator<InfraState> {
  const runtime = createWorkflowRuntime(clock);
  const { clock: timing } = runtime;
  let speedTimer: ReturnType<typeof timing.interval> | null = null;
  let logTimer: ReturnType<typeof timing.interval> | null = null;

  function clearTimers() {
    runtime.failoverToken += 1;
    runtime.savedHosts.clear();
    if (speedTimer !== null) timing.cancelInterval(speedTimer);
    if (logTimer !== null) timing.cancelInterval(logTimer);
    speedTimer = null;
    logTimer = null;
  }

  return (set, get) => ({
    ...seed,
    hydrated: false,
    currentUserId: seed.users[0].id,
    range: "1h",
    failoverRun: null,
    speedtestRun: null,
    liveLogs: false,
    setHydrated: () => set({ hydrated: true }),
    setRange: (range) => set({ range }),
    switchUser: (userId) => set({ currentUserId: userId }),
    resetDemo: () => {
      clearTimers();
      const fresh = buildSeed();
      set({
        ...fresh,
        hydrated: true,
        currentUserId: get().currentUserId,
        range: "1h",
        failoverRun: null,
        speedtestRun: null,
        liveLogs: false,
      });
    },
    updateSettings: (patch) => {
      const state = get();
      const denied = guardOf(state, "settings.edit");
      if (denied) return denied;
      const settings = {
        ...state.settings,
        ...patch,
        thresholds: { ...state.settings.thresholds, ...patch.thresholds },
        notifications: { ...state.settings.notifications, ...patch.notifications },
        failover: { ...state.settings.failover, ...patch.failover },
      };
      const fields = Object.keys(patch).slice(0, 8).join(", ");
      set({
        ...decorate(state, { settings }),
        audit: [auditOf(state, "settings.update", "settings", fields ? `تنظیمات سامانه ذخیره شد (${fields}).` : "تنظیمات سامانه ذخیره شد."), ...state.audit],
      });
      return null;
    },
    applyFailoverDefaults: () => {
      const state = get();
      const denied = guardOf(state, "failover.configure");
      if (denied) return denied;
      set({
        policies: state.policies.map((policy) => ({ ...policy, ...state.settings.failover, nodeId: policy.nodeId })),
        audit: [auditOf(state, "failover.defaults", t("settings.audit.allNodes"), t("settings.audit.failoverDefaults")), ...state.audit],
      });
      return null;
    },
    updatePolicy: (nodeId, patch) => {
      const state = get();
      const denied = guardOf(state, "failover.configure");
      if (denied) return denied;
      set({
        policies: state.policies.map((policy) => (policy.nodeId === nodeId ? { ...policy, ...patch } : policy)),
        audit: [auditOf(state, "failover.policy", t("settings.audit.node", { id: nodeId }), t("settings.audit.failoverPolicy")), ...state.audit],
      });
      return null;
    },
    updateNodeSettings: (nodeId, patch) => {
      const state = get();
      const denied = guardOf(state, "node.edit");
      if (denied) return denied;
      set(
        decorate(state, {
          nodes: state.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  name: patch.name ?? node.name,
                  domain: patch.domain ?? node.domain,
                  port: patch.port ?? node.port,
                  settings: { ...node.settings, ...patch },
                }
              : node,
          ),
          dns: state.dns.map((record) =>
            record.nodeId === nodeId ? { ...record, domain: patch.domain ?? record.domain, v2boardHost: patch.domain ?? record.v2boardHost } : record,
          ),
          audit: [auditOf(state, "node.update", nodeId, t("settings.audit.nodeSettings")), ...state.audit],
        }),
      );
      return null;
    },
    refreshMetrics: () => {
      const state = get();
      set(
        decorate(state, {
          servers: state.servers.map((server) =>
            server.status === "offline"
              ? server
              : {
                  ...server,
                  cpu: Math.min(99, Math.max(4, server.cpu + (Math.random() * 6 - 3))),
                  ram: Math.min(99, Math.max(8, server.ram + (Math.random() * 4 - 2))),
                  rxMbps: Math.max(0, server.rxMbps + (Math.random() * 20 - 10)),
                  txMbps: Math.max(0, server.txMbps + (Math.random() * 18 - 9)),
                  agent: { ...server.agent, lastHeartbeat: new Date().toISOString() },
                },
          ),
          tunnels: state.tunnels.map((tunnel) =>
            tunnel.status === "offline"
              ? { ...tunnel, lastCheck: new Date().toISOString() }
              : {
                  ...tunnel,
                  rttMs: Math.max(8, tunnel.rttMs + (Math.random() * 4 - 2)),
                  packetLoss: Math.max(0, Number((tunnel.packetLoss + (Math.random() * 0.2 - 0.1)).toFixed(2))),
                  lastCheck: new Date().toISOString(),
                },
          ),
        }),
      );
    },
    restartService: async (serverId, serviceName) => {
      const state = get();
      const denied = guardOf(state, "server.restart");
      if (denied) return denied;
      set({
        servers: state.servers.map((server) =>
          server.id === serverId
            ? { ...server, services: server.services.map((service) => (service.name === serviceName ? { ...service, status: "restarting" } : service)) }
            : server,
        ),
      });
      await timing.pause(900);
      const next = get();
      set(
        decorate(next, {
          servers: next.servers.map((server) =>
            server.id === serverId
              ? {
                  ...server,
                  status: serviceName === "nodeguard-agent" && server.status === "offline" ? "healthy" : server.status === "offline" ? "healthy" : server.status,
                  cpu: server.cpu || 28,
                  ram: server.ram || 40,
                  rxMbps: server.rxMbps || 80,
                  txMbps: server.txMbps || 70,
                  services: server.services.map((service) => (service.name === serviceName ? { ...service, status: "running" } : service)),
                  agent: { ...server.agent, status: "online", lastHeartbeat: new Date().toISOString() },
                }
              : server,
          ),
          audit: [auditOf(next, "service.restart", `${serverId}/${serviceName}`, t("settings.audit.restartSimulated")), ...next.audit],
        }),
      );
      return null;
    },
    updateServerNotes: (serverId, notes) => {
      const state = get();
      const denied = guardOf(state, "server.configure");
      if (denied) return denied;
      set({
        servers: state.servers.map((server) => (server.id === serverId ? { ...server, notes } : server)),
        audit: [auditOf(state, "server.notes", serverId, t("settings.audit.notesSaved")), ...state.audit],
      });
      return null;
    },
    tunnelAction: async (tunnelId, action) => {
      const state = get();
      const denied = guardOf(state, "tunnel.mutate");
      if (denied) return denied;
      const applyStatus = (status: Tunnel["status"]) =>
        decorate(get(), {
          tunnels: get().tunnels.map((tunnel) =>
            tunnel.id === tunnelId
              ? {
                  ...tunnel,
                  status,
                  packetLoss: status === "offline" ? 100 : 0.2,
                  rxMbps: status === "offline" ? 0 : tunnel.rxMbps || 120,
                  txMbps: status === "offline" ? 0 : tunnel.txMbps || 110,
                  rttMs: status === "offline" ? 0 : tunnel.rttMs || 40,
                  lastCheck: new Date().toISOString(),
                }
              : tunnel,
          ),
        });
      set(applyStatus(action === "stop" ? "offline" : "degraded"));
      if (action !== "stop") {
        await timing.pause(700);
        set(applyStatus("healthy"));
      }
      const next = get();
      set({ audit: [auditOf(next, `tunnel.${action}`, tunnelId, t("settings.audit.tunnelSimulated")), ...next.audit] });
      return null;
    },
    deleteTunnel: (tunnelId) => {
      const state = get();
      const denied = guardOf(state, "tunnel.delete");
      if (denied) return denied;
      const removed = new Set<string>();
      const nodes = state.nodes.flatMap((node) => {
        const primary = node.primaryTunnelId === tunnelId;
        const backup = node.backupTunnelId === tunnelId;
        if (!primary && !backup) return [node];
        if (backup && !primary) {
          return [{ ...node, backupTunnelId: undefined, backupServerId: undefined, activeSide: node.activeSide === "backup" ? "primary" as const : node.activeSide }];
        }
        if (node.backupTunnelId && node.backupServerId && node.backupTunnelId !== tunnelId) {
          return [{
            ...node, primaryTunnelId: node.backupTunnelId, primaryServerId: node.backupServerId,
            backupTunnelId: undefined, backupServerId: undefined, activeSide: "primary" as const,
          }];
        }
        removed.add(node.id);
        return [];
      });
      set(decorate(state, {
        nodes,
        tunnels: state.tunnels.filter((tunnel) => tunnel.id !== tunnelId).map((tunnel) => ({
          ...tunnel, nodeIds: tunnel.nodeIds.filter((id) => !removed.has(id)),
        })),
        dns: state.dns.filter((item) => !removed.has(item.nodeId)),
        policies: state.policies.filter((item) => !removed.has(item.nodeId)),
        audit: [auditOf(state, "tunnel.delete", tunnelId, t("settings.audit.tunnelDeleted")), ...state.audit],
      }));
      return null;
    },
    reconfigureTunnel: (tunnelId, mtu) => {
      const state = get();
      const denied = guardOf(state, "tunnel.mutate");
      if (denied) return denied;
      set({
        tunnels: state.tunnels.map((tunnel) => (tunnel.id === tunnelId ? { ...tunnel, mtu, config: { ...tunnel.config, mtu: String(mtu) } } : tunnel)),
        audit: [auditOf(state, "tunnel.reconfigure", tunnelId, t("settings.audit.mtu", { mtu })), ...state.audit],
      });
      return null;
    },
    createTunnel: async ({ technology, iranServerId, foreignServerId, mtu, port, outcome }) => {
      const state = get();
      const denied = guardOf(state, "tunnel.create");
      if (denied) return denied;
      await timing.pause(700);
      if (outcome === "fail") return t("settings.errors.tunnelPreflight");
      const iran = state.servers.find((server) => server.id === iranServerId);
      const foreign = state.servers.find((server) => server.id === foreignServerId);
      if (!iran || !foreign) return t("settings.errors.serverNotFound");
      const id = uid("tn");
      const kind = technology === "GOST" || technology === "Backhaul" || technology === "Rathole" ? "forwarder" : "interface";
      const tunnel: Tunnel = {
        id,
        name: `${technology} ${iran.name} → ${foreign.name}`,
        technology,
        kind,
        side: "primary",
        iranEndpoint: { serverId: iran.id, publicIp: iran.publicIpv4, tunnelIp: kind === "interface" ? "10.91.1.1" : undefined, port, interfaceName: kind === "interface" ? "tun-new" : undefined },
        foreignEndpoint: { serverId: foreign.id, publicIp: foreign.publicIpv4, tunnelIp: kind === "interface" ? "10.91.1.2" : undefined, port: port ? port + 1 : undefined },
        interfaceName: kind === "interface" ? "tun-new" : undefined,
        serviceName: kind === "forwarder" ? `${technology.toLowerCase()}-new.service` : undefined,
        status: "healthy",
        rttMs: 42,
        jitterMs: 3,
        packetLoss: 0.2,
        mtu,
        rxMbps: 24,
        txMbps: 20,
        lastCheck: new Date().toISOString(),
        uptimePct: 100,
        nodeIds: [],
        config: { technology, mtu: String(mtu), note: t("settings.workflows.tunnelNote") },
      };
      const next = get();
      set({ tunnels: [tunnel, ...next.tunnels], audit: [auditOf(next, "tunnel.create", id, t("settings.audit.tunnelCreated")), ...next.audit] });
      return null;
    },
    checkDns: async (nodeId) => {
      const state = get();
      const denied = guardOf(state, "dns.check");
      if (denied) return denied;
      await timing.pause(500);
      const next = get();
      set({
        dns: next.dns.map((record) => (record.nodeId === nodeId ? { ...record, lastCheck: new Date().toISOString() } : record)),
        audit: [auditOf(next, "dns.check", t("settings.audit.node", { id: nodeId }), t("settings.audit.dnsChecked")), ...next.audit],
      });
      return null;
    },
    simulateDnsSwitch: (nodeId, side) => {
      const state = get();
      const denied = guardOf(state, "dns.switch");
      if (denied) return denied;
      const node = state.nodes.find((item) => item.id === nodeId);
      const server = state.servers.find((item) => item.id === (side === "primary" ? node?.primaryServerId : node?.backupServerId));
      if (!node || !server) return t("settings.errors.dnsTarget");
      set(
        decorate(state, {
          dns: state.dns.map((record) =>
            record.nodeId === nodeId
              ? {
                  ...record,
                  aRecords: [server.publicIpv4],
                  aaaaRecords: server.publicIpv6 ? [server.publicIpv6] : [],
                  cname: undefined,
                  proxied: false,
                  authoritativeStatus: "matched",
                  resolverStatus: "propagation",
                  lastCheck: new Date().toISOString(),
                  note: t("settings.workflows.dnsNote", { ip: server.publicIpv4, ttl: record.ttl }),
                }
              : record,
          ),
          audit: [auditOf(state, "dns.switch", node.domain, t("settings.audit.dnsSwitch", { name: server.name })), ...state.audit],
        }),
      );
      return null;
    },
    acknowledgeIncident: (incidentId) => {
      const state = get();
      const denied = guardOf(state, "alert.manage");
      if (denied) return denied;
      const now = new Date().toISOString();
      set({
        incidents: state.incidents.map((incident) =>
          incident.id === incidentId
            ? { ...incident, status: "ack", assignee: incident.assignee ?? actorName(state), updatedAt: now, timeline: [...incident.timeline, { at: now, text: t("alerts.incident.acked") }] }
            : incident,
        ),
        alerts: state.alerts.map((alert) => (alert.incidentId === incidentId ? { ...alert, acked: true } : alert)),
        audit: [auditOf(state, "incident.ack", incidentId, t("settings.audit.incidentAck")), ...state.audit],
      });
      return null;
    },
    resolveIncident: (incidentId) => {
      const state = get();
      const denied = guardOf(state, "alert.manage");
      if (denied) return denied;
      const now = new Date().toISOString();
      set({
        incidents: state.incidents.map((incident) =>
          incident.id === incidentId ? { ...incident, status: "resolved", resolvedAt: now, updatedAt: now, timeline: [...incident.timeline, { at: now, text: t("alerts.incident.resolved") }] } : incident,
        ),
        alerts: state.alerts.map((alert) => (alert.incidentId === incidentId ? { ...alert, acked: true, resolved: true } : alert)),
        audit: [auditOf(state, "incident.resolve", incidentId, t("settings.audit.incidentResolve")), ...state.audit],
      });
      return null;
    },
    assignIncident: (incidentId, assignee) => {
      const state = get();
      const denied = guardOf(state, "alert.manage");
      if (denied) return denied;
      const now = new Date().toISOString();
      set({
        incidents: state.incidents.map((incident) =>
          incident.id === incidentId ? { ...incident, assignee, updatedAt: now, timeline: [...incident.timeline, { at: now, text: t("alerts.incident.assigned", { name: assignee }) }] } : incident,
        ),
        audit: [auditOf(state, "incident.assign", incidentId, assignee), ...state.audit],
      });
      return null;
    },
    silenceAlert: (alertId, minutes) => {
      const state = get();
      const denied = guardOf(state, "alert.manage");
      if (denied) return denied;
      const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      set({
        alerts: state.alerts.map((alert) => (alert.id === alertId ? { ...alert, silencedUntil: until } : alert)),
        audit: [auditOf(state, "alert.silence", alertId, t("settings.audit.silenceMinutes", { minutes })), ...state.audit],
      });
      return null;
    },
    archiveAlert: (alertId) => {
      const state = get();
      const denied = guardOf(state, "alert.manage");
      if (denied) return denied;
      const current = state.alerts.find((alert) => alert.id === alertId);
      if (!current) return t("alerts.missing");
      if (current.archived) return null;
      const now = new Date().toISOString();
      set({
        alerts: state.alerts.map((alert) => (alert.id === alertId ? { ...alert, archived: true, archivedAt: now } : alert)),
        audit: [auditOf(state, "alert.archive", alertId, t("settings.audit.alertArchived")), ...state.audit],
      });
      return null;
    },
    restoreAlert: (alertId) => {
      const state = get();
      const denied = guardOf(state, "alert.manage");
      if (denied) return denied;
      const current = state.alerts.find((alert) => alert.id === alertId);
      if (!current) return t("alerts.missing");
      if (!current.archived) return null;
      set({
        alerts: state.alerts.map((alert) => (alert.id === alertId ? { ...alert, archived: false, archivedAt: undefined } : alert)),
        audit: [auditOf(state, "alert.restore", alertId, t("settings.audit.alertRestored")), ...state.audit],
      });
      return null;
    },
    testNotification: async (channel) => {
      const state = get();
      const denied = guardOf(state, "settings.edit");
      if (denied) return denied;
      await timing.pause(650);
      const next = get();
      set({ audit: [auditOf(next, "notify.test", channel, t("settings.audit.notifyNotSent")), ...next.audit] });
      return null;
    },
    testIntegration: async (id) => {
      const state = get();
      const denied = guardOf(state, "integration.edit");
      if (denied) return denied;
      await timing.pause(800);
      const next = get();
      set({
        integrations: next.integrations.map((item) =>
          item.id === id ? { ...item, status: "connected", lastTest: new Date().toISOString(), message: t("integrations.sampleConnected") } : item,
        ),
        audit: [auditOf(next, "integration.test", id, t("settings.audit.integrationTest")), ...next.audit],
      });
      return null;
    },
    syncIntegration: async (id) => {
      const state = get();
      const denied = guardOf(state, "integration.edit");
      if (denied) return denied;
      await timing.pause(900);
      const next = get();
      set({
        integrations: next.integrations.map((item) =>
          item.id === id
            ? {
                ...item,
                status: item.type === "agent" && next.servers.some((server) => server.agent.status === "offline") ? "degraded" : "connected",
                lastSync: new Date().toISOString(),
                message: item.type === "v2board" ? t("integrations.sampleSyncNodes", { count: next.nodes.length }) : t("integrations.sampleSyncDone"),
                config: item.type === "v2board" ? { ...item.config, imported: String(next.nodes.length) } : item.config,
              }
            : item,
        ),
        audit: [auditOf(next, "integration.sync", id, t("settings.audit.integrationSync")), ...next.audit],
      });
      return null;
    },
    updateIntegration: (id, config) => {
      const state = get();
      const denied = guardOf(state, "integration.edit");
      if (denied) return denied;
      set({
        integrations: state.integrations.map((item) => (item.id === id ? { ...item, config: { ...item.config, ...config } } : item)),
        audit: [auditOf(state, "integration.update", id, t("settings.audit.integrationSaved")), ...state.audit],
      });
      return null;
    },
    startSpeedtest: (config) => {
      const state = get();
      const denied = guardOf(state, "speedtest.run");
      if (denied) return denied;
      if (state.speedtestRun?.running) return t("speedtest.errors.busy");
      if (speedTimer) timing.cancelInterval(speedTimer);
      const tunnel = state.tunnels.find((item) => item.id === config.tunnelId);
      const base = config.mode === "internet" ? 460 : tunnel?.technology === "WireGuard" || tunnel?.technology === "GRE" ? 820 : 340;
      const cap = config.bandwidthLimitMbps && config.bandwidthLimitMbps > 0 ? Math.min(base, config.bandwidthLimitMbps) : base;
      set({
        speedtestRun: {
          config,
          running: true,
          startedAt: new Date().toISOString(),
          elapsedSec: 0,
          samples: [],
          currentMbps: 0,
          rttMs: tunnel?.rttMs || 22,
          lossPct: config.protocol === "udp" ? 0.6 : 0.05,
          jitterMs: config.protocol === "udp" ? 3.4 : 1.1,
        },
      });
      speedTimer = timing.interval(() => {
        const run = get().speedtestRun;
        if (!run?.running) return;
        const elapsed = Math.round((run.elapsedSec + 0.5) * 10) / 10;
        const speed = cap * (0.9 + Math.sin(elapsed) * 0.08 + (Math.random() - 0.5) * 0.04);
      const current = Math.min(cap, Math.max(0, speed));
        const samples = [...run.samples, { t: elapsed, mbps: Number(current.toFixed(1)) }];
        if (elapsed >= config.durationSec) {
          if (speedTimer) timing.cancelInterval(speedTimer);
          speedTimer = null;
          const values = samples.map((sample) => sample.mbps);
          const result: SpeedtestResult = {
            id: uid("st"),
            createdAt: new Date().toISOString(),
            ...config,
            avgMbps: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)),
            maxMbps: Math.max(...values),
            minMbps: Math.min(...values),
            rttMs: run.rttMs,
            jitterMs: run.jitterMs,
            lossPct: run.lossPct,
            samples,
            status: "completed",
          };
          const next = get();
          set({
            speedtestRun: { ...run, running: false, elapsedSec: elapsed, samples, currentMbps: current },
            speedtests: [result, ...next.speedtests].slice(0, 40),
            audit: [auditOf(next, "speedtest.finish", config.mode, t("settings.audit.speedtestDone")), ...next.audit],
          });
          return;
        }
        set({ speedtestRun: { ...run, elapsedSec: elapsed, samples, currentMbps: current } });
      }, 500);
      return null;
    },
    stopSpeedtest: () => {
      if (speedTimer) timing.cancelInterval(speedTimer);
      speedTimer = null;
      const run = get().speedtestRun;
      if (!run?.running) return;
      const values = run.samples.map((sample) => sample.mbps);
      const result: SpeedtestResult = {
        id: uid("st"),
        createdAt: new Date().toISOString(),
        ...run.config,
        avgMbps: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : 0,
        maxMbps: values.length ? Math.max(...values) : 0,
        minMbps: values.length ? Math.min(...values) : 0,
        rttMs: run.rttMs,
        jitterMs: run.jitterMs,
        lossPct: run.lossPct,
        samples: run.samples,
        status: "stopped",
      };
      set({ speedtestRun: { ...run, running: false }, speedtests: [result, ...get().speedtests] });
    },
    simulateFailover: (nodeId, scenario) => launchFailover({ get, set }, nodeId, scenario, runtime),
    rollbackFailover: (nodeId) => launchFailover({ get, set }, nodeId, "rollback", runtime),
    createDeployment: ({ serverId, component, options, outcome }) => {
      const state = get();
      const denied = guardOf(state, "deploy.run");
      if (denied) return denied;
      const server = state.servers.find((item) => item.id === serverId);
      if (!server) return t("settings.errors.serverMissing");
      const preflight = [
        { name: t("settings.workflows.osCheck"), ok: /Ubuntu|Debian/.test(server.os), detail: server.os },
        { name: t("settings.workflows.accessCheck"), ok: server.agent.status !== "offline", detail: server.agent.status === "offline" ? t("settings.workflows.agentOffline") : t("settings.workflows.accessAssumed") },
        { name: t("settings.workflows.portCheck"), ok: options.forceConflict !== "yes", detail: options.forceConflict === "yes" ? t("settings.workflows.portBusy") : t("settings.workflows.portFree") },
        { name: t("settings.workflows.serviceCheck"), ok: true, detail: t("settings.workflows.noConflict") },
        { name: t("settings.workflows.networkCheck"), ok: server.status !== "offline", detail: server.status === "offline" ? t("settings.workflows.hostOffline") : t("settings.workflows.pathResponds") },
        { name: t("settings.workflows.resourceCheck"), ok: server.cpu < 95 && server.ram < 95, detail: t("settings.workflows.resourceUsage", { cpu: Math.round(server.cpu), ram: Math.round(server.ram) }) },
        { name: t("settings.workflows.configCheck"), ok: true, detail: t("settings.workflows.configReadable") },
      ];
      const job: DeploymentJob = {
        id: uid("job"),
        createdAt: new Date().toISOString(),
        serverId,
        component,
        status: "pending",
        outcome,
        options,
        logs: [{ at: new Date().toISOString(), line: t("settings.workflows.jobCreated") }],
        preflight,
        configPreview: `# simulation only\ncomponent: ${component}\nhost: ${server.name}\n`,
      };
      set({ deployments: [job, ...state.deployments] });
      const blocked = preflight.some((check) => !check.ok);
      const phases: DeploymentJob["status"][] = blocked
        ? ["validating", "failed"]
        : outcome === "fail"
          ? ["validating", "installing", "failed"]
          : outcome === "rollback"
            ? ["validating", "installing", "configuring", "testing", "rolled-back"]
            : ["validating", "installing", "configuring", "testing", "completed"];
      phases.forEach((phase, index) => {
        timing.later(() => {
          const current = get();
          if (!current.deployments.some((item) => item.id === job.id)) return;
          const logs = [...(current.deployments.find((item) => item.id === job.id)?.logs ?? []), { at: new Date().toISOString(), line: t("settings.workflows.phase", { phase }) }];
          set({ deployments: current.deployments.map((item) => (item.id === job.id ? { ...item, status: phase, logs } : item)) });
          if (phase === "completed" || phase === "failed" || phase === "rolled-back") {
            const done = get();
            set({ audit: [auditOf(done, "deploy.finish", job.id, phase), ...done.audit] });
          }
        }, 650 * (index + 1));
      });
      return null;
    },
    rollbackDeployment: (jobId) => {
      const state = get();
      const denied = guardOf(state, "deploy.run");
      if (denied) return denied;
      set({
        deployments: state.deployments.map((job) =>
          job.id === jobId ? { ...job, status: "rolled-back", logs: [...job.logs, { at: new Date().toISOString(), line: t("settings.workflows.rolledBack") }] } : job,
        ),
        audit: [auditOf(state, "deploy.rollback", jobId, t("settings.audit.deployRollback")), ...state.audit],
      });
      return null;
    },
    setLiveLogs: (enabled) => {
      if (logTimer) timing.cancelInterval(logTimer);
      logTimer = null;
      set({ liveLogs: enabled });
      if (!enabled) return;
      logTimer = timing.interval(() => {
        const state = get();
        if (!state.liveLogs) return;
        set({ logs: [...state.logs, craftLog(state)].slice(-400) });
      }, Math.max(1200, get().settings.monitoringIntervalSec * 40));
    },
  });
}

function actorName(state: RuntimeBag) {
  return state.users.find((user) => user.id === state.currentUserId)?.name ?? t("common.roles.operator");
}
