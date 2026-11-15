import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialSnapshot, workspaceMode } from "./inventory";
import { storeActivity } from "./activity-log";
import { storeMonitorLogs } from "./log-storage";
import { telemetryIntervals } from "@/lib/telemetry-policy";
import { configuredAlert } from "@/lib/configured-alerts";
import type { DemoSnapshot, FailoverRun, SpeedtestResult, SpeedtestRun } from "@/types";

export type Workspace = DemoSnapshot & {
  failoverRun: FailoverRun | null;
  speedtestRun: SpeedtestRun | null;
  pendingSpeedtest?: { result: SpeedtestResult; actor: string } | null;
};

const databases = new Map<string, DatabaseSync>();

export function database() {
  const mode = workspaceMode();
  const file = resolve(/*turbopackIgnore: true*/ process.env.NODEGUARD_DB_PATH || ".nodeguard/" + mode + ".sqlite");
  const cached = databases.get(file);
  if (cached) return cached;

  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_live (
        collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS inventory_server_keys (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS panel_node_keys (reference TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS server_panel_nodes (
        server_id TEXT NOT NULL REFERENCES inventory_server_keys(id) ON DELETE CASCADE,
        node_reference TEXT NOT NULL REFERENCES panel_node_keys(reference),
        PRIMARY KEY (server_id, node_reference)
      );
      CREATE TABLE IF NOT EXISTS action_receipts (
        actor TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (actor, key)
      );
      CREATE TABLE IF NOT EXISTS agent_reports (
        server_id TEXT NOT NULL,
        id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (server_id, id)
      );
      CREATE INDEX IF NOT EXISTS agent_reports_time ON agent_reports(server_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS telemetry_history (
        server_id TEXT NOT NULL, observed_at INTEGER NOT NULL, step_ms INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(server_id,observed_at,step_ms)
      );
      CREATE INDEX IF NOT EXISTS telemetry_history_time ON telemetry_history(observed_at);
      CREATE VIEW IF NOT EXISTS historical_reports AS
        SELECT server_id,observed_at,payload FROM agent_reports
        UNION ALL SELECT server_id,observed_at,payload FROM telemetry_history;
      CREATE TABLE IF NOT EXISTS telemetry_cadence (
        server_id TEXT NOT NULL, stream TEXT NOT NULL, observed_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, stream)
      );
      CREATE TABLE IF NOT EXISTS metric_alert_cooldowns (
        rule_id TEXT PRIMARY KEY, emitted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tunnel_probe_requests (
        tunnel_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, server_id TEXT NOT NULL, requested_at INTEGER NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_worker_polls (
        server_id TEXT NOT NULL, kind TEXT NOT NULL, last_seen INTEGER NOT NULL, can_remove INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, kind)
      );
      CREATE INDEX IF NOT EXISTS agent_reports_retention ON agent_reports(observed_at);
      CREATE TABLE IF NOT EXISTS monitor_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts_ms INTEGER NOT NULL,
        server_id TEXT,
        node_id TEXT,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        searchable TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS monitor_logs_time ON monitor_logs(ts_ms DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS monitor_logs_node ON monitor_logs(node_id, ts_ms DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS monitor_logs_server ON monitor_logs(server_id, ts_ms DESC, seq DESC);
      CREATE TABLE IF NOT EXISTS monitor_log_events (id TEXT PRIMARY KEY, ts_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS monitor_log_events_time ON monitor_log_events(ts_ms);
      CREATE TABLE IF NOT EXISTS activity_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts_ms INTEGER NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        target TEXT NOT NULL,
        server_id TEXT,
        node_id TEXT,
        tunnel_id TEXT,
        outcome TEXT NOT NULL,
        searchable TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_logs_time ON activity_logs(ts_ms DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS activity_logs_category ON activity_logs(category, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS activity_logs_server ON activity_logs(server_id, ts_ms DESC);
      CREATE TABLE IF NOT EXISTS provision_profiles (
        server_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (server_id, profile_id)
      );
      CREATE TABLE IF NOT EXISTS provision_tunnel_bindings (
        tunnel_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retired_tunnel_sources (
        tunnel_id TEXT NOT NULL, server_id TEXT NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY (tunnel_id, server_id)
      );
      CREATE TABLE IF NOT EXISTS tunnel_reinstall_jobs (
        tunnel_id TEXT NOT NULL, iran_id TEXT NOT NULL, foreign_id TEXT NOT NULL,
        job_id TEXT NOT NULL, phase TEXT NOT NULL,
        PRIMARY KEY (tunnel_id, iran_id, foreign_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS provision_jobs (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        server_id TEXT NOT NULL, profile TEXT NOT NULL, rollback_of TEXT, status TEXT NOT NULL, detail TEXT NOT NULL,
        created_at INTEGER NOT NULL, queue_until INTEGER NOT NULL, lease_digest TEXT, lease_until INTEGER,
        finish_digest TEXT, operation TEXT, UNIQUE(actor_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS provision_jobs_host ON provision_jobs(server_id, status);
      CREATE TABLE IF NOT EXISTS provision_progress (
        job_id TEXT NOT NULL REFERENCES provision_jobs(id), step TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (job_id, step)
      );
      CREATE TABLE IF NOT EXISTS tunnel_deployments (
        id TEXT PRIMARY KEY, tunnel_id TEXT NOT NULL, iran_id TEXT NOT NULL, foreign_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, request_key TEXT NOT NULL, preview TEXT NOT NULL,
        status TEXT NOT NULL, phase TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL,
        verify_from INTEGER, verify_until INTEGER, verification_baseline INTEGER, verified_at INTEGER, cleanup TEXT,
        UNIQUE(actor_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS tunnel_deployments_active ON tunnel_deployments(status, iran_id, foreign_id);
      CREATE TABLE IF NOT EXISTS tunnel_activations (
        deployment_id TEXT PRIMARY KEY REFERENCES tunnel_deployments(id) ON DELETE CASCADE,
        status TEXT NOT NULL, lease_until INTEGER, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS tunnel_deployment_steps (
        deployment_id TEXT NOT NULL REFERENCES tunnel_deployments(id),
        phase TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES provision_jobs(id),
        PRIMARY KEY (deployment_id, phase)
      );
      CREATE TABLE IF NOT EXISTS failover_standby_repairs (
        deployment_id TEXT PRIMARY KEY REFERENCES tunnel_deployments(id),
        node_id TEXT NOT NULL,
        foreign_job_id TEXT NOT NULL REFERENCES provision_jobs(id),
        cleared_at INTEGER,
        invalidated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS failover_standby_node ON failover_standby_repairs(node_id, cleared_at);
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, alert_id TEXT, text TEXT NOT NULL,
        recipient TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, due_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, last_attempt INTEGER, message_id INTEGER, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS telegram_pending ON telegram_outbox(status, due_at);
      CREATE TABLE IF NOT EXISTS email_outbox (
        alert_id TEXT PRIMARY KEY, destination TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, attempted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS email_pending ON email_outbox(status, created_at);
      CREATE TABLE IF NOT EXISTS failover_executions (
        plan_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        record_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        verify_policy TEXT NOT NULL,
        before_record TEXT,
        applied_record TEXT,
        attempted_at INTEGER,
        rollback_at INTEGER,
        verify_after INTEGER,
        verify_until INTEGER,
        lease TEXT,
        lease_until INTEGER
      );
      CREATE INDEX IF NOT EXISTS failover_execution_domain ON failover_executions(domain, record_id, status);
      CREATE INDEX IF NOT EXISTS failover_execution_history ON failover_executions(updated_at DESC)
        WHERE status IN ('succeeded','rolled_back','aborted');
      CREATE TABLE IF NOT EXISTS dns_monitor_schedule (
        node_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        retry_at INTEGER NOT NULL,
        lease TEXT,
        lease_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS failover_plans (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        state_fingerprint TEXT NOT NULL,
        preflight TEXT NOT NULL,
        second_actor INTEGER NOT NULL,
        automatic INTEGER NOT NULL DEFAULT 0,
        decided_at INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_by TEXT,
        UNIQUE(actor_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS failover_plans_history ON failover_plans(created_at DESC);
      CREATE TABLE IF NOT EXISTS iperf_jobs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        source_id TEXT NOT NULL,
        dest_id TEXT NOT NULL,
        config TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        queue_until INTEGER NOT NULL,
        started_at INTEGER,
        lease_until INTEGER,
        lease_digest TEXT,
        finished_at INTEGER,
        finish_fingerprint TEXT,
        result TEXT,
        error TEXT,
        UNIQUE(actor_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS iperf_jobs_active ON iperf_jobs(status, source_id, dest_id);
      CREATE INDEX IF NOT EXISTS iperf_jobs_history ON iperf_jobs(created_at DESC);
      CREATE TABLE IF NOT EXISTS v2board_bindings (
        panel_key TEXT PRIMARY KEY, node_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS v2board_sync (
        singleton INTEGER PRIMARY KEY CHECK (singleton=1),
        lease TEXT,
        lease_until INTEGER,
        attempted_at INTEGER NOT NULL,
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS v2bx_install_nodes (
        server_id TEXT NOT NULL, reference TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(server_id, reference, job_id)
      );
      CREATE TABLE IF NOT EXISTS agent_update_jobs (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, server_id TEXT NOT NULL, actor TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', reporting INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
        UNIQUE(batch_id, server_id)
      );
      CREATE INDEX IF NOT EXISTS agent_update_status ON agent_update_jobs(status, lease_until);
      CREATE TABLE IF NOT EXISTS ssh_operation_leases (
        server_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_credentials (
        provider TEXT PRIMARY KEY,
        sealed TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_cache (
        provider TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topology_registrations (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS agent_credentials (
        server_id TEXT PRIMARY KEY,
        credential_digest TEXT UNIQUE,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_invitations (
        server_id TEXT PRIMARY KEY,
        code_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS admin_login_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        failures INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_password (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        source_digest TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_passkeys (
        id TEXT PRIMARY KEY,
        account_digest TEXT NOT NULL,
        name TEXT NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_passkey_challenges_used (
        challenge TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        digest TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        credential_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS speed_batches (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS speed_batch_targets (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        spec TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        position INTEGER NOT NULL,
        lease_until INTEGER,
        finished_at INTEGER,
        pings TEXT,
        bandwidth_mbps REAL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS speed_batch_targets_server ON speed_batch_targets(server_id, status, created_at);
      CREATE INDEX IF NOT EXISTS speed_batch_targets_batch ON speed_batch_targets(batch_id, position);
    `);
    db.exec("BEGIN IMMEDIATE");
    const existing = db.prepare("SELECT value FROM workspace_meta WHERE key = 'mode'").get();
    const seeded = db.prepare("SELECT 1 FROM workspace WHERE singleton = 1").get();
    if ((existing && existing.value !== mode) || (!existing && seeded && mode !== "simulation")) {
      throw new Error("Use a different database file for each workspace mode");
    }
    if (!seeded) {
      const state: Workspace = { ...initialSnapshot(), failoverRun: null, speedtestRun: null };
      db.prepare("INSERT INTO workspace VALUES (1, 0, ?)").run(JSON.stringify(state));
    }
    if (mode === "monitor" && !db.prepare("SELECT 1 FROM workspace_meta WHERE key='tunnel_domains_removed_v1'").get()) {
      const { state, revision } = readWorkspace(db);
      writeWorkspace(db, state, revision + 1);
      db.prepare("INSERT INTO workspace_meta VALUES ('tunnel_domains_removed_v1', '1')").run();
    }
    if (mode === "monitor" && !db.prepare("SELECT 1 FROM workspace_meta WHERE key='monitor_logs_v1'").get()) {
      const { state, revision } = readWorkspace(db);
      if (state.logs.length) {
        storeMonitorLogs(db, state.logs);
        state.logs = [];
        writeWorkspace(db, state, revision + 1);
      }
      db.prepare("INSERT INTO workspace_meta VALUES ('monitor_logs_v1', '1')").run();
    }
    const planColumns = new Set(db.prepare("PRAGMA table_info(failover_plans)").all().map((row) => row.name));
    if (!planColumns.has("automatic")) {
      db.exec("ALTER TABLE failover_plans ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0");
      db.exec("UPDATE failover_plans SET automatic=1 WHERE request_key GLOB 'auto-*' AND length(request_key)=41");
    }
    if (!planColumns.has("decided_at")) db.exec("ALTER TABLE failover_plans ADD COLUMN decided_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS failover_plans_automatic ON failover_plans(automatic, status, node_id)");
    if (!db.prepare("PRAGMA table_info(failover_standby_repairs)").all().some((column) => column.name === "invalidated_at")) {
      db.exec("ALTER TABLE failover_standby_repairs ADD COLUMN invalidated_at INTEGER");
    }
    if (!db.prepare("PRAGMA table_info(tunnel_deployments)").all().some((column) => column.name === "verified_at")) {
      db.exec("ALTER TABLE tunnel_deployments ADD COLUMN verified_at INTEGER");
    }
    if (!db.prepare("PRAGMA table_info(tunnel_deployments)").all().some((column) => column.name === "cleanup")) {
      db.exec("ALTER TABLE tunnel_deployments ADD COLUMN cleanup TEXT");
    }
    if (!db.prepare("PRAGMA table_info(provision_jobs)").all().some((column) => column.name === "operation")) {
      db.exec("ALTER TABLE provision_jobs ADD COLUMN operation TEXT");
    }
    if (!db.prepare("PRAGMA table_info(agent_worker_polls)").all().some((column) => column.name === "can_remove")) {
      db.exec("ALTER TABLE agent_worker_polls ADD COLUMN can_remove INTEGER NOT NULL DEFAULT 0");
    }
    if (!db.prepare("PRAGMA table_info(agent_worker_polls)").all().some((column) => column.name === "can_download")) {
      db.exec("ALTER TABLE agent_worker_polls ADD COLUMN can_download INTEGER NOT NULL DEFAULT 0");
    }
    if (!db.prepare("PRAGMA table_info(agent_worker_polls)").all().some((column) => column.name === "can_restart_v2bx")) {
      db.exec("ALTER TABLE agent_worker_polls ADD COLUMN can_restart_v2bx INTEGER NOT NULL DEFAULT 0");
    }
    if (!db.prepare("PRAGMA table_info(agent_worker_polls)").all().some((column) => column.name === "can_iptables")) {
      db.exec("ALTER TABLE agent_worker_polls ADD COLUMN can_iptables INTEGER NOT NULL DEFAULT 0");
    }
    if (!db.prepare("PRAGMA table_info(agent_worker_polls)").all().some((column) => column.name === "can_reboot")) {
      db.exec("ALTER TABLE agent_worker_polls ADD COLUMN can_reboot INTEGER NOT NULL DEFAULT 0");
    }
    if (!db.prepare("PRAGMA table_info(agent_worker_polls)").all().some((column) => column.name === "can_remove_v2bx")) {
      db.exec("ALTER TABLE agent_worker_polls ADD COLUMN can_remove_v2bx INTEGER NOT NULL DEFAULT 0");
    }
    const emailColumns = new Set(db.prepare("PRAGMA table_info(email_outbox)").all().map((row) => row.name));
    if (!emailColumns.has("due_at")) db.exec("ALTER TABLE email_outbox ADD COLUMN due_at INTEGER NOT NULL DEFAULT 0");
    if (!emailColumns.has("attempts")) db.exec("ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!db.prepare("SELECT 1 FROM workspace_meta WHERE key = 'activity_head'").get()) {
      const { state } = readWorkspace(db);
      storeActivity(db, state.audit, state.settings.dataRetentionDays);
      db.prepare("INSERT INTO workspace_meta VALUES ('activity_head', ?)").run(state.audit[0]?.id ?? "");
    }
    if (!db.prepare("SELECT 1 FROM workspace_meta WHERE key='server_panel_nodes_v1'").get()) {
      const { state, revision } = readWorkspace(db);
  for (const server of state.servers) {
    if (!server.roles.includes("foreign") || server.panelNodeRefs !== undefined) continue;
    const nodeIds = new Set(state.nodes.filter((node) => node.foreignServerId === server.id).map((node) => node.id));
    const refs = new Set(db.prepare("SELECT panel_key,node_id FROM v2board_bindings").all().filter((binding) => nodeIds.has(String(binding.node_id))).map((binding) => String(binding.panel_key)));
    for (const installed of db.prepare("SELECT n.reference FROM v2bx_install_nodes n JOIN provision_jobs j ON j.id=n.job_id WHERE n.server_id=? AND j.status='succeeded'").all(server.id)) refs.add(String(installed.reference));
    if (refs.size) server.panelNodeRefs = [...refs].sort();
  }
      db.prepare("UPDATE workspace SET snapshot=?,revision=? WHERE singleton=1").run(JSON.stringify(state), revision + 1);
      db.prepare("INSERT INTO workspace_meta VALUES ('server_panel_nodes_v1','1')").run();
    }
    if (!db.prepare("SELECT 1 FROM workspace_meta WHERE key='lightweight_telemetry_v1'").get()) {
      const { state, revision } = readWorkspace(db);
      if (state.settings.telemetryIntervals) {
        const intervals = { ...telemetryIntervals, ...state.settings.telemetryIntervals };
        if (intervals.logs === 10) intervals.logs = telemetryIntervals.logs;
        if (intervals.disk === 600) intervals.disk = telemetryIntervals.disk;
        state.settings.telemetryIntervals = intervals;
      }
      writeWorkspace(db, state, revision + 1);
      db.prepare("INSERT INTO workspace_meta VALUES ('lightweight_telemetry_v1','1')").run();
    }
    syncServerNodeRelations(db, readWorkspace(db).state);
    db.prepare("INSERT OR IGNORE INTO workspace_meta VALUES ('mode', ?)").run(mode);
    db.exec("COMMIT");
    databases.set(file, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function databaseLocked(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "errcode" in error ? Number(error.errcode) : NaN;
  const message = error instanceof Error ? error.message : "";
  return code === 5 || code === 6 || /database is locked|sqlite_busy|sqlite_locked/i.test(message);
}

export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = database();
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (attempt < 2 && databaseLocked(error)) continue;
      throw error;
    }
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      if (attempt < 2 && databaseLocked(error)) continue;
      throw error;
    }
  }
}

function withoutMaintenance(state: Workspace & { windows?: unknown }): Workspace {
  const { windows: _windows, ...rest } = state;
  const normalize = <T extends { status?: string; health?: string }>(item: T & { maintenance?: boolean }) => {
    const { maintenance: _maintenance, status, health, ...kept } = item;
    return {
      ...kept,
      ...(status === undefined ? {} : { status: status === "maintenance" ? "healthy" : status }),
      ...(health === undefined ? {} : { health: health === "maintenance" ? "healthy" : health }),
    } as T;
  };
  return {
    ...rest,
    servers: rest.servers.map((server) => normalize(server)),
    nodes: rest.nodes.map((node) => normalize({ ...node, tunnelIds: [...new Set([
      ...(node.tunnelIds ?? []), node.primaryTunnelId, ...(node.backupTunnelId ? [node.backupTunnelId] : []),
      ...rest.tunnels.filter((tunnel) => tunnel.nodeIds.includes(node.id) || tunnel.nodeRef?.kind === "inventory" && tunnel.nodeRef.id === node.id).map((tunnel) => tunnel.id),
    ])].filter((id) => rest.tunnels.some((tunnel) => tunnel.id === id)) })),
    tunnels: rest.tunnels.map((tunnel) => { const route: typeof tunnel & { nodeDomain?: string } = { ...tunnel }; delete route.nodeDomain; return normalize(route); }),
  };
}

export function readWorkspace(db = database()) {
  const row = db.prepare("SELECT revision, snapshot FROM workspace WHERE singleton = 1").get();
  if (!row || typeof row.snapshot !== "string") throw new Error("Missing workspace row");
  const snapshot = JSON.parse(row.snapshot);
  for (const live of db.prepare("SELECT collection,id,payload FROM workspace_live").all()) {
    const key = String(live.collection);
    const value = JSON.parse(String(live.payload));
    if (live.id === "*") snapshot[key] = value;
    else if (Array.isArray(snapshot[key])) {
      const at = snapshot[key].findIndex((item: { id: string }) => item.id === live.id);
      if (at >= 0) snapshot[key][at] = value;
    }
  }
  const state = withoutMaintenance(snapshot as Workspace & { windows?: unknown });
  if (workspaceMode() === "monitor") state.alerts = state.alerts.filter(alert => configuredAlert(alert, state.settings));
  return { revision: Number(row.revision), state };
}

function syncServerNodeRelations(db: DatabaseSync, state: Workspace) {
  const signature = JSON.stringify(state.servers.map((server) => [server.id, [...(server.panelNodeRefs ?? [])].sort()]).sort());
  if (db.prepare("SELECT value FROM workspace_meta WHERE key='server_relations_signature'").get()?.value === signature) return;
  db.exec("DELETE FROM server_panel_nodes; DELETE FROM inventory_server_keys");
  const host = db.prepare("INSERT INTO inventory_server_keys(id) VALUES (?)");
  const node = db.prepare("INSERT OR IGNORE INTO panel_node_keys(reference) VALUES (?)");
  const link = db.prepare("INSERT OR IGNORE INTO server_panel_nodes(server_id,node_reference) VALUES (?,?)");
  for (const server of state.servers) {
    host.run(server.id);
    for (const ref of server.panelNodeRefs ?? []) { node.run(ref); link.run(server.id, ref); }
  }
  db.prepare("INSERT OR REPLACE INTO workspace_meta VALUES ('server_relations_signature', ?)").run(signature);
}

/** Save only changed live entities; inventory and its relationships remain untouched. */
export function writeTelemetryWorkspace(db: DatabaseSync, before: Workspace, state: Workspace, revision: number) {
  if (workspaceMode() === "monitor") state.alerts = state.alerts.filter(alert => configuredAlert(alert, state.settings));
  const upsert = db.prepare(`INSERT INTO workspace_live VALUES (?,?,?)
    ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload`);
  for (const key of Object.keys(state) as (keyof Workspace)[]) {
    if (key === "servers" || key === "nodes" || key === "tunnels") {
      const previous = new Map(before[key].map((item) => [item.id, JSON.stringify(item)]));
      for (const item of state[key]) {
        const payload = JSON.stringify(item);
        if (previous.get(item.id) !== payload) upsert.run(key, item.id, payload);
      }
    } else if (JSON.stringify(before[key]) !== JSON.stringify(state[key])) {
      upsert.run(key, "*", JSON.stringify(state[key]));
    }
  }
  db.prepare("UPDATE workspace SET revision=? WHERE singleton=1").run(revision);
}

export function writeWorkspace(db: DatabaseSync, state: Workspace, revision: number) {
  if (workspaceMode() === "monitor") state.alerts = state.alerts.filter(alert => configuredAlert(alert, state.settings));
  syncServerNodeRelations(db, state);
  const head = state.audit[0]?.id ?? "";
  const row = db.prepare("SELECT value FROM workspace_meta WHERE key = 'activity_head'").get();
  const previous = typeof row?.value === "string" ? row.value : "";
  db.prepare("UPDATE workspace SET revision = ?, snapshot = ? WHERE singleton = 1")
    .run(revision, JSON.stringify(state));
  db.exec("DELETE FROM workspace_live");
  if (!head || head === previous) return;
  const fresh = [];
  for (const entry of state.audit) {
    if (entry.id === previous) break;
    fresh.push(entry);
  }
  storeActivity(db, fresh, state.settings.dataRetentionDays);
  db.prepare(`
    INSERT INTO workspace_meta (key, value) VALUES ('activity_head', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(head);
}
