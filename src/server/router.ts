import { virtualizorSettings, saveVirtualizorSettings, serverVirtualizor, bindVirtualizor, unbindVirtualizor, controlVirtualizor } from "./virtualizor";
import { z } from "zod";
import { serverActivities } from "./server-activity";
import { after } from "next/server";
import { drainAgentUpdates, listAgentUpdates, queueAgentUpdates } from "./agent-updates";
import { selectNodeRoutes, setTunnelDns } from "./node-routes";
import { serverV2bxNodes } from "./v2board-nodes";
import { assessNode, decorateNodes } from "@/lib/health";
import { buildMetrics } from "@/lib/metrics";
import { execute } from "./actions";
import { assertOrigin, authenticate, authorizeMonitorWorker, changeAdminPassword, login, logout } from "./auth";
import { handleAdminPasskeys } from "./admin-passkeys";
import { adminAccount, adminConfig } from "./admin-config";
import { database, transaction, readWorkspace, type Workspace } from "./database";
import { ApiError, json, jsonBody, requireSecureCredentialOrigin } from "./http";
import { authoritativeDnsEnabled, boardEnabled, connectPanelAdmin, importPanelNode, panelCatalog, panelOnlineSnapshot, panelSyncSettings, refreshAuthoritativeDns, refreshPanel, tickPanelSync } from "./providers";
import { projectSpeedtest, settleSpeedtest } from "./speedtest";
import { iranBandwidth, observedMetrics, observedSampleReport } from "./metrics";
import { observedAvailability } from "./availability";
import { availabilityPct } from "@/lib/availability";
import { workspaceMode } from "./inventory";
import { cancelIperf, claimIperf, enqueueIperf, finishIperf, iperfControl, iperfEnabled, listIperfJobs } from "./iperf-jobs";
import { dnsExecutionEnabled } from "./cloudflare-failover";
import { sendTelegramTest, saveTelegramConfig, telegramConfig, telegramHistory, tickTelegram } from "./telegram";
import { advanceTunnelDeployments, deleteServerInventory, deleteTunnelInventory, listTunnelDeployments, manageTunnelDeployment, startTunnelDeployment, finalizeTunnelActivations } from "./tunnel-deployments";
import { bbrStatus, claimProvision, dismissProvisionReview, finishProvision, listProvision, provisionEnabled, queueBbr, queueHostReboot, queueProvision, queueV2bxRemove, queueV2bxRestart, rebootStatus, reportProvisionProgress, v2bxRemoveStatus, v2bxRestartStatus } from "./provision";
import { importProvisionCatalog, previewProvisionCatalog } from "./provision-catalog";
import { tickFailover } from "./failover-worker";
import { advanceFailoverExecution, operationalFailoverEvents, requestFailoverRollback, startFailoverExecution } from "./failover-execution";
import { decideFailoverPlan, listFailoverPlans, prepareFailoverPlan } from "./failover-plans";
import { checkFailover } from "./failover-preflight";
import { ingestTelemetry } from "./telemetry";
import { agentTelemetryPlan, watchTelemetrySettings } from "./telemetry-policy";
import { gmailSettings, saveGmail, tickGmail } from "./gmail";
import { finishSpeedBatch, latestSpeedBatch, readSpeedBatch, startSpeedBatch } from "./speed-batch";
import { finishTunnelPing, tunnelPing } from "./tunnel-ping";
import { readActivity } from "./activity-log";
import { isActivityCategory } from "@/lib/activity";
import { readMonitorLogs } from "./log-storage";
import { getTunnelBundleRecipe, registerServer, registerTunnel, saveGreTransport } from "./topology";
import { lookupServerIp, saveInventoryServer } from "./server-management";
import { checkHostInventoryServer, pingInventoryServer } from "./server-ping";
import { telemetryIntervals } from "@/lib/telemetry-policy";
import { canStorePanelCredentials } from "./provider-secrets";
import { deleteServerSsh, openServerConsole, panelSshPublicKey, resizeServerConsole, revealServerSshPassword, saveServerSsh, sendServerConsoleInput, serverSshSettings, testServerSsh } from "./ssh-connection";
import { installAgentOverSsh, installFromPanel, registerAndInstallAgent, sshInstallEnabled } from "./ssh-provision";
import { getForwarderSettings, saveForwarderSettings, forwarderNoiseKeys, forwarderCertificate } from "./forwarder-settings";
import { getV2bxFiles, saveV2bxFiles, getGlobalV2bxFiles, saveGlobalV2bxFiles, applyGlobalV2bxFiles } from "./v2bx-files";
import { controlForwarder } from "./forwarder-control";
import { getAgentRegistration, issueAgentInvitation, redeemAgentInvitation, revokeAgentCredential } from "./agent-enrollment";
import { dnsStaleAfterMs, tickDnsMonitor } from "./dns-monitor";
import { projectObserverHealth } from "./probe-observers";
import { tickAgentHealth } from "./health-worker";
import { downloadAgentInstaller } from "./agent-installer";
import { downloadProvisionArtifact, uploadProvisionArtifacts } from "./provision-download";
import { observedAgentWorkers } from "./agent-workers";
import { readStagingReadiness } from "./staging-readiness";
import { changePanelNode, panelAdminNodes, savePanelNode } from "./v2board-nodes";
import { connectDnsManagement, dnsManagementSettings, dnsRecords, dnsZones, saveDnsRecord, syncDnsZones } from "./managed-dns";

const routes = {
  nodes: "nodes", servers: "servers", tunnels: "tunnels", dns: "dns",
  incidents: "incidents", alerts: "alerts", audit: "audit", policies: "policies",
  failovers: "failoverEvents", deployments: "deployments", speedtests: "speedtests",
  integrations: "integrations",
} as const;

function observedWorkspace(state: Workspace): Workspace {
  const db = database();
  const monitor = workspaceMode() === "monitor";
  // Current heartbeat survives history compaction; avoid scanning the report archive per request.
  const latest = monitor ? [] : db.prepare("SELECT server_id, MAX(observed_at) AS last_seen FROM agent_reports GROUP BY server_id").all();
  if (!latest.length && !monitor) return state;
  const now = Date.now();
  const activities = serverActivities(db, now);
  const seen = new Map(latest.map((item) => [item.server_id, Number(item.last_seen)]));
  const staleAfter = Math.max(90, state.settings.monitoringIntervalSec * 3) * 1000;
  const workers = monitor ? observedAgentWorkers(db, now, { iperf: iperfEnabled(), provision: provisionEnabled() }) : undefined;
  const servers = state.servers.map((server) => {
    const at = monitor ? Date.parse(server.agent.lastHeartbeat) : seen.get(server.id);
    const current = { ...server, activity: activities.get(server.id),
      agent: workers ? { ...server.agent, workers: workers(server.id) } : server.agent };
    return at !== undefined && (!Number.isFinite(at) || now - at > staleAfter)
      ? { ...current, status: "offline" as const, agent: { ...current.agent, status: "offline" as const } }
      : current;
  });
  const tunnels = monitor ? state.tunnels.map((tunnel) => {
    const at = Date.parse(tunnel.lastCheck);
    const probeFreshness = (state.settings.telemetryIntervals?.tunnelProbe ?? telemetryIntervals.tunnelProbe) * 2000 + 30000;
    return !Number.isFinite(at) || now - at > Math.max(staleAfter, probeFreshness)
      ? { ...tunnel, status: "offline" as const }
      : tunnel;
  }) : state.tunnels;
  const dnsDeadline = now - dnsStaleAfterMs();
  const dns = monitor ? state.dns.map((record) => Date.parse(record.lastCheck) < dnsDeadline
    ? { ...record, stale: true } : record) : state.dns;
  const nodes = monitor ? projectObserverHealth(state.nodes) : state.nodes;
  return { ...state, servers, tunnels, dns, nodes: decorateNodes(nodes, servers, tunnels, dns, state.settings, monitor) };
}

function publicWorkspace(state: Workspace) {
  const { pendingSpeedtest, ...visible } = projectSpeedtest(observedWorkspace(state));
  void pendingSpeedtest;
  const observed = visible;
  return {
    ...observed,
    users: adminConfig() ? [adminAccount] : observed.users,
    failoverEvents: workspaceMode() === "monitor"
      ? operationalFailoverEvents(observed.nodes, observed.settings.dataRetentionDays) : observed.failoverEvents,
    integrations: observed.integrations.map((integration) => {
      const config = { ...integration.config };
      delete config.token;
      config.readEnabled = String(workspaceMode() === "monitor" && (integration.type === "v2board" ? boardEnabled() : integration.type === "cloudflare" && authoritativeDnsEnabled()));
      if (integration.type === "v2board") {
        config.adminLoginEnabled = String(workspaceMode() === "monitor" && canStorePanelCredentials());
        const schedule = panelSyncSettings();
        config.syncMode = schedule.automatic ? schedule.intervalSec === null ? "invalid" : "scheduled" : "manual";
        if (schedule.intervalSec !== null) config.syncIntervalSec = String(schedule.intervalSec);
      }
      return { ...integration, config };
    }),
  };
}

function epoch(query: URLSearchParams, key: string) {
  const raw = query.get(key);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new ApiError(422, "QUERY", "بازهٔ گزارش معتبر نیست.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ApiError(422, "QUERY", "بازهٔ گزارش معتبر نیست.");
  return value;
}

function integer(query: URLSearchParams, key: string, fallback: number, max: number) {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ApiError(422, "QUERY", `پارامتر ${key} معتبر نیست.`);
  }
  return value;
}

function page<T>(items: T[], query: URLSearchParams) {
  const number = integer(query, "page", 1, 100000);
  const limit = integer(query, "limit", 50, 200);
  return {
    data: items.slice((number - 1) * limit, number * limit),
    page: number,
    limit,
    total: items.length,
  };
}

const ranges = z.enum(["15m", "1h", "6h", "24h", "7d", "30d"]);
const levels = z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);

export async function handle(request: Request, parts: string[]) {
  const route = parts.join("/");
  try {
    if (request.method === "GET" && route === "status") {
      return json({ data: { service: "NodeGuard", version: "v1", operationMode: workspaceMode() } });
    }
    if (request.method === "POST" && route === "session") return await login(request);
    if (request.method === "PUT" && route === "session/password") return await changeAdminPassword(request);
    if (parts[0] === "session" && parts[1] === "passkeys") return await handleAdminPasskeys(request, route);
    if (request.method === "DELETE" && route === "session") return logout(request);
    if (request.method === "POST" && route === "agent/enroll") {
      assertOrigin(request);
      return json({ data: redeemAgentInvitation(request, await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && route === "agent/telemetry") {
      const data = await ingestTelemetry(request);
      after(() => drainAgentUpdates(request));
      return json({ data });
    }
    if (request.method === "POST" && route === "agent/telemetry/plan") {
      return json({ data: agentTelemetryPlan(request, await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && route === "agent/telemetry/settings") {
      return json({ data: await watchTelemetrySettings(request, await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && route === "agent/telemetry/tunnel-ping") {
      return json({ data: finishTunnelPing(request, await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && route === "agent/telemetry/speed-batch") {
      return json({ data: finishSpeedBatch(request, await jsonBody(request, 8192)) });
    }

    if (request.method === "POST" && route === "agent/jobs/claim") {
      return json({ data: claimIperf(request, await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && parts[0] === "agent" && parts[1] === "jobs" && parts.length === 4) {
      if (parts[3] === "control") return json({ data: iperfControl(request, parts[2], await jsonBody(request, 2048)) });
      if (parts[3] === "finish") return json({ data: finishIperf(request, parts[2], await jsonBody(request, 16384)) });
    }

    if (request.method === "POST" && route === "agent/provision/claim") {
      after(() => finalizeTunnelActivations());
      const input = await jsonBody(request, 2048);
      const job = claimProvision(request, input);
      if (job) return json({ data: job });
      advanceTunnelDeployments();
      return json({ data: claimProvision(request, input) });
    }
    if (request.method === "POST" && parts[0] === "agent" && parts[1] === "provision" && parts[3] === "artifact" && parts.length === 4) {
      return await downloadProvisionArtifact(request, parts[2], await jsonBody(request, 2048));
    }
    if (request.method === "POST" && parts[0] === "agent" && parts[1] === "provision" && parts[3] === "progress" && parts.length === 4) {
      return json({ data: reportProvisionProgress(request, parts[2], await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && parts[0] === "agent" && parts[1] === "provision" && parts[3] === "finish" && parts.length === 4) {
      after(() => finalizeTunnelActivations());
      const result = finishProvision(request, parts[2], await jsonBody(request, 2048));
      advanceTunnelDeployments();
      return json({ data: result });
    }
    if (request.method === "POST" && route === "dns/monitor/tick") {
      authorizeMonitorWorker(request, "DNS");
      return json({ data: await tickDnsMonitor() });
    }
    if (request.method === "POST" && route === "health/worker/tick") {
      after(() => finalizeTunnelActivations());
      authorizeMonitorWorker(request, "HEALTH");
      after(() => drainAgentUpdates(request));
      const result = tickAgentHealth();
      await tickGmail();
      return json({ data: result });
    }

    if (request.method === "POST" && route === "providers/v2board/worker/tick") {
      authorizeMonitorWorker(request, "V2BOARD");
      return json({ data: await tickPanelSync() });
    }

    const actor = authenticate(request);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && ["servers", "tunnels", "provision", "iperf"].includes(parts[0]) &&
        !/\/(review|cancel|rollback|preview)(\/|$)/.test(route)) {
      const state = readWorkspace().state;
      const targets = new Set<string>();
      if (parts[0] === "servers" && parts[1]) targets.add(parts[1]);
      let input: Record<string, unknown> = {};
      if (request.headers.get("content-type")?.includes("application/json")) {
        try { input = await request.clone().json(); } catch { /* The route validates malformed input. */ }
      }
      for (const key of ["serverId", "sourceServerId", "destServerId"]) {
        if (typeof input?.[key] === "string") targets.add(input[key] as string);
      }
      const tunnelId = parts[0] === "tunnels" ? parts[1] : input?.tunnelId;
      const tunnel = state.tunnels.find((item) => item.id === tunnelId);
      if (tunnel) { targets.add(tunnel.iranEndpoint.serverId); targets.add(tunnel.foreignEndpoint.serverId); }
      const activities = serverActivities(database());
      const requestKey = request.headers.get("idempotency-key");
      // An exact retry returns the existing operation; its own host reservation
      // must not reject that retry before the operation validates its payload.
      const queuedServerAction = parts.length === 3 && parts[0] === "servers" &&
        ["bbr", "reboot", "v2bx-restart", "v2bx-reinstall", "v2bx-remove"].includes(parts[2]);
      const replay = requestKey && (route === "provision/jobs" || queuedServerAction
        ? database().prepare("SELECT 1 FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, requestKey)
        : ["provision/deploy", "provision/ssh-install", "provision/tunnels"].includes(route)
          ? database().prepare("SELECT 1 FROM tunnel_deployments WHERE actor_id=? AND request_key=?").get(actor.id, requestKey)
            ?? database().prepare("SELECT 1 FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, requestKey)
          : undefined);
      if (!replay && [...targets].some((id) => activities.has(id))) {
        throw new ApiError(409, "SERVER_OPERATION_BUSY", "ابتدا منتظر پایان عملیات جاری سرور بمانید.");
      }
    }
    if (route === "settings/v2bx-files") {
      requireSecureCredentialOrigin(request);
      if (request.method === "GET") return json({ data: getGlobalV2bxFiles(actor) });
      if (request.method === "PUT") {
        assertOrigin(request);
        return json({ data: saveGlobalV2bxFiles(actor, await jsonBody(request, 1900000)) });
      }
    }
    if (route === "settings/v2bx-files/apply" && request.method === "POST") {
      assertOrigin(request); requireSecureCredentialOrigin(request);
      return json({ data: await applyGlobalV2bxFiles(actor, await jsonBody(request, 1900000)) });
    }
    if (route === "settings/virtualizor") {
      if (request.method === "GET") return json({ data: virtualizorSettings(actor) });
      if (request.method === "PUT") {
        assertOrigin(request); requireSecureCredentialOrigin(request);
        return json({ data: saveVirtualizorSettings(actor, await jsonBody(request, 4096)) });
      }
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "virtualizor") {
      if (request.method === "GET") return json({ data: await serverVirtualizor(actor, parts[1]) });
      if (["PUT", "POST", "DELETE"].includes(request.method)) {
        assertOrigin(request);
        if (request.method === "DELETE") return json({ data: unbindVirtualizor(actor, parts[1]) });
        const input = await jsonBody(request, 1024);
        return json({ data: request.method === "PUT" ? await bindVirtualizor(actor, parts[1], input) : await controlVirtualizor(actor, parts[1], input) });
      }
    }

    if (route === "settings/agent-updates" && request.method === "GET") {
      const data = listAgentUpdates(actor);
      after(() => drainAgentUpdates(request));
      return json({ data });
    }
    if (route === "settings/agent-updates" && request.method === "POST") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      const input = z.object({ retry: z.boolean().default(false) }).strict().safeParse(await jsonBody(request, 256));
      if (!input.success) throw new ApiError(422, "AGENT_UPDATE_INPUT", "درخواست به‌روزرسانی معتبر نیست.");
      const data = queueAgentUpdates(actor, input.data.retry);
      after(() => drainAgentUpdates(request));
      return json({ data }, { status: 202 });
    }
    if (parts.length === 3 && parts[0] === "nodes" && parts[2] === "routes" && request.method === "PUT") {
      assertOrigin(request);
      return json({ data: await selectNodeRoutes(actor, parts[1], await jsonBody(request, 2048)) });
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "v2bx-nodes" && request.method === "GET") {
      return json({ data: await serverV2bxNodes(actor, parts[1]) });
    }
    if (request.method === "DELETE" && parts.length === 2 && parts[0] === "servers") {
      assertOrigin(request);
      return json({ data: deleteServerInventory(actor, parts[1], await jsonBody(request, 64 * 1024)) });
    }
    if (request.method === "GET" && route === "metrics/samples" && workspaceMode() === "monitor") {
      return json({ data: observedSampleReport(new URL(request.url).searchParams) });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "tunnels" && parts[2] === "dns") {
      assertOrigin(request);
      return json({ data: await setTunnelDns(actor, parts[1]) });
    }
    if (parts.length === 3 && parts[0] === "tunnels" && parts[2] === "ping" && ["GET", "POST"].includes(request.method)) {
      if (request.method === "POST") assertOrigin(request);
      return json({ data: tunnelPing(actor, parts[1], request.method === "POST") });
    }
    if (route === "notifications/gmail" && request.method === "GET") return json({ data: gmailSettings(actor) });
    if (route === "notifications/gmail" && request.method === "PUT") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: saveGmail(actor, await jsonBody(request, 2048)) });
    }
    if (request.method === "GET" && route === "servers/lookup" && new URL(request.url).searchParams.has("ip")) {
      return json({ data: await lookupServerIp(actor, new URL(request.url).searchParams.get("ip")) });
    }
    if (request.method === "GET" && parts.length === 3 && parts[0] === "servers" && parts[2] === "ping") {
      return json({ data: await pingInventoryServer(parts[1]) });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "servers" && parts[2] === "check-host") {
      assertOrigin(request);
      return json({ data: await checkHostInventoryServer(parts[1]) });
    }
    if (request.method === "PUT" && parts.length === 2 && parts[0] === "servers") {
      assertOrigin(request);
      const input = await jsonBody(request, 8192);
      if (input && typeof input === "object" && ("password" in input || "sshAuth" in input)) requireSecureCredentialOrigin(request);
      return json({ data: (await saveInventoryServer(actor, input, parts[1])).resource });
    }
    if (request.method === "POST" && (route === "servers" || route === "tunnels")) {
      assertOrigin(request);
      const input = await jsonBody(request, route === "servers" ? 8192 : 4096);
      if (route === "servers" && input && typeof input === "object" && ("password" in input || "sshAuth" in input)) requireSecureCredentialOrigin(request);
      if (route === "tunnels") {
        const { resource, replay } = registerTunnel(actor, input);
        return json({ data: resource, replay }, { status: replay ? 200 : 201 });
      }
      const result = input && typeof input === "object" && "id" in input ? registerServer(actor, input) : await saveInventoryServer(actor, input);
      return json({ data: result.resource, replay: result.replay }, { status: result.replay ? 200 : 201 });
    }
    if (request.method === "DELETE" && parts.length === 2 && parts[0] === "tunnels") {
      assertOrigin(request);
      return json({ data: deleteTunnelInventory(actor, parts[1]) });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "nodes" && parts[2] === "backup-route") {
      assertOrigin(request);
      throw new ApiError(410, "BACKUP_REGISTRATION_ONLY", "بکاپ فقط هنگام تعریف تونل جدید تعیین می‌شود.");
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "ssh") {
      if (request.method === "GET") return json({ data: { ...serverSshSettings(actor, parts[1]), installEnabled: sshInstallEnabled() } });
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      if (request.method === "PUT") return json({ data: await saveServerSsh(actor, parts[1], await jsonBody(request, 32 * 1024)) });
      if (request.method === "DELETE") return json({ data: deleteServerSsh(actor, parts[1]) });
    }
    if (request.method === "POST" && route === "servers/panel-ssh-key") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: panelSshPublicKey(actor) });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "servers" && parts[2] === "ssh-password") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: revealServerSshPassword(actor, parts[1]) });
    }
    if (request.method === "POST" && parts.length === 5 && parts[0] === "servers" && parts[2] === "console") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      if (parts[4] === "open") {
        const size = request.headers.get("content-type")?.split(";")[0].trim() === "application/json"
          ? await jsonBody(request, 256) : undefined;
        return openServerConsole(actor, parts[1], parts[3], request.signal, size);
      }
      if (parts[4] === "input") {
        sendServerConsoleInput(actor, parts[1], parts[3], await jsonBody(request, 64 * 1024));
        return json({ data: true });
      }
      if (parts[4] === "resize") {
        resizeServerConsole(actor, parts[1], parts[3], await jsonBody(request, 256));
        return json({ data: true });
      }
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "servers" && parts[2] === "ssh-install-agent") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await installAgentOverSsh(actor, parts[1], await jsonBody(request, 1024), request) });
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "v2bx-files") {
      requireSecureCredentialOrigin(request);
      if (request.method === "GET") return json({ data: getV2bxFiles(actor, parts[1]) });
      if (request.method === "PUT") {
        assertOrigin(request);
        return json({ data: await saveV2bxFiles(actor, parts[1], await jsonBody(request, 1900000)) });
      }
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "v2bx-remove") {
      const reference = request.method === "GET" ? new URL(request.url).searchParams.get("panelNode") ?? "" : "";
      if (request.method === "GET") return json({ data: v2bxRemoveStatus(parts[1], reference) });
      if (request.method === "POST") {
        assertOrigin(request);
        return json({ data: await queueV2bxRemove(actor, parts[1], request.headers.get("Idempotency-Key") ?? "", await jsonBody(request, 1024)) }, { status: 202 });
      }
    }
    if (parts.length === 3 && parts[0] === "servers" && (parts[2] === "v2bx-restart" || parts[2] === "v2bx-reinstall")) {
      const reinstall = parts[2] === "v2bx-reinstall";
      if (request.method === "GET") return json({ data: v2bxRestartStatus(parts[1], reinstall) });
      if (request.method === "POST") {
        assertOrigin(request);
        return json({ data: queueV2bxRestart(actor, parts[1], request.headers.get("Idempotency-Key") ?? "", reinstall) }, { status: 202 });
      }
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "reboot") {
      if (request.method === "GET") return json({ data: rebootStatus(parts[1]) });
      if (request.method === "POST") {
        assertOrigin(request);
        return json({ data: queueHostReboot(actor, parts[1], request.headers.get("Idempotency-Key") ?? "") }, { status: 202 });
      }
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "bbr") {
      if (request.method === "GET") return json({ data: bbrStatus(parts[1]) });
      if (request.method === "POST") {
        assertOrigin(request);
        const { job, replay } = queueBbr(actor, parts[1], request.headers.get("Idempotency-Key") ?? "");
        return json({ data: job, replay }, { status: replay ? 200 : 202 });
      }
    }
    if (request.method === "POST" && (route === "provision/deploy" || route === "provision/ssh-install")) {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await installFromPanel(actor, await jsonBody(request, 384 * 1024), request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && route === "provision/ssh-install-agent") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await registerAndInstallAgent(actor, await jsonBody(request, 8192), request) });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "servers" && parts[2] === "ssh-test") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await testServerSsh(actor, parts[1], await jsonBody(request, 32 * 1024)) });
    }
    if (request.method === "GET" && parts.length === 4 && parts[0] === "servers" && parts[2] === "agent" && parts[3] === "installer") {
      return await downloadAgentInstaller(actor, parts[1], request);
    }
    if (parts.length === 3 && parts[0] === "servers" && parts[2] === "agent") {
      const serverId = parts[1];
      if (request.method === "GET") return json({ data: getAgentRegistration(actor, serverId) });
      if (request.method === "POST" || request.method === "DELETE") {
        assertOrigin(request);
        return json({ data: request.method === "POST" ? issueAgentInvitation(actor, serverId) : revokeAgentCredential(actor, serverId) });
      }
    }
    if (parts.length === 3 && parts[0] === "tunnels" && parts[2] === "forwarder-settings") {
      requireSecureCredentialOrigin(request);
      if (request.method === "GET") return json({ data: getForwarderSettings(actor, parts[1]) });
      if (request.method === "PUT") {
        assertOrigin(request);
        return json({ data: saveForwarderSettings(actor, parts[1], await jsonBody(request, 3 * 1024 * 1024)) });
      }
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "tunnels" && parts[2] === "service-control") {
      assertOrigin(request);
      return json({ data: controlForwarder(actor, parts[1], await jsonBody(request, 1024), request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "tunnels" && parts[2] === "noise-keys") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: forwarderNoiseKeys(actor, parts[1]) });
    }
    if (request.method === "POST" && parts.length === 3 && parts[0] === "tunnels" && parts[2] === "tls-certificate") {
      assertOrigin(request); requireSecureCredentialOrigin(request);
      return json({ data: await forwarderCertificate(actor, parts[1], await jsonBody(request, 1024)) });
    }
    if (request.method === "GET" && parts.length === 3 && parts[0] === "tunnels" && parts[2] === "bundle-recipe") {
      return json({ data: await getTunnelBundleRecipe(actor, parts[1]) });
    }
    if (request.method === "PUT" && parts.length === 3 && parts[0] === "tunnels" && parts[2] === "gre-transport") {
      assertOrigin(request);
      return json({ data: saveGreTransport(actor, parts[1], await jsonBody(request, 1024)) });
    }
    if (request.method === "POST" && (route === "provision/catalog/preview" || route === "provision/catalog/import")) {
      assertOrigin(request);
      const input = await jsonBody(request);
      return json({ data: route.endsWith("/preview") ? previewProvisionCatalog(actor, input) : importProvisionCatalog(actor, input) });
    }
    if (request.method === "GET" && route === "provision/tunnels") {
      after(() => finalizeTunnelActivations());
      return json({ data: { ...listTunnelDeployments(new URL(request.url).searchParams.get("tunnelId") ?? undefined), sshInstallEnabled: sshInstallEnabled() } });
    }
    if (request.method === "POST" && route === "provision/tunnels") {
      assertOrigin(request);
      return json({ data: startTunnelDeployment(actor, await jsonBody(request, 2048), request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && parts[0] === "provision" && parts[1] === "tunnels" && parts.length === 4 &&
        (parts[3] === "rollback" || parts[3] === "review")) {
      assertOrigin(request);
      return json({ data: manageTunnelDeployment(actor, parts[2], parts[3]) });
    }
    if (request.method === "GET" && route === "provision/jobs") return json({ data: { ...listProvision(), sshInstallEnabled: sshInstallEnabled() } });
    if (request.method === "POST" && parts[0] === "provision" && parts[1] === "profiles" && parts.length === 5 && parts[4] === "artifacts") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await uploadProvisionArtifacts(actor, request, parts[2], parts[3]) });
    }
    if (request.method === "POST" && route === "provision/jobs") {
      assertOrigin(request);
      return json({ data: queueProvision(actor, await jsonBody(request, 2048), request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && parts[0] === "provision" && parts[1] === "jobs" && parts[3] === "review" && parts.length === 4) {
      assertOrigin(request);
      return json({ data: dismissProvisionReview(actor, parts[2]) });
    }
    if (request.method === "GET" && route === "notifications/telegram") return json({ data: telegramHistory(actor) });
    if (route === "notifications/telegram/config") {
      if (request.method === "GET") return json({ data: telegramConfig(actor) });
      if (request.method === "PUT") {
        assertOrigin(request);
        requireSecureCredentialOrigin(request);
        return json({ data: saveTelegramConfig(actor, await jsonBody(request, 2048)) });
      }
    }
    if (request.method === "POST" && route === "notifications/telegram/test") {
      assertOrigin(request);
      return json({ data: await sendTelegramTest(actor, request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && route === "notifications/telegram/tick") {
      assertOrigin(request);
      return json({ data: await tickTelegram(actor) });
    }
    if (request.method === "GET" && parts[0] === "failover" && parts[1] === "preflight" && parts.length === 3) {
      const target = z.enum(["primary", "backup"]).safeParse(new URL(request.url).searchParams.get("target") ?? "backup");
      if (!target.success) throw new ApiError(422, "FAILOVER_TARGET", "مسیر جایگزین معتبر نیست.");
      return json({ data: checkFailover(parts[2], target.data).result });
    }
    if (request.method === "POST" && route === "failover/worker/tick") {
      assertOrigin(request);
      return json({ data: await tickFailover(actor) });
    }
    if (request.method === "GET" && route === "failover/plans") return json({ data: listFailoverPlans(), executionEnabled: dnsExecutionEnabled() });
    if (request.method === "POST" && route === "failover/plans") {
      assertOrigin(request);
      return json({ data: prepareFailoverPlan(actor, await jsonBody(request, 2048), request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && parts[0] === "failover" && parts[1] === "plans" && parts.length === 4 && parts[3] === "decision") {
      assertOrigin(request);
      return json({ data: decideFailoverPlan(actor, parts[2], await jsonBody(request, 2048)) });
    }
    if (request.method === "POST" && parts[0] === "failover" && parts[1] === "plans" && parts.length === 4) {
      const action = parts[3];
      if (action === "execute" || action === "advance" || action === "rollback" || action === "reconcile") {
        assertOrigin(request);
        const id = parts[2];
        if (action === "execute") return json({ data: startFailoverExecution(actor, id) });
        if (action === "rollback") return json({ data: requestFailoverRollback(actor, id) });
        return json({ data: await advanceFailoverExecution(actor, id, action === "reconcile") });
      }
    }
    if (request.method === "POST" && route === "speedtests/batch") {
      assertOrigin(request);
      return json({ data: startSpeedBatch(actor, await jsonBody(request, 8192)) });
    }
    if (request.method === "GET" && route === "speedtests/batch") return json({ data: latestSpeedBatch(actor) });
    if (request.method === "GET" && parts[0] === "speedtests" && parts[1] === "batch" && parts.length === 3) {
      return json({ data: readSpeedBatch(actor, parts[2]) });
    }
    if (request.method === "GET" && route === "iperf/jobs") return json({ data: listIperfJobs() });
    if (request.method === "POST" && route === "iperf/jobs") {
      assertOrigin(request);
      return json({ data: enqueueIperf(actor, await jsonBody(request, 4096), request.headers.get("idempotency-key") ?? "") });
    }
    if (request.method === "POST" && parts[0] === "iperf" && parts[1] === "jobs" && parts.length === 4 && parts[3] === "cancel") {
      assertOrigin(request);
      return json({ data: cancelIperf(actor, parts[2]) });
    }
    if (request.method === "POST" && route === "providers/v2board/connect") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await connectPanelAdmin(actor, await jsonBody(request, 8192)) });
    }
    if (request.method === "POST" && route === "providers/v2board/sync") {
      assertOrigin(request);
      return json({ data: await refreshPanel(actor) });
    }
    if (request.method === "POST" && parts[0] === "providers" && ["cloudflare", "dns"].includes(parts[1]) && parts.length === 3) {
      assertOrigin(request);
      return json({ data: await refreshAuthoritativeDns(actor, parts[2]) });
    }
    if (request.method === "POST" && route === "providers/v2board/import") {
      assertOrigin(request);
      return json({ data: importPanelNode(actor, await jsonBody(request, 4096)) });
    }
    if (request.method === "GET" && route === "providers/v2board/online") return json({ data: await panelOnlineSnapshot() });
    if (request.method === "GET" && route === "providers/v2board/catalog") return json({ data: panelCatalog() });
    if (route === "providers/v2board/nodes") {
      if (request.method === "GET") return json({ data: await panelAdminNodes(actor) });
      if (request.method === "POST") {
        assertOrigin(request);
        return json({ data: await savePanelNode(actor, await jsonBody(request, 96 * 1024)) });
      }
      if (request.method === "PATCH") {
        assertOrigin(request);
        return json({ data: await changePanelNode(actor, await jsonBody(request, 2048)) });
      }
    }
    if (route === "domains") {
      if (request.method === "GET") return json({ data: dnsZones(actor) });
      if (request.method === "POST") {
        assertOrigin(request);
        return json({ data: await syncDnsZones(actor) });
      }
    }
    if (route === "providers/dns-settings" && request.method === "GET") return json({ data: dnsManagementSettings(actor) });
    if (parts.length === 3 && parts[0] === "providers" && parts[1] === "dns-settings" && request.method === "PUT") {
      assertOrigin(request);
      requireSecureCredentialOrigin(request);
      return json({ data: await connectDnsManagement(actor, parts[2], await jsonBody(request, 1024)) });
    }
    if (parts.length === 4 && parts[0] === "domains" && parts[3] === "records") {
      if (request.method === "GET") return json({ data: await dnsRecords(actor, parts[1], parts[2]) });
      if (request.method === "POST") {
        assertOrigin(request);
        return json({ data: await saveDnsRecord(actor, parts[1], parts[2], await jsonBody(request, 32 * 1024)) });
      }
    }
    if (request.method === "POST" && route === "actions") {
      assertOrigin(request);
      const result = await execute(actor, await jsonBody(request), request.headers.get("idempotency-key") ?? "");
      return json({ data: publicWorkspace(result.state), revision: result.revision, replay: result.replay, mode: workspaceMode() });
    }
    if (request.method !== "GET") throw new ApiError(404, "NOT_FOUND", "مسیر API پیدا نشد.");

    if (route === "session") return json({ data: actor });
    if (route === "staging/readiness") return json({ data: readStagingReadiness(new URL(request.url).searchParams) });
    const query = new URL(request.url).searchParams;
    const monitor = workspaceMode() === "monitor";
    if (route === "activity") {
      const category = query.get("category");
      if (category && !isActivityCategory(category)) throw new ApiError(422, "QUERY", "دستهٔ گزارش معتبر نیست.");
      const from = epoch(query, "from");
      const to = epoch(query, "to");
      if ((from === undefined) !== (to === undefined) || (from !== undefined && to !== undefined && (to < from || to - from > 3660 * 86400000))) {
        throw new ApiError(422, "QUERY", "بازهٔ گزارش معتبر نیست.");
      }
      return json(readActivity(database(), {
        minutes: integer(query, "minutes", 10080, 5256000),
        page: integer(query, "page", 1, 100000),
        limit: integer(query, "limit", 50, 200),
        from, to, category,
        server: query.get("serverId"),
        node: query.get("nodeId"),
        search: query.get("q")?.slice(0, 256).toLowerCase(),
      }));
    }
    if (route === "logs" && monitor) {
      const severity = query.get("severity");
      if (severity && !levels.safeParse(severity).success) throw new ApiError(422, "QUERY", "سطح لاگ معتبر نیست.");
      const snapshot = (name: string, max: number) => {
        const raw = query.get(name);
        if (raw === null) return undefined;
        const number = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 0 || number > max) {
          throw new ApiError(422, "LOG_SNAPSHOT", "محدودهٔ ثابت لاگ معتبر نیست.");
        }
        return number;
      };
      const now = Date.now();
      return json(readMonitorLogs(database(), {
        v2bxHosts: readWorkspace().state.servers.filter((host) => host.roles.includes("foreign")).map((host) => host.id),
        minutes: integer(query, "minutes", 10, 43200), page: integer(query, "page", 1, 100000), limit: integer(query, "limit", 50, 200),
        through: snapshot("through", now + 30000) ?? now, watermark: snapshot("watermark", Number.MAX_SAFE_INTEGER),
        severity, source: query.get("source"), node: query.get("nodeId"), server: query.get("serverId"),
        search: query.get("q")?.slice(0, 256).toLowerCase(),
      }));
    }
    const current = readWorkspace();
    const pending = current.state.pendingSpeedtest;
    const due = pending && Date.parse(pending.result.createdAt) <= Date.now();
    const { revision, state: stored } = due ? transaction(settleSpeedtest) : current;
    const state = publicWorkspace(stored);
    if (route === "workspace") return json({ data: state, revision, actor, mode: workspaceMode() });
    if (route === "settings") return json({ data: state.settings });
    if (route === "overview") {
      const observed = monitor ? observedAvailability("24h", state.nodes.map((node) => node.id)).proxy : null;
      return json({ data: {
        totalNodes: state.nodes.length,
        healthy: state.nodes.filter((n) => n.health === "healthy").length,
        degraded: state.nodes.filter((n) => n.health === "degraded").length,
        offline: state.nodes.filter((n) => n.health === "offline").length,
        uptimePct: monitor ? null : state.nodes.length ? state.nodes.reduce((sum, node) => sum + node.uptimePct, 0) / state.nodes.length : 0,
        availability: observed ? { ...observed, pct: availabilityPct(observed), range: "24h" } : null,
        activeAlerts: state.alerts.filter((a) => !a.archived && !a.resolved && (!a.silencedUntil || Date.parse(a.silencedUntil) <= Date.now())).length,
        recentIncidents: state.incidents.slice(0, 10),
      } });
    }
    if (route === "health" || (parts[0] === "nodes" && parts[2] === "health" && parts.length === 3)) {
      const nodes = parts[1] ? state.nodes.filter((item) => item.id === parts[1]) : state.nodes;
      if (parts[1] && !nodes.length) throw new ApiError(404, "NODE_UNKNOWN", "نود پیدا نشد.");
      const health = nodes.map((n) => assessNode(n, state.servers, state.tunnels, state.dns, state.settings, workspaceMode() === "monitor"));
      return json(parts[1] ? { data: health[0] } : page(health, query));
    }
    if (request.method === "GET" && route === "metrics/iran-bandwidth") {
      const range = ranges.safeParse(query.get("range") ?? "24h");
      if (!range.success) throw new ApiError(422, "QUERY", "Invalid range.");
      return json({ data: iranBandwidth(range.data, state.servers) });
    }
    if (route === "availability" || route === "metrics") {
      const range = ranges.safeParse(query.get("range") ?? "24h");
      if (!range.success) throw new ApiError(422, "QUERY", "بازهٔ نمودار معتبر نیست.");
      if (route === "availability") {
        if (!monitor) throw new ApiError(409, "MONITOR_REQUIRED", "تاریخچهٔ کاوش واقعی در حالت پایش در دسترس است.");
        return json({ data: observedAvailability(range.data, state.nodes.map((node) => node.id), state.tunnels.map((tunnel) => tunnel.id)) });
      }
      if (workspaceMode() === "monitor") {
        const serverId = query.get("serverId") ?? undefined;
        const tunnelId = query.get("tunnelId") ?? undefined;
        if ((serverId && !state.servers.some((s) => s.id === serverId)) || (tunnelId && !state.tunnels.some((t) => t.id === tunnelId)) || (serverId && tunnelId)) {
          throw new ApiError(422, "METRIC_SCOPE", "محدودهٔ نمودار معتبر نیست.");
        }
        let bounds: { from: number; to: number } | undefined;
        if (query.has("from") || query.has("to")) {
          const from = Number(query.get("from"));
          const to = Number(query.get("to"));
          if (!query.has("from") || !query.has("to") || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > Date.now() + 60000 || to - from > 30 * 86400000) {
            throw new ApiError(422, "METRIC_DATES", "بازهٔ تاریخ باید معتبر، در گذشته و حداکثر ۳۰ روز باشد.");
          }
          bounds = { from, to };
        }
        return json({ data: observedMetrics(range.data, serverId, tunnelId, bounds), simulated: false });
      }
      return json({ data: buildMetrics(range.data, query.get("seed")?.slice(0, 96) ?? "fleet"), simulated: true });
    }
    if (parts[0] === "servers" && parts[2] === "telemetry" && parts.length === 3) {
      if (!state.servers.some((s) => s.id === parts[1])) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
      const rows = database().prepare("SELECT payload FROM agent_reports WHERE server_id = ? ORDER BY observed_at DESC LIMIT ?")
        .all(parts[1], integer(query, "limit", 60, 200));
      return json({ data: rows.map((row) => JSON.parse(String(row.payload))) });
    }
    if (route === "logs") {
      const minutes = integer(query, "minutes", 10, 43200);
      const since = Date.now() - minutes * 60000;
      const severity = query.get("severity");
      if (severity && !levels.safeParse(severity).success) throw new ApiError(422, "QUERY", "سطح لاگ معتبر نیست.");
      const source = query.get("source");
      const node = query.get("nodeId");
      const server = query.get("serverId");
      const search = query.get("q")?.slice(0, 256).toLowerCase();
      return json(page(state.logs.filter((log) =>
        Date.parse(log.ts) >= since && (!severity || log.severity === severity) &&
        (!node || log.nodeId === node) && (!server || log.serverId === server) &&
        (!source || log.source === source) && (!search || log.message.toLowerCase().includes(search)),
      ).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)), query));
    }
    if (parts.length <= 2 && Object.hasOwn(routes, parts[0])) {
      const items = state[routes[parts[0] as keyof typeof routes]];
      if (parts[1]) {
        const match = items.find((item) => ("id" in item ? item.id : item.nodeId) === parts[1]);
        if (!match) throw new ApiError(404, "NOT_FOUND", "مورد انتخاب‌شده پیدا نشد.");
        return json({ data: match });
      }
      return json(page([...items], query));
    }
    throw new ApiError(404, "NOT_FOUND", "مسیر API پیدا نشد.");
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
    }
    console.error("NodeGuard API failure:", error instanceof Error ? error.name : "unknown");
    return json({ error: { code: "INTERNAL", message: "خطای داخلی NodeGuard." } }, { status: 500 });
  }
}
