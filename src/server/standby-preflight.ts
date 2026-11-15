import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProvisionProfile } from "@/types";
import { activeServerId } from "@/lib/health";
import { automaticFailoverEnabled, enrolledRecord } from "./cloudflare-failover";
import { readWorkspace } from "./database";
import { checkFailover } from "./failover-preflight";
import { ApiError } from "./http";

const id = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i);

export function standbyEnrollment(nodeId: string) {
  if (!automaticFailoverEnabled() || process.env.NODEGUARD_ENABLE_AUTO_STANDBY !== "1") return undefined;
  try {
    const map = z.record(id, id).parse(JSON.parse(process.env.NODEGUARD_AUTO_STANDBY_TUNNELS ?? "{}"));
    return Object.hasOwn(map, nodeId) ? map[nodeId] : undefined;
  } catch {
    throw new ApiError(503, "STANDBY_CONFIG", "نگاشت آماده‌سازی پشتیبان معتبر نیست.");
  }
}

export function standbyPreflight(db: DatabaseSync, nodeId: string, now: number) {
  const tunnelId = standbyEnrollment(nodeId);
  if (!tunnelId) return;
  const { state } = readWorkspace(db);
  const node = state.nodes.find((item) => item.id === nodeId);
  const policy = state.policies.find((item) => item.nodeId === nodeId);
  if (!node || !policy?.autoEnabled || node.activeSide !== "primary" || node.backupTunnelId !== tunnelId) return;
  const last = db.prepare(`SELECT status FROM tunnel_deployments WHERE tunnel_id=? AND status IN ('destroyed','succeeded')
    ORDER BY rowid DESC LIMIT 1`).get(tunnelId);
  if (last?.status === "destroyed") return;

  const { result, sourceRecoveryConfirmations } = checkFailover(nodeId, "backup", db, now);
  const tunnel = state.tunnels.find((item) => item.id === tunnelId);
  const receiverUsed = state.nodes.some((item) => activeServerId(item) === node.backupServerId || item.foreignServerId === node.backupServerId);
  const recovered = sourceRecoveryConfirmations >= result.requiredConfirmations;
  const repairable = Boolean(!recovered && tunnel && tunnel.side === "backup" && tunnel.iranEndpoint.serverId === node.backupServerId &&
    tunnel.foreignEndpoint.serverId === node.foreignServerId && !receiverUsed &&
    result.failureConfirmations >= result.requiredConfirmations && !result.checks.find((check) => check.code === "tunnel")?.ok &&
    !result.checks.find((check) => check.code === "probes")?.ok &&
    result.checks.every((check) => check.ok || ["tunnel", "probes", "standby-repair"].includes(check.code)));
  return { tunnelId, repairable, recovered };
}

export function stagedForeignJob(db: DatabaseSync, profile: ProvisionProfile) {
  const installed = db.prepare(`
    SELECT p.id, json_extract(p.profile,'$.sha256') AS sha256,
      EXISTS (SELECT 1 FROM provision_jobs r WHERE r.rollback_of=p.id AND r.status='succeeded' AND coalesce(r.operation,'rollback') IN ('rollback','remove')) AS restored
    FROM provision_jobs p WHERE p.server_id=? AND p.status='succeeded' AND p.rollback_of IS NULL
      AND json_extract(p.profile,'$.id')=?
    ORDER BY p.rowid DESC LIMIT 1
  `).get(profile.serverId, profile.id);
  return installed?.sha256 === profile.sha256 && installed.restored === 0 ? installed.id : undefined;
}

export function validateStandbyClaim(db: DatabaseSync, nodeId: string, tunnelId: string, foreign: ProvisionProfile, foreignJobId: string, now: number) {
  enrolledRecord(nodeId);
  const current = standbyPreflight(db, nodeId, now);
  if (!current?.repairable || current.tunnelId !== tunnelId || stagedForeignJob(db, foreign) !== foreignJobId) {
    throw new ApiError(409, "STANDBY_PREFLIGHT", "شواهد قطعی یا نصب سمت خارج برای آماده‌سازی پشتیبان معتبر نیست.");
  }
}
