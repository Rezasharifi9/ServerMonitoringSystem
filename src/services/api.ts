import { assessNode } from "@/lib/health";
import { buildMetrics } from "@/lib/metrics";
import { delay } from "@/lib/utils";
import { useInfraStore } from "@/stores/infra-store";
import { infraAction } from "@/services/backend";
import type { TimeRange } from "@/types";

/** Mock service boundary. UI workflows call these functions; a backend can replace the bodies later. */

export async function getNodes() {
  await delay(250);
  return useInfraStore.getState().nodes;
}

export async function getNodeById(id: string) {
  await delay(200);
  return useInfraStore.getState().nodes.find((node) => node.id === id) ?? null;
}

export async function getServers() {
  await delay(250);
  return useInfraStore.getState().servers;
}

export async function getTunnels() {
  await delay(250);
  return useInfraStore.getState().tunnels;
}

export async function getMetrics(filters: { range: TimeRange; stress?: number; seed?: string }) {
  await delay(180);
  return buildMetrics(filters.range, filters.seed ?? "fleet", filters.stress ?? 0);
}

export async function getNodeHealth(id: string) {
  await delay(200);
  const state = useInfraStore.getState();
  const node = state.nodes.find((item) => item.id === id);
  if (!node) return null;
  return assessNode(node, state.servers, state.tunnels, state.dns, state.settings);
}

export async function getLogs(filters?: { nodeId?: string; serverId?: string; severity?: string; q?: string; minutes?: number }) {
  await delay(220);
  const now = Date.now();
  const minutes = filters?.minutes ?? 10;
  return useInfraStore.getState().logs.filter((log) => {
    if (filters?.nodeId && log.nodeId !== filters.nodeId) return false;
    if (filters?.serverId && log.serverId !== filters.serverId) return false;
    if (filters?.severity && log.severity !== filters.severity) return false;
    if (filters?.q && !log.message.toLowerCase().includes(filters.q.toLowerCase())) return false;
    if (now - new Date(log.ts).getTime() > minutes * 60 * 1000) return false;
    return true;
  });
}

export async function getDNSRecords(nodeId?: string) {
  await delay(200);
  const records = useInfraStore.getState().dns;
  return nodeId ? records.filter((record) => record.nodeId === nodeId) : records;
}

export async function runSpeedtest(config: Parameters<ReturnType<typeof useInfraStore.getState>["startSpeedtest"]>[0]) {
  await delay(120);
  return infraAction("startSpeedtest", config);
}

export async function simulateFailover(nodeId: string, scenario: Parameters<ReturnType<typeof useInfraStore.getState>["simulateFailover"]>[1]) {
  await delay(80);
  return infraAction("simulateFailover", nodeId, scenario);
}

export async function rollbackFailover(nodeId: string) {
  await delay(80);
  return infraAction("rollbackFailover", nodeId);
}

export async function createDeploymentJob(config: Parameters<ReturnType<typeof useInfraStore.getState>["createDeployment"]>[0]) {
  await delay(80);
  return infraAction("createDeployment", config);
}

export async function getIncidents() {
  await delay(180);
  return useInfraStore.getState().incidents;
}

export async function getAuditEvents() {
  await delay(180);
  return useInfraStore.getState().audit;
}
