"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { toast } from "sonner";
import { t } from "@/i18n/runtime";
import {
  browserSupportsWebAuthn, startAuthentication, startRegistration,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { DnsProvider, DnsRecordInput, ManagedDnsRecord, ManagedDnsZone } from "@/lib/managed-dns";
import type { PanelAdminNodes, PanelNodeType } from "@/lib/v2board-node-fields";
import { setLocalPersistence, useInfraStore } from "@/stores/infra-store";
import type { InfraState } from "@/stores/infra-workflows";
import type { Server, ServerPing } from "@/types";
import type { AgentUpdateJob } from "@/types";

export async function listServerV2bxNodes(serverId: string) {
  return (await request<{ data: PanelAdminNodes }>(`servers/${encodeURIComponent(serverId)}/v2bx-nodes`)).data;
}
export async function getAgentUpdates() {
  return (await request<{ data: { version: string; enabled: boolean; batchId: string | null; jobs: AgentUpdateJob[] } }>("settings/agent-updates")).data;
}
export async function updateAllAgents(retry = false) {
  return request("settings/agent-updates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retry }) });
}
export async function selectNodeRoutes(nodeId: string, selection: { primaryTunnelId: string; backupTunnelId?: string; activeSide: "primary" | "backup" }) {
  await request(`nodes/${encodeURIComponent(nodeId)}/routes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection) });
  await syncBackend();
}
import type { ActivityPage, AgentInvitation, AgentRegistration, DemoSnapshot, DemoUser, FailoverExecution, FailoverPreflight, FailoverRun, ForwarderBundleRecipe, IperfConfig, IperfJob, LogSnapshot, MetricPoint, ObservedAvailability, ObservedLogPage, OperationalFailoverPlan, ProvisionCatalogPreview, ProvisionJob, ProvisionProfile, SpeedBatch, SpeedtestRun, TimeRange, TunnelBundleRecipe, TunnelDeployment, TunnelDeploymentPreview, V2BoardCatalog } from "@/types";

type Workspace = DemoSnapshot & { failoverRun: FailoverRun | null; speedtestRun: SpeedtestRun | null };
type ResponseData = { data: Workspace; revision: number; actor?: DemoUser; mode: "simulation" | "monitor" };

export const useBackend = create<{ actor: DemoUser | null; status: "local" | "connected" | "error"; mode: "simulation" | "monitor" }>(() => ({
  actor: null,
  status: "local",
  mode: "simulation",
}));

type Command = Exclude<{
  [K in keyof InfraState]: InfraState[K] extends (...args: never[]) => unknown ? K : never
}[keyof InfraState], "resetDemo" | "switchUser" | "setRange" | "setHydrated" | "setLiveLogs">;

let revision = -1;
let generation = 0;
let workspaceSync: { generation: number; promise: Promise<void> } | undefined;

function apply(result: ResponseData) {
  const actor = result.actor ?? useBackend.getState().actor;
  if (!actor || result.revision < revision) return;
  if (!useBackend.getState().actor) useInfraStore.getState().setLiveLogs(false);
  setLocalPersistence(false);
  useInfraStore.setState({ ...result.data, currentUserId: actor.id });
  revision = result.revision;
  useBackend.setState({ actor, status: "connected", mode: result.mode });
}

function disconnect() {
  generation += 1;
  revision = -1;
  useBackend.setState({ actor: null, status: "local", mode: "simulation" });
  useInfraStore.getState().resetDemo();
  setLocalPersistence(true);
  void useInfraStore.persist.rehydrate();
}

type ErrorBody = { error?: { message?: string; code?: string; details?: unknown } };

export const useServerOperations = create<{ active: Record<string, string> }>(() => ({ active: {} }));

function operationTargets(path: string, options?: RequestInit) {
  if (!options?.method || options.method === "GET") return [];
  // These requests inspect state or manage an existing execution.
  if (/\/(preview|review|cancel|logs|ssh-password)(\?|$)/.test(path)) return [];
  const state = useInfraStore.getState();
  let input: Record<string, unknown> = {};
  if (typeof options.body === "string") {
    try { input = JSON.parse(options.body) ?? {}; } catch { /* Non-JSON bodies have no host fields. */ }
  }
  const server = /^servers\/([^/?]+)/.exec(path)?.[1];
  const tunnel = /^tunnels\/([^/?]+)/.exec(path)?.[1];
  const tunnelId = typeof input.tunnelId === "string" ? input.tunnelId : tunnel && decodeURIComponent(tunnel);
  const linked = state.tunnels.find((item) => item.id === tunnelId);
  return [...new Set([
    ...(server ? [decodeURIComponent(server)] : []),
    ...[input.serverId, input.sourceServerId, input.destServerId].filter((id): id is string => typeof id === "string"),
    ...(linked ? [linked.iranEndpoint.serverId, linked.foreignEndpoint.serverId] : []),
  ])].filter((id) => state.servers.some((server) => server.id === id));
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const targets = operationTargets(path, options);
  const active = useServerOperations.getState().active;
  if (targets.some((id) => active[id] || useInfraStore.getState().servers.find((server) => server.id === id)?.activity)) {
    throw new BackendError("ابتدا منتظر پایان عملیات جاری سرور بمانید.", 409, "SERVER_OPERATION_BUSY");
  }
  if (!targets.length) return sendRequest<T>(path, options);
  const operation = options?.method === "DELETE" ? "remove" : path.includes("ssh-install-agent") ? "agent" :
    path.includes("tunnel") ? "tunnel" : path.includes("v2bx") ? "v2bx" : "operation";
  useServerOperations.setState({ active: { ...active, ...Object.fromEntries(targets.map((id) => [id, operation])) } });
  try {
    return await sendRequest<T>(path, options);
  } finally {
    // Keep the local lock until the queued work has appeared in the shared snapshot.
    await syncBackend();
    const next = { ...useServerOperations.getState().active };
    for (const id of targets) delete next[id];
    useServerOperations.setState({ active: next });
  }
}

async function sendRequest<T>(path: string, options?: RequestInit) {
  const timeout = !options?.method || options.method === "GET" ? AbortSignal.timeout(POLLING.readTimeout) : undefined;
  const signal = timeout && options?.signal ? AbortSignal.any([timeout, options.signal]) : options?.signal ?? timeout;
  const response = await fetch("/api/v1/" + path, { cache: "no-store", ...options, signal });
  const body = await response.text();
  let result: ErrorBody | null = null;
  if (body) {
    try {
      result = JSON.parse(body) as ErrorBody;
    } catch {
      throw new BackendError(t("errors.requestFailed"), response.status || 502);
    }
  }
  if (!response.ok || !result) {
    throw new BackendError(result?.error?.message ?? t("errors.requestFailed"), response.status || 502, result?.error?.code, result?.error?.details);
  }
  return result as T;
}

export class BackendError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) { super(message); }
}

export function sshHostConfirmation(error: unknown) {
  if (!(error instanceof BackendError) || error.code !== "SSH_HOST_CONFIRMATION") return;
  const details = error.details;
  if (details && typeof details === "object" && "fingerprint" in details && typeof details.fingerprint === "string") {
    return details.fingerprint;
  }
}

export function syncBackend(): Promise<void> {
  if (workspaceSync?.generation === generation) return workspaceSync.promise;
  const task = { generation, promise: fetchWorkspace() };
  workspaceSync = task;
  void task.promise.finally(() => {
    if (workspaceSync === task) workspaceSync = undefined;
  });
  return task.promise;
}

async function fetchWorkspace() {
  const current = generation;
  try {
    const snapshot = await request<ResponseData>("workspace", { signal: AbortSignal.timeout(15000) });
    if (current === generation) apply(snapshot);
  } catch (error) {
    if (current !== generation || !useBackend.getState().actor) return;
    if (error instanceof BackendError && error.status === 401) {
      disconnect();
      toast.error(t("errors.sessionEnded"));
    } else {
      useBackend.setState({ status: "error" });
    }
  }
}

export async function signInAdmin(username: string, password: string) {
  await request("session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function updateAdminPassword(currentPassword: string, newPassword: string) {
  await request("session/password", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

type AdminPasskey = { id: string; name: string; createdAt: number };
export const adminPasskeysQueryKey = ["admin-passkeys"] as const;

export async function listAdminPasskeys() {
  return (await request<{ data: AdminPasskey[] }>("session/passkeys")).data;
}

function passkeyRequest<T>(path: string, body?: unknown, method = "POST") {
  return request<{ data: T }>("session/passkeys" + path, {
    method,
    ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function requirePasskeySupport() {
  if (!window.isSecureContext || !browserSupportsWebAuthn()) {
    throw new Error(t("errors.passkeyHttps"));
  }
}

export async function registerAdminPasskey(name: string, password: string) {
  requirePasskeySupport();
  const { data: optionsJSON } = await passkeyRequest<PublicKeyCredentialCreationOptionsJSON>("/register/options", { password });
  const response = await startRegistration({ optionsJSON }).catch(() => {
    throw new Error(t("errors.passkeyRegisterFailed"));
  });
  await passkeyRequest("/register/verify", { name, response });
}

export async function signInWithPasskey() {
  requirePasskeySupport();
  const { data: optionsJSON } = await passkeyRequest<PublicKeyCredentialRequestOptionsJSON>("/login/options");
  const response = await startAuthentication({ optionsJSON }).catch(() => {
    throw new Error(t("errors.passkeyVerifyFailed"));
  });
  await passkeyRequest("/login/verify", response);
}

export async function removeAdminPasskey(id: string) {
  await passkeyRequest("", id, "DELETE");
}

export async function connectBackend(userId: string, token: string) {
  generation += 1;
  await request("session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, token }),
  });
  const result = await request<ResponseData>("workspace");
  revision = -1;
  apply(result);
}

export async function disconnectBackend() {
  await request("session", { method: "DELETE" });
  disconnect();
}

export async function infraAction<K extends Command>(action: K, ...args: Parameters<InfraState[K]>) {
  if (!useBackend.getState().actor) {
    const run = useInfraStore.getState()[action] as (...values: Parameters<InfraState[K]>) => ReturnType<InfraState[K]>;
    return (await run(...args)) ?? null;
  }

  const current = generation;
  try {
    const result = await request<ResponseData>("actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, args }),
    });
    if (current === generation) apply(result);
    return null;
  } catch (error) {
    if (current === generation && error instanceof BackendError && error.status === 401) disconnect();
    return error instanceof BackendError ? error.message : t("errors.backendUnreachable");
  }
}

export function useInfraAction<K extends Command>(action: K) {
  return useCallback((...args: Parameters<InfraState[K]>) => infraAction(action, ...args), [action]);
}

export async function refreshProvider(path: "v2board/sync" | `cloudflare/${string}` | `dns/${string}`) {
  try {
    await request("providers/" + path, { method: "POST" });
    await syncBackend();
    return null;
  } catch (error) {
    if (path === "v2board/sync" && error instanceof BackendError && error.status >= 500) await syncBackend();
    return error instanceof BackendError ? error.message : t("errors.backendUnreachable");
  }
}

export async function getTunnelBundleRecipe(tunnelId: string) {
  return (await request<{ data: TunnelBundleRecipe | ForwarderBundleRecipe }>(`tunnels/${encodeURIComponent(tunnelId)}/bundle-recipe`)).data;
}

export async function registerInventory(kind: "servers" | "tunnels", payload: object) {
  const { data, dns } = await request<{ data: { id: string }; dns?: { status: "matched" | "created" | "updated" | "failed"; message?: string } }>(kind, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return { ...data, dns };
}

export async function lookupServerAddress(ip: string) {
  return (await request<{ data: Pick<Server, "provider" | "countryCode"> }>(`servers/lookup?ip=${encodeURIComponent(ip)}`)).data;
}

export async function updateInventoryServer(id: string, payload: object) {
  return (await request<{ data: Server }>(`servers/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  })).data;
}

export function useServerPing(server: Pick<Server, "id" | "publicIpv4">, monitor: boolean) {
  return useQuery({
    queryKey: ["server-ping", server.id, server.publicIpv4],
    queryFn: async ({ signal }) => (await request<{ data: ServerPing }>(`servers/${encodeURIComponent(server.id)}/ping`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })).data,
    enabled: monitor,
    staleTime: POLLING.ping,
    refetchInterval: (query) => pollingInterval(query, monitor ? POLLING.ping : false),
    retry: false,
  });
}

export async function getAgentRegistration(serverId: string) {
  return (await request<{ data: AgentRegistration }>(`servers/${encodeURIComponent(serverId)}/agent`)).data;
}

export async function issueAgentInvitation(serverId: string) {
  return (await request<{ data: AgentInvitation }>(`servers/${encodeURIComponent(serverId)}/agent`, { method: "POST" })).data;
}

export async function fetchAgentInstaller(serverId: string) {
  const response = await fetch(`/api/v1/servers/${encodeURIComponent(serverId)}/agent/installer`, { cache: "no-store" });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new BackendError(result?.error?.message ?? t("errors.agentBundleFailed"), response.status);
  }
  return response.blob();
}

export async function revokeAgentCredential(serverId: string) {
  return (await request<{ data: AgentRegistration }>(`servers/${encodeURIComponent(serverId)}/agent`, { method: "DELETE" })).data;
}

export async function getActivity(filters: {
  category?: string; serverId?: string; nodeId?: string; q?: string;
  minutes?: number; from?: number; to?: number; page?: number; limit?: number;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return request<ActivityPage>("activity?" + query);
}

export async function getObservedLogs(filters: {
  nodeId?: string; serverId?: string; source?: string; severity?: string; q?: string;
  minutes?: number; page?: number; limit?: number; snapshot?: LogSnapshot;
}) {
  const query = new URLSearchParams();
  const { snapshot, ...values } = filters;
  for (const [key, value] of Object.entries({ ...values, ...snapshot })) {
    if (value !== undefined) query.set(key, String(value));
  }
  return request<ObservedLogPage>("logs?" + query);
}

export function useObservedAvailability(range: TimeRange, monitor: boolean) {
  return useQuery({
    queryKey: ["observed-availability", range],
    queryFn: async () => (await request<{ data: ObservedAvailability }>("availability?range=" + range)).data,
    enabled: monitor,
    staleTime: POLLING.metrics,
    refetchInterval: (query) => pollingInterval(query, monitor ? POLLING.metrics : false),
  });
}

export async function observedMetricSeries(range: TimeRange, scope?: { serverId: string } | { tunnelId: string }, bounds?: { from: number; to: number }) {
  const params = new URLSearchParams({ range, ...scope });
  if (bounds) { params.set("from", String(bounds.from)); params.set("to", String(bounds.to)); }
  return (await request<{ data: (Pick<MetricPoint, "label" | "ts"> & { [K in keyof Omit<MetricPoint, "label" | "ts">]?: MetricPoint[K] | null })[] }>("metrics?" + params)).data;
}

export async function observedSamples(stream: string, id: string, days: number) {
  const query = new URLSearchParams({ stream, id, days: String(days) });
  return (await request<{ data: { fields: string[]; samples: Record<string, number | string | null>[]; limited: boolean } }>("metrics/samples?" + query)).data;
}

export async function checkHostPing(serverId: string) {
  return (await request<{ data: { node: string; location: string; rttMs: number | null; packetLoss: number | null }[] }>(
    `servers/${encodeURIComponent(serverId)}/check-host`, { method: "POST" })).data;
}

export async function requestTunnelPing(id: string, start = false) {
  return (await request<{ data: { id: string; status: "pending" | "complete" | "expired";
    result: { rttMs: number | null; jitterMs: number | null; packetLoss: number } | null } | null }>(
    `tunnels/${encodeURIComponent(id)}/ping`, { method: start ? "POST" : "GET" })).data;
}

export async function listOperationalSpeedtests() {
  return (await request<{ data: { enabled: boolean; targets: { tunnelId: string; receiverServerId: string }[]; jobs: IperfJob[] } }>("iperf/jobs")).data;
}

export async function enqueueOperationalSpeedtest(config: IperfConfig, key: string) {
  return (await request<{ data: { job: IperfJob } }>("iperf/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(config),
  })).data.job;
}

export async function cancelOperationalSpeedtest(id: string) {
  return (await request<{ data: IperfJob }>("iperf/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" })).data;
}

export async function startSpeedBatch(input: { mode: "gre" | "internet"; ids: string[] }) {
  return (await request<{ data: SpeedBatch }>("speedtests/batch", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })).data;
}

export async function readSpeedBatch(id?: string) {
  const path = id ? "speedtests/batch/" + encodeURIComponent(id) : "speedtests/batch";
  return (await request<{ data: SpeedBatch | null }>(path)).data;
}

export async function operationalFailoverPreflight(nodeId: string, target: "primary" | "backup") {
  return (await request<{ data: FailoverPreflight }>("failover/preflight/" + encodeURIComponent(nodeId) + "?target=" + target)).data;
}



export async function connectV2BoardAdmin(input: { address: string; email: string; password: string }) {
  const { data } = await request<{ data: { count: number } }>("providers/v2board/connect", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  await syncBackend();
  return data;
}

type SshTestInput = { ip: string; username: string; port: number; fingerprint: string } &
  ({ method: "password"; password: string } | { method: "key"; privateKey: string; passphrase?: string });

export async function testSshConnection(serverId: string, input: SshTestInput) {
  return request("servers/" + encodeURIComponent(serverId) + "/ssh-test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export async function getSshSettings(serverId: string) {
  return (await request<{ data: { available: boolean; installEnabled: boolean; connection: {
    ip: string; username: string; port: number; fingerprint: string; method: "password" | "key";
  } | null } }>("servers/" + encodeURIComponent(serverId) + "/ssh")).data;
}

export async function getPanelSshPublicKey() {
  return (await request<{ data: { publicKey: string } }>("servers/panel-ssh-key", { method: "POST" })).data.publicKey;
}

export async function revealServerSshPassword(serverId: string) {
  return (await request<{ data: { password: string } }>("servers/" + encodeURIComponent(serverId) + "/ssh-password", {
    method: "POST",
  })).data.password;
}

export async function saveSshSettings(serverId: string, input: SshTestInput) {
  return request("servers/" + encodeURIComponent(serverId) + "/ssh", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export async function removeSshSettings(serverId: string) {
  return request("servers/" + encodeURIComponent(serverId) + "/ssh", { method: "DELETE" });
}

type AgentInstallResult = { installed: boolean; reporting: boolean; serverId: string };

type GmailSettings = { sender?: string; recipient?: string; history: { status: string; createdAt: number }[] };
export async function getGmailSettings() {
  return (await request<{ data: GmailSettings }>("notifications/gmail")).data;
}
export async function saveGmailSettings(input: { sender: string; recipient: string; appPassword: string }) {
  return (await request<{ data: GmailSettings }>("notifications/gmail", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })).data;
}

export async function sshInstallAgent(serverId: string) {
  return (await request<{ data: AgentInstallResult }>("servers/" + encodeURIComponent(serverId) + "/ssh-install-agent", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).data;
}

export async function getV2bxRestart(serverId: string, reinstall = false) {
  return (await request<{ data: { ready: boolean; job: ProvisionJob | null } }>(
    "servers/" + encodeURIComponent(serverId) + (reinstall ? "/v2bx-reinstall" : "/v2bx-restart"))).data;
}

export async function getV2bxRemove(serverId: string, panelNode: string) {
  return (await request<{ data: { ready: boolean; job: ProvisionJob | null } }>(
    "servers/" + encodeURIComponent(serverId) + "/v2bx-remove?panelNode=" + encodeURIComponent(panelNode))).data;
}

export async function removeV2bx(serverId: string, panelNode: string) {
  return (await request<{ data: ProvisionJob }>("servers/" + encodeURIComponent(serverId) + "/v2bx-remove", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ panelNode }),
  })).data;
}

export async function restartV2bx(serverId: string, reinstall = false) {
  return (await request<{ data: ProvisionJob }>("servers/" + encodeURIComponent(serverId) + (reinstall ? "/v2bx-reinstall" : "/v2bx-restart"), {
    method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
  })).data;
}

export async function getBbrStatus(serverId: string) {
  return (await request<{ data: { ready: boolean; job: ProvisionJob | null } }>(
    "servers/" + encodeURIComponent(serverId) + "/bbr")).data;
}

export async function getRebootStatus(serverId: string) {
  return (await request<{ data: { ready: boolean; job: ProvisionJob | null } }>(
    "servers/" + encodeURIComponent(serverId) + "/reboot")).data;
}

export async function rebootServer(serverId: string) {
  return (await request<{ data: ProvisionJob }>("servers/" + encodeURIComponent(serverId) + "/reboot", {
    method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
  })).data;
}

export async function enableBbr(serverId: string) {
  return (await request<{ data: ProvisionJob }>("servers/" + encodeURIComponent(serverId) + "/bbr", {
    method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
  })).data;
}

export async function sshRegisterAndInstallAgent(input: {
  publicIpv4: string; sshUsername: string; sshPort: number; password: string; fingerprint?: string;
}) {
  return (await request<{ data: AgentInstallResult }>("provision/ssh-install-agent", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })).data;
}

export async function getV2bxFiles(id: string) {
  return (await request<{ data: import("@/lib/v2bx-files").V2bxFiles }>(`servers/${encodeURIComponent(id)}/v2bx-files`)).data;
}
export async function getGlobalV2bxFiles() {
  return (await request<{ data: import("@/lib/v2bx-files").V2bxFiles }>("settings/v2bx-files")).data;
}
export async function saveGlobalV2bxFiles(files: import("@/lib/v2bx-files").V2bxFiles) {
  return (await request<{ data: import("@/lib/v2bx-files").V2bxFiles }>("settings/v2bx-files", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(files),
  })).data;
}
export async function applyGlobalV2bxFiles(serverId: string, files: import("@/lib/v2bx-files").V2bxFiles) {
  return request("settings/v2bx-files/apply", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...files, serverId }),
  });
}
export async function saveV2bxFiles(id: string, files: import("@/lib/v2bx-files").V2bxFiles, apply: boolean) {
  return (await request<{ data: import("@/lib/v2bx-files").V2bxFiles }>(`servers/${encodeURIComponent(id)}/v2bx-files`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...files, apply }),
  })).data;
}

export async function deployWithAgent(input: { kind: "v2bx"; serverId: string; architecture: "amd64" | "arm64"; config?: string; panelNode?: string; secondPanelNode?: string; applyFiles?: boolean } |
  { kind: "tunnel"; tunnelId: string; iranPort?: number; foreignPort?: number; gostArchitecture?: "amd64" | "arm64"; operation?: "rebuild" }, key: string) {
  return request("provision/deploy", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input),
  });
}

export async function getForwarderSettings(id: string) {
  return (await request<{ data: { saved: boolean; settings: import("@/lib/forwarder-config").ForwarderSettings } }>(`tunnels/${encodeURIComponent(id)}/forwarder-settings`)).data;
}
export async function saveGreTransport(id: string, transport: "native" | "udp") {
  return request(`tunnels/${encodeURIComponent(id)}/gre-transport`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transport }),
  });
}
export async function saveForwarderSettings(id: string, settings: import("@/lib/forwarder-config").ForwarderSettings) {
  return request(`tunnels/${encodeURIComponent(id)}/forwarder-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
}
export async function generateForwarderNoiseKeys(id: string) {
  return (await request<{ data: { privateKey: string; publicKey: string } }>(`tunnels/${encodeURIComponent(id)}/noise-keys`, { method: "POST" })).data;
}
export async function generateForwarderCertificate(id: string, hostname: string, days: number) {
  return (await request<{ data: { hostname: string; password: string; certificate: { name: string; content: string }; key: { name: string; content: string }; identity: { name: string; content: string } } }>(`tunnels/${encodeURIComponent(id)}/tls-certificate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname, days }) })).data;
}
export async function controlForwarderService(id: string, action: "start" | "stop" | "restart", side: "iran" | "foreign" | "both") {
  return request(`tunnels/${encodeURIComponent(id)}/service-control`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action, side }) });
}

export async function listV2BoardNodes() {
  return (await request<{ data: V2BoardCatalog }>("providers/v2board/catalog")).data;
}

export async function listV2BoardAdminNodes() {
  return (await request<{ data: PanelAdminNodes }>("providers/v2board/nodes")).data;
}

export async function changeV2BoardNode(input: { type: PanelNodeType; id: number; revision: string; show?: boolean }) {
  return request("providers/v2board/nodes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export async function saveV2BoardNode(input: { type: PanelNodeType; id?: number; revision?: string; fields: Record<string, unknown> }) {
  return request("providers/v2board/nodes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

type DnsZoneList = { provider: DnsProvider; connected: boolean; zones?: ManagedDnsZone[]; syncedAt?: string }[];

export async function listManagedDomains() {
  return (await request<{ data: DnsZoneList }>("domains")).data;
}

export async function syncManagedDomains() {
  return (await request<{ data: { providers: DnsZoneList; errors: Partial<Record<DnsProvider, string>> } }>("domains", { method: "POST" })).data;
}

export async function listManagedDnsRecords(zone: ManagedDnsZone) {
  return (await request<{ data: ManagedDnsRecord[] }>(`domains/${zone.provider}/${encodeURIComponent(zone.id)}/records`)).data;
}

export async function saveManagedDnsRecord(zone: ManagedDnsZone, input: DnsRecordInput) {
  return (await request<{ data: ManagedDnsRecord }>(`domains/${zone.provider}/${encodeURIComponent(zone.id)}/records`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })).data;
}

export async function listDnsProviderSettings() {
  return (await request<{ data: { canStore: boolean; providers: { provider: DnsProvider; connected: boolean }[] } }>("providers/dns-settings")).data;
}

export async function connectDnsProvider(provider: DnsProvider, token: string) {
  return (await request<{ data: { count: number } }>(`providers/dns-settings/${provider}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
  })).data;
}

export async function importV2BoardNode(input: { key: string; fingerprint: string; domain: string; primaryTunnelId: string }) {
  await request("providers/v2board/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  await syncBackend();
}

export async function listTunnelDeployments(tunnelId?: string, signal?: AbortSignal) {
  const path = tunnelId ? `provision/tunnels?tunnelId=${encodeURIComponent(tunnelId)}` : "provision/tunnels";
  return (await request<{ data: { enabled: boolean; sshInstallEnabled: boolean; hasManagedInstall: boolean;
    forwarding?: { port?: number; targetPort?: number; error?: string; panel?: boolean }; previews: TunnelDeploymentPreview[]; deployments: TunnelDeployment[] } }>(path, { signal })).data;
}

export async function queueTunnelDeployment(input: { tunnelId: string; fingerprint: string; operation?: "rebuild" } | { tunnelId: string; operation: "destroy" }) {
  return request<{ data: { deployment: TunnelDeployment; replay: boolean } }>("provision/tunnels", { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(input) });
}

async function waitUntilTunnelDestroyed(tunnelId: string, runId: string) {
  const deadline = Date.now() + 12 * 60000;
  for (;;) {
    const current = (await listTunnelDeployments(tunnelId)).deployments.find(({ id }) => id === runId);
    if (current?.status === "destroyed") return;
    if (!current || ["review", "failed", "rolled_back"].includes(current.status) || Date.now() >= deadline) {
      throw new Error(t("errors.tunnelCleanupUnconfirmed"));
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

export async function deleteTunnelFromInventory(tunnelId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data } = await request<{ data: { removed: boolean; deployment?: TunnelDeployment } }>(`tunnels/${encodeURIComponent(tunnelId)}`, { method: "DELETE" });
    if (!data.deployment) {
      await syncBackend();
      return;
    }
    await waitUntilTunnelDestroyed(tunnelId, data.deployment.id);
  }
  throw new Error(t("errors.tunnelCleanupUnconfirmed"));
}

export async function deleteInventoryServer(serverId: string, tunnelIds: string[]) {
  for (const tunnelId of tunnelIds) {
    const listing = await listTunnelDeployments(tunnelId);
    if (!listing.hasManagedInstall) continue;
    const active = listing.deployments.find((run) => run.preview.tunnelId === tunnelId && run.operation === "destroy" && run.status === "rolling_back");
    const run = active ?? (await queueTunnelDeployment({ tunnelId, operation: "destroy" })).data.deployment;
    await waitUntilTunnelDestroyed(tunnelId, run.id);
  }
  await request(`servers/${encodeURIComponent(serverId)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tunnelIds }) });
  await syncBackend();
}

export async function manageTunnelDeployment({ id, action }: { id: string; action: "rollback" | "review" }) {
  return request("provision/tunnels/" + encodeURIComponent(id) + "/" + action, { method: "POST" });
}

export async function previewProvisionCatalog(enrollment: unknown) {
  return (await request<{ data: ProvisionCatalogPreview }>("provision/catalog/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(enrollment),
  })).data;
}

export async function importProvisionCatalog(enrollment: unknown, fingerprint: string) {
  return (await request<{ data: { addedProfiles: number; updatedTunnels: number; replay: boolean } }>("provision/catalog/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollment, fingerprint }),
  })).data;
}

export async function listProvisionJobs() {
  return (await request<{ data: { enabled: boolean; sshInstallEnabled: boolean; profiles: ProvisionProfile[]; jobs: ProvisionJob[] } }>("provision/jobs")).data;
}

export async function uploadProvisionArtifacts(serverId: string, profileId: string, files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return request(`provision/profiles/${encodeURIComponent(serverId)}/${encodeURIComponent(profileId)}/artifacts`, { method: "POST", body: form });
}

export async function queueProvisionJob(input: { operation: "apply"; serverId: string; profileId: string; sha256: string } |
  { operation: "rollback"; jobId: string }) {
  return request("provision/jobs", { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(input) });
}

export async function reviewProvisionJob(id: string) {
  return request("provision/jobs/" + encodeURIComponent(id) + "/review", { method: "POST" });
}

export async function listTelegramDeliveries() {
  type Item = { id: string; alertId: string | null; status: string; attempts: number; createdAt: number; detail: string | null };
  return (await request<{ data: { enabled: boolean; history: Item[] } }>("notifications/telegram")).data;
}

export async function getTelegramConfig() {
  return (await request<{ data: { configured: boolean; adminId?: string; botId?: string } }>("notifications/telegram/config")).data;
}

export async function updateTelegramConfig(input: { token: string; adminId: string; botId: string }) {
  return request("notifications/telegram/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export async function queueTelegramDelivery() {
  return (await request<{ data: { status: string; detail: string | null } }>("notifications/telegram/test", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } })).data;
}

export async function listOperationalFailovers() {
  return request<{ data: OperationalFailoverPlan[]; executionEnabled: boolean }>("failover/plans");
}

export async function prepareOperationalFailover({ nodeId, target, key }: { nodeId: string; target: "primary" | "backup"; key: string }) {
  return (await request<{ data: { plan: OperationalFailoverPlan } }>("failover/plans", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ nodeId, target }),
  })).data.plan;
}

export async function progressOperationalFailover({ id, action }: { id: string; action: "execute" | "advance" | "rollback" | "reconcile" }) {
  return (await request<{ data: FailoverExecution }>("failover/plans/" + encodeURIComponent(id) + "/" + action, {
    method: "POST",
  })).data;
}

export async function decideOperationalFailover({ id, decision }: { id: string; decision: "approve" | "reject" }) {
  return (await request<{ data: OperationalFailoverPlan }>("failover/plans/" + encodeURIComponent(id) + "/decision", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
  })).data;
}

export async function getPanelOnlineSnapshot() {
  return (await request<{ data: { nodes: { key: string; name: string; online?: number; parentKey?: string }[]; fetchedAt: string } }>("providers/v2board/online")).data;
}
export async function getIranBandwidth(range: TimeRange) {
  return (await request<{ data: { ts: number; label: string; bandwidth: number | null }[] }>("metrics/iran-bandwidth?" + new URLSearchParams({ range }))).data;
}

export async function setTunnelDns(tunnelId: string) {
  const result = await request<{ data: { status: "matched" | "created" | "updated"; domain: string; ip: string } }>(
    `tunnels/${encodeURIComponent(tunnelId)}/dns`, { method: "POST" });
  await syncBackend();
  return result.data;
}

export type VirtualizorSettingsData = { endpoint: string; configured: boolean; storageEnabled: boolean };
export type VirtualizorServerData = { configured: boolean; vpsId: string; info: null | { vpsId: string; status: string; hostname?: string; virtualization?: string; ip?: string; os?: string; cpuCores?: string; ramMb?: string; diskGb?: string; bandwidthGb?: string } };
export async function getVirtualizorSettings() { return (await request<{ data: VirtualizorSettingsData }>("settings/virtualizor")).data; }
export async function saveVirtualizorSettings(input: { endpoint: string; apiKey: string; apiPassword: string }) { return (await request<{ data: VirtualizorSettingsData }>("settings/virtualizor", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).data; }
export async function getServerVirtualizor(id: string) { return (await request<{ data: VirtualizorServerData }>(`servers/${encodeURIComponent(id)}/virtualizor`)).data; }
export async function bindServerVirtualizor(id: string, vpsId: string) { return (await request<{ data: VirtualizorServerData }>(`servers/${encodeURIComponent(id)}/virtualizor`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vpsId }) })).data; }
export async function unbindServerVirtualizor(id: string) { return (await request<{ data: VirtualizorServerData }>(`servers/${encodeURIComponent(id)}/virtualizor`, { method: "DELETE" })).data; }
export async function controlServerVirtualizor(id: string, action: string) { return request(`servers/${encodeURIComponent(id)}/virtualizor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); }
