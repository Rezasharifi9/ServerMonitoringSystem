import { t } from "@/i18n/runtime";
import { uid } from "@/lib/utils";
import type { FailoverRun } from "@/types";
import {
  activeId,
  auditOf,
  decorate,
  guardOf,
  incidentBundle,
  type RuntimeBag,
  type ScenarioName,
  type WorkflowRuntime,
} from "@/stores/runtime";

type Api = {
  get: () => RuntimeBag;
  set: (partial: Partial<RuntimeBag>) => void;
};

export function launchFailover(api: Api, nodeId: string, scenario: ScenarioName, runtime: WorkflowRuntime) {
  const state = api.get();
  const denied = guardOf(state, "failover.run");
  if (denied) return denied;
  if (state.failoverRun?.running) return t("settings.errors.failoverBusy");
  const node = state.nodes.find((item) => item.id === nodeId);
  const policy = state.policies.find((item) => item.nodeId === nodeId);
  if (!node || !policy) return t("settings.errors.nodeNotFound");
  if (scenario !== "rollback" && node.lastFailoverAt) {
    const remain = policy.cooldownSec * 1000 - (Date.now() - new Date(node.lastFailoverAt).getTime());
    if (remain > 0) return t("settings.errors.cooldown", { seconds: Math.ceil(remain / 1000) });
  }

  const token = ++runtime.failoverToken;
  const sleep = async (ms: number) => {
    await runtime.clock.pause(ms);
    return token === runtime.failoverToken;
  };
  const backup = state.servers.find((server) => server.id === node.backupServerId);
  const primary = state.servers.find((server) => server.id === node.primaryServerId);
  const foreign = state.servers.find((server) => server.id === node.foreignServerId);
  const backupTunnel = state.tunnels.find((tunnel) => tunnel.id === node.backupTunnelId);
  const backupReady = Boolean(backup && backup.status !== "offline" && backup.agent.status !== "offline" && backupTunnel && backupTunnel.status !== "offline");

  api.set({
    failoverRun: {
      id: uid("run"),
      nodeId,
      scenario,
      state: "HEALTHY",
      running: true,
      startedAt: new Date().toISOString(),
      log: [{ at: new Date().toISOString(), message: t("settings.failoverRun.started") }],
    },
  });

  const apply = (message: string, failoverState: FailoverRun["state"], patch?: Partial<RuntimeBag>) => {
    if (token !== runtime.failoverToken) return;
    const current = api.get();
    const merged = decorate(current, {
      ...patch,
      nodes: (patch?.nodes ?? current.nodes).map((item) => (item.id === nodeId ? { ...item, failoverState } : item)),
    });
    api.set({
      ...merged,
      failoverRun: current.failoverRun
        ? { ...current.failoverRun, state: failoverState, log: [...current.failoverRun.log, { at: new Date().toISOString(), message }] }
        : current.failoverRun,
    });
  };

  const finish = (ok: boolean, summary: string, failoverState: FailoverRun["state"]) => {
    if (token !== runtime.failoverToken) return;
    const current = api.get();
    const finalNode = current.nodes.find((item) => item.id === nodeId) ?? node;
    const incidents = incidentBundle(current, {
      title: ok ? t("settings.failoverRun.titleOk", { id: nodeId }) : t("settings.failoverRun.titleFail", { id: nodeId }),
      severity: ok ? "info" : "critical",
      status: "open",
      category: "failover",
      nodeId,
      serverId: activeId(node),
      summary,
    });
    const decorated = decorate(current, {
      ...incidents,
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, failoverState, lastFailoverAt: new Date().toISOString() } : item,
      ),
    });
    api.set({
      ...decorated,
      failoverRun: current.failoverRun ? { ...current.failoverRun, running: false, state: failoverState, error: ok ? undefined : summary } : null,
      failoverEvents: [
        {
          id: uid("fe"),
          nodeId,
          at: new Date().toISOString(),
          scenario,
          fromServerId: activeId(node),
          toServerId: activeId(finalNode),
          result: !ok ? "failed" : scenario === "rollback" ? "rolled-back" : "success",
          state: failoverState,
          summary,
        },
        ...current.failoverEvents,
      ],
      audit: [auditOf(current, "failover.finish", t("settings.audit.node", { id: nodeId }), summary), ...current.audit],
    });
  };

  runtime.clock.track((async () => {
    if (!(await sleep(700))) return;
    if (scenario === "rollback") {
      const current = api.get();
      const live = current.nodes.find((item) => item.id === nodeId) ?? node;
      const primaryServer = current.servers.find((server) => server.id === live.primaryServerId);
      const primaryTunnel = current.tunnels.find((tunnel) => tunnel.id === live.primaryTunnelId);
      apply(t("settings.failoverRun.rollbackCheck"), "ROLLBACK");
      if (!(await sleep(800))) return;
      if (!primaryServer || primaryServer.status === "offline" || !primaryTunnel || primaryTunnel.status === "offline") {
        apply(t("settings.failoverRun.primaryStillOffline"), "FAILED");
        finish(false, t("settings.failoverRun.rollbackBlocked"), "FAILED");
        return;
      }
      apply(t("settings.failoverRun.rollbackDns"), "VERIFYING", {
        nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, activeSide: "primary" } : item)),
        dns: current.dns.map((record) =>
          record.nodeId === nodeId
            ? { ...record, aRecords: [primaryServer.publicIpv4], aaaaRecords: primaryServer.publicIpv6 ? [primaryServer.publicIpv6] : [], cname: undefined, proxied: false, authoritativeStatus: "matched", resolverStatus: "propagation", note: t("settings.failoverRun.rollbackDnsNote") }
            : record,
        ),
      });
      if (!(await sleep(800))) return;
      apply(t("settings.failoverRun.primaryConfirmed"), "HEALTHY", {
        dns: api.get().dns.map((record) => (record.nodeId === nodeId ? { ...record, resolverStatus: "matched" } : record)),
      });
      finish(true, t("settings.failoverRun.rollbackDone"), "HEALTHY");
      return;
    }

    if (scenario === "v2bx-failure") {
      apply(t("settings.failoverRun.v2bxStopped"), "SUSPECT", {
        servers: state.servers.map((server) =>
          server.id === foreign?.id
            ? { ...server, services: server.services.map((service) => (service.name === "v2bx" ? { ...service, status: "stopped" } : service)) }
            : server,
        ),
      });
      if (!(await sleep(800))) return;
      apply(t("settings.failoverRun.e2eFailed"), "CONFIRMED_DOWN");
      if (!(await sleep(800))) return;
      apply(t("settings.failoverRun.standbySameForeign"), "FAILED");
      finish(false, t("settings.failoverRun.v2bxNotSolved"), "FAILED");
      return;
    }

    if (scenario === "dns-mismatch") {
      apply(t("settings.failoverRun.aRecordMismatch"), "SUSPECT", {
        dns: state.dns.map((record) =>
          record.nodeId === nodeId ? { ...record, aRecords: ["203.0.113.99"], authoritativeStatus: "mismatched", resolverStatus: "mismatched", note: t("settings.failoverRun.mismatchInjected") } : record,
        ),
      });
      if (!(await sleep(800))) return;
      apply(t("settings.failoverRun.pathHealthyDnsOnly"), "SWITCHING");
      if (!(await sleep(800))) return;
      const active = state.servers.find((server) => server.id === activeId(node));
      apply(t("settings.failoverRun.authoritativeFixed"), "VERIFYING", {
        dns: api.get().dns.map((record) =>
          record.nodeId === nodeId
            ? { ...record, aRecords: active ? [active.publicIpv4] : record.aRecords, authoritativeStatus: "matched", resolverStatus: "propagation", note: t("settings.failoverRun.dnsFixNote") }
            : record,
        ),
      });
      if (!(await sleep(800))) return;
      apply(t("settings.failoverRun.resolverSynced"), "RECOVERED", {
        dns: api.get().dns.map((record) => (record.nodeId === nodeId ? { ...record, resolverStatus: "matched" } : record)),
      });
      finish(true, t("settings.failoverRun.dnsMismatchFixed"), "RECOVERED");
      return;
    }

    if (scenario === "backup-unavailable" || (scenario === "manual" && !backupReady)) {
      apply(t("settings.failoverRun.pathProbed"), "SUSPECT");
      if (!(await sleep(700))) return;
      apply(t("settings.failoverRun.failureThreshold"), "CONFIRMED_DOWN");
      if (!(await sleep(700))) return;
      apply(backupReady ? t("settings.failoverRun.standbyRejected") : t("settings.failoverRun.standbyNotReady"), "PREPARING_BACKUP");
      if (!(await sleep(600))) return;
      apply(t("settings.failoverRun.switchSkipped"), "FAILED");
      finish(false, t("settings.failoverRun.standbyStopped"), "FAILED");
      return;
    }

    if (scenario === "tunnel-failure") {
      apply(t("settings.failoverRun.primaryTunnelDown"), "SUSPECT", {
        tunnels: state.tunnels.map((tunnel) =>
          tunnel.id === node.primaryTunnelId ? { ...tunnel, status: "offline", packetLoss: 100, rxMbps: 0, txMbps: 0, rttMs: 0 } : tunnel,
        ),
      });
      if (!(await sleep(800))) return;
      apply(t("settings.failoverRun.tunnelOutageConfirmed"), "CONFIRMED_DOWN");
    } else if (scenario === "primary-failure" || scenario === "auto-recovery") {
      apply(t("settings.failoverRun.primaryProbesFailing"), "SUSPECT");
      if (!(await sleep(800))) return;
      if (primary) runtime.savedHosts.set(primary.id, { status: primary.status, cpu: primary.cpu, ram: primary.ram, rxMbps: primary.rxMbps, txMbps: primary.txMbps });
      apply(t("settings.failoverRun.primaryOffline"), "CONFIRMED_DOWN", {
        servers: state.servers.map((server) =>
          server.id === primary?.id ? { ...server, status: "offline", cpu: 0, rxMbps: 0, txMbps: 0, agent: { ...server.agent, status: "offline" } } : server,
        ),
      });
    } else {
      apply(t("settings.failoverRun.moveStarted"), "SUSPECT");
      if (!(await sleep(600))) return;
      apply(t("settings.failoverRun.policyThreshold"), "CONFIRMED_DOWN");
    }

    if (!(await sleep(800))) return;
    if (!backupReady) {
      apply(t("settings.failoverRun.standbyPathDown"), "FAILED");
      finish(false, t("settings.failoverRun.standbyUnconfirmed"), "FAILED");
      return;
    }
    apply(t("settings.failoverRun.standbyCapacityOk"), "PREPARING_BACKUP");
    if (!(await sleep(800))) return;
    const latest = api.get();
    apply(t("settings.failoverRun.dnsSwitched"), "SWITCHING", {
      nodes: latest.nodes.map((item) => (item.id === nodeId ? { ...item, activeSide: "backup" } : item)),
      dns: latest.dns.map((record) =>
        record.nodeId === nodeId
          ? {
              ...record,
              aRecords: backup ? [backup.publicIpv4] : record.aRecords,
              aaaaRecords: backup?.publicIpv6 ? [backup.publicIpv6] : [],
              authoritativeStatus: "matched",
              resolverStatus: "propagation",
              cname: undefined,
              proxied: false,
              note: t("settings.failoverRun.dnsSwitchNote"),
            }
          : record,
      ),
    });
    if (!(await sleep(900))) return;
    if (scenario === "validation-failed") {
      const now = api.get();
      apply(t("settings.failoverRun.validationRollback"), "ROLLBACK", {
        nodes: now.nodes.map((item) => (item.id === nodeId ? { ...item, activeSide: node.activeSide } : item)),
        dns: now.dns.map((record) =>
          record.nodeId === nodeId
            ? state.dns.find((original) => original.id === record.id) ?? record
            : record,
        ),
      });
      if (!(await sleep(700))) return;
      finish(false, t("settings.failoverRun.validationReverted"), "FAILED");
      return;
    }
    apply(t("settings.failoverRun.backupPathVerified"), "VERIFYING", {
      dns: api.get().dns.map((record) => (record.nodeId === nodeId ? { ...record, resolverStatus: "matched" } : record)),
    });
    if (!(await sleep(800))) return;

    if (scenario === "auto-recovery") {
      apply(t("settings.failoverRun.backupStable"), "RECOVERED");
      if (!(await sleep(900))) return;
      const saved = primary ? runtime.savedHosts.get(primary.id) : undefined;
      apply(t("settings.failoverRun.primaryReportedHealthy"), "ROLLBACK", {
        servers: api.get().servers.map((server) =>
          server.id === primary?.id
            ? {
                ...server,
                status: "healthy",
                cpu: saved?.cpu || 32,
                ram: saved?.ram || 48,
                rxMbps: saved?.rxMbps || 200,
                txMbps: saved?.txMbps || 180,
                agent: { ...server.agent, status: "online", lastHeartbeat: new Date().toISOString() },
              }
            : server,
        ),
      });
      if (!(await sleep(800))) return;
      const now = api.get();
      apply(t("settings.failoverRun.autoFailback"), "VERIFYING", {
        nodes: now.nodes.map((item) => (item.id === nodeId ? { ...item, activeSide: "primary" } : item)),
        dns: now.dns.map((record) =>
          record.nodeId === nodeId && primary
            ? { ...record, aRecords: [primary.publicIpv4], aaaaRecords: primary.publicIpv6 ? [primary.publicIpv6] : [], resolverStatus: "propagation", note: t("settings.failoverRun.failbackNote") }
            : record,
        ),
      });
      if (!(await sleep(700))) return;
      apply(t("settings.failoverRun.primaryServiceStable"), "HEALTHY", {
        dns: api.get().dns.map((record) => (record.nodeId === nodeId ? { ...record, resolverStatus: "matched" } : record)),
      });
      finish(true, t("settings.failoverRun.autoRecoveryDone"), "HEALTHY");
      return;
    }

    apply(t("settings.failoverRun.demoComplete"), "RECOVERED");
    finish(true, t("settings.failoverRun.trafficMoved"), "RECOVERED");
  })());

  return null;
}
