import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decorateNodes } from "@/lib/health";
import { can } from "@/lib/rbac";
import type { AgentRegistration, DemoUser } from "@/types";
import { agentTokenReserved, digest, legacyAgentToken, matchesDigest } from "./auth";
import { database, readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";

const lifetimeMs = 15 * 60000;
const id = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i);
const secret = z.string().regex(/^[\da-f]{64}$/);
const exchange = z.object({ serverId: id, credential: secret }).strict();

function monitorOnly() {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "ثبت Agent در حالت پایش در دسترس است.");
}

function allow(actor: DemoUser, serverId: string) {
  monitorOnly();
  if (!can(actor.role, "agent.enroll")) throw new ApiError(403, "FORBIDDEN", "مدیریت اعتبارنامهٔ Agent مجاز نیست.");
  if (!id.safeParse(serverId).success) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
}

function ensureHost(state: Workspace, serverId: string) {
  if (!state.servers.some((server) => server.id === serverId)) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
}

function registration(db: DatabaseSync, serverId: string): AgentRegistration {
  const credential = db.prepare("SELECT credential_digest, updated_at FROM agent_credentials WHERE server_id = ?").get(serverId);
  const invitation = db.prepare("SELECT expires_at FROM agent_invitations WHERE server_id = ? AND used_at IS NULL AND expires_at > ?")
    .get(serverId, Date.now());
  const legacy = !credential && Boolean(legacyAgentToken(serverId));
  return {
    source: credential ? "managed" : legacy ? "environment" : "none",
    state: credential ? credential.credential_digest ? "active" : "revoked" : legacy ? "active" : "unconfigured",
    updatedAt: credential ? new Date(Number(credential.updated_at)).toISOString() : undefined,
    invitationExpiresAt: invitation ? new Date(Number(invitation.expires_at)).toISOString() : undefined,
  };
}

function audit(state: Workspace, serverId: string, action: string, detail: string, at: string, actor?: DemoUser) {
  state.audit = [{
    id: randomUUID(), at, actor: actor?.name ?? "Agent", role: actor?.role ?? ("system" as const),
    action, target: serverId, detail, simulated: false,
  }, ...state.audit].slice(0, 2000);
}

function resetHeartbeat(state: Workspace, serverId: string) {
  state.servers = state.servers.map((server) => server.id !== serverId ? server : {
    ...server, status: "offline" as const,
    agent: { ...server.agent, status: "offline" as const, lastHeartbeat: "" },
  });
  state.nodes = state.nodes.map((node) => {
    const observations = node.proxyObservationSet;
    if (!observations) return node.proxyProbe?.serverId === serverId ? { ...node, proxyProbe: undefined } : node;
    const samples = observations.samples.filter((sample) => sample.serverId !== serverId);
    return { ...node, proxyProbe: samples[0], proxyObservationSet: { ...observations, samples } };
  });
  state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
}

export function getAgentRegistration(actor: DemoUser, serverId: string) {
  allow(actor, serverId);
  const db = database();
  ensureHost(readWorkspace(db).state, serverId);
  return registration(db, serverId);
}

export function issueAgentInvitation(actor: DemoUser, serverId: string) {
  allow(actor, serverId);
  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    ensureHost(state, serverId);
    const code = randomBytes(32).toString("hex");
    const now = Date.now();
    const expires = now + lifetimeMs;
    db.prepare(`
      INSERT INTO agent_invitations (server_id, code_digest, expires_at, used_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(server_id) DO UPDATE SET code_digest = excluded.code_digest, expires_at = excluded.expires_at, used_at = NULL
    `).run(serverId, digest(code), expires);
    audit(state, serverId, "agent.invite", "کد یک‌بارمصرف برای ثبت Agent صادر شد.", new Date(now).toISOString(), actor);
    writeWorkspace(db, state, revision + 1);
    return { code, expiresAt: new Date(expires).toISOString() };
  });
}

export function redeemAgentInvitation(request: Request, input: unknown) {
  monitorOnly();
  const parsed = exchange.safeParse(input);
  if (!parsed.success) throw new ApiError(422, "AGENT_ENROLL_INPUT", "شناسهٔ سرور یا قالب اعتبارنامه معتبر نیست.");
  const { serverId, credential } = parsed.data;
  const code = /^Bearer ([\da-f]{64})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const invalid = () => new ApiError(401, "AGENT_INVITATION", "کد ثبت برای این سرور معتبر نیست یا مهلت آن گذشته است.");
  if (!code) throw invalid();
  const credentialDigest = digest(credential);

  return transaction((db) => {
    const now = Date.now();
    const invitation = db.prepare("SELECT * FROM agent_invitations WHERE server_id = ?").get(serverId);
    if (!invitation || Number(invitation.expires_at) <= now || !matchesDigest(code, invitation.code_digest)) throw invalid();
    const current = db.prepare("SELECT server_id FROM agent_credentials WHERE credential_digest = ?").get(credentialDigest);
    if (invitation.used_at !== null) {
      if (current?.server_id === serverId) return { enrolled: true, replay: true };
      throw invalid();
    }
    if (current || code === credential || agentTokenReserved(credential)) {
      throw new ApiError(409, "AGENT_CREDENTIAL_REUSE", "برای ثبت Agent یک اعتبارنامهٔ تازه و مستقل بسازید.");
    }

    const { state, revision } = readWorkspace(db);
    ensureHost(state, serverId);
    db.prepare(`
      INSERT INTO agent_credentials (server_id, credential_digest, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET credential_digest = excluded.credential_digest, updated_at = excluded.updated_at
    `).run(serverId, credentialDigest, now);
    db.prepare("UPDATE agent_invitations SET used_at = ? WHERE server_id = ?").run(now, serverId);
    db.prepare("DELETE FROM agent_worker_polls WHERE server_id = ?").run(serverId);
    resetHeartbeat(state, serverId);
    audit(state, serverId, "agent.enroll", "اعتبارنامهٔ جدید Agent ثبت شد.", new Date(now).toISOString());
    writeWorkspace(db, state, revision + 1);
    return { enrolled: true, replay: false };
  });
}

export function revokeAgentCredential(actor: DemoUser, serverId: string) {
  allow(actor, serverId);
  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    ensureHost(state, serverId);
    const current = registration(db, serverId);
    db.prepare("DELETE FROM agent_invitations WHERE server_id = ?").run(serverId);
    if (current.state === "revoked" && !current.invitationExpiresAt) return current;
    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_credentials (server_id, credential_digest, updated_at) VALUES (?, NULL, ?)
      ON CONFLICT(server_id) DO UPDATE SET credential_digest = NULL, updated_at = excluded.updated_at
    `).run(serverId, now);
    db.prepare("DELETE FROM agent_worker_polls WHERE server_id = ?").run(serverId);
    resetHeartbeat(state, serverId);
    audit(state, serverId, "agent.revoke", "اعتبارنامه و کد ثبت Agent باطل شدند.", new Date(now).toISOString(), actor);
    writeWorkspace(db, state, revision + 1);
    return registration(db, serverId);
  });
}
