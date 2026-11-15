export type HealthStatus = "healthy" | "degraded" | "offline";

export type ServerRole = "iran" | "iran-primary" | "iran-backup" | "foreign";

export type TunnelTech =
  | "GRE"
  | "IPIP"
  | "SIT"
  | "WireGuard"
  | "GOST"
  | "Backhaul"
  | "Rathole"
  | "GRE6"
  | "Geneve";

export type TunnelKind = "interface" | "forwarder";

export type Protocol = "VLESS" | "VMess" | "Trojan" | "Shadowsocks" | "Hysteria2";

export type DnsStatus =
  | "matched"
  | "mismatched"
  | "propagation"
  | "proxied"
  | "cname"
  | "stale"
  | "error";

export type FailoverState =
  | "HEALTHY"
  | "SUSPECT"
  | "CONFIRMED_DOWN"
  | "PREPARING_BACKUP"
  | "SWITCHING"
  | "VERIFYING"
  | "RECOVERED"
  | "ROLLBACK"
  | "FAILED";

export type FailoverScenario =
  | "primary-failure"
  | "tunnel-failure"
  | "v2bx-failure"
  | "dns-mismatch"
  | "backup-unavailable"
  | "validation-failed"
  | "auto-recovery";

export type DemoRole = "super-admin" | "infra-admin" | "operator" | "readonly";

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertCategory =
  | "server-offline"
  | "agent-disconnected"
  | "tunnel-disconnected"
  | "high-loss"
  | "high-rtt"
  | "high-resource"
  | "dns-mismatch"
  | "proxy-unreachable"
  | "v2bx-failure"
  | "deploy-failed"
  | "failover"
  | "backup-unavailable"
  | "tls-expiry";

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type LogSource = "v2bx-shared" | "v2bx-node" | "agent" | "tunnel";

export type TimeRange = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";

export type DeployStatus =
  | "pending"
  | "validating"
  | "installing"
  | "configuring"
  | "testing"
  | "completed"
  | "failed"
  | "rolled-back";

export type ServiceRun = "running" | "stopped" | "degraded" | "restarting";

export interface Service {
  id: string;
  name: string;
  status: ServiceRun;
  version: string;
  port?: number;
  observedAt?: string;
}

export interface NetInterface {
  name: string;
  kind: "public" | "tunnel" | "loopback";
  ipv4?: string;
  ipv6?: string;
  rxMbps: number;
  txMbps: number;
  mtu: number;
  up: boolean;
}

export interface AgentRegistration {
  source: "managed" | "environment" | "none";
  state: "active" | "revoked" | "unconfigured";
  updatedAt?: string;
  invitationExpiresAt?: string;
}

export interface AgentInvitation {
  code: string;
  expiresAt: string;
}

export interface AgentWorker {
  kind: "iperf" | "provision";
  status: "disabled" | "unseen" | "recent" | "busy" | "stale";
  lastSeen?: string;
}

export interface Agent {
  id: string;
  serverId: string;
  version: string;
  status: "online" | "offline" | "degraded";
  lastHeartbeat: string;
  capabilities: string[];
  workers?: AgentWorker[];
}

export interface Server {
  activity?: string;
  panelNodeRefs?: string[];
  id: string;
  name: string;
  region: string;
  country: string;
  countryCode: string;
  city: string;
  publicIpv4: string;
  publicIpv6?: string;
  tunnelIp: string;
  provider: string;
  os: string;
  hardware?: ServerHardware;
  sshUsername?: string;
  sshPort?: number;
  cpu: number;
  ram: number;
  disk: number;
  rxMbps: number;
  txMbps: number;
  agent: Agent;
  services: Service[];
  interfaces: NetInterface[];
  roles: ServerRole[];
  status: HealthStatus;
  uptimeSec: number;
  notes: string;
}

export interface ServerHardware {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

export interface ServerPing {
  status: "reachable" | "unreachable" | "unavailable";
  checkedAt: string;
  rttMs?: number;
}

export interface TunnelEndpoint {
  serverId: string;
  publicIp: string;
  tunnelIp?: string;
  port?: number;
  interfaceName?: string;
}

export type TunnelNodeRef = { kind: "inventory"; id: string } | { kind: "v2board"; key: string };

export interface Tunnel {
  id: string;
  name: string;
  nodeRef?: TunnelNodeRef;
  technology: TunnelTech;
  kind: TunnelKind;
  iranEndpoint: TunnelEndpoint;
  foreignEndpoint: TunnelEndpoint;
  interfaceName?: string;
  serviceName?: string;
  forwarderProbe?: { elapsedMs: number; ok: boolean };
  status: HealthStatus;
  rttMs: number;
  jitterMs: number;
  packetLoss: number;
  mtu: number;
  configuredMtu?: number;
  rxMbps: number;
  txMbps: number;
  lastCheck: string;
  uptimePct: number;
  config: Record<string, string>;
  nodeIds: string[];
  side: "primary" | "backup";
}

interface TunnelRecipeEndpoint {
  serverId: string;
  interfaceName: string;
  innerIp: string;
  outerIp: string;
}

export interface TunnelBundleRecipe {
  schema: 1;
  tunnelId: string;
  technology: "GRE" | "GRE6" | "IPIP" | "SIT" | "WireGuard" | "Geneve";
  mtu: number;
  port?: number;
  targetPort?: number;
  greTransport?: "native" | "udp";
  iran: TunnelRecipeEndpoint;
  foreign: TunnelRecipeEndpoint;
}

export interface ForwarderBundleRecipe {
  schema: 1;
  tunnelId: string;
  technology: "GOST" | "Backhaul" | "Rathole";
  port?: number;
  targetPort?: number;
  iran: Pick<TunnelRecipeEndpoint, "serverId" | "outerIp">;
  foreign: Pick<TunnelRecipeEndpoint, "serverId" | "outerIp">;
}

export interface NodeSettings {
  remark: string;
  rateLimitMbps: number;
  probeEnabled: boolean;
  alertOnLoss: boolean;
}

export interface AgentUpdateJob {
  id: string;
  serverId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  detail: string;
  reporting: boolean;
  updatedAt: string;
}

export type ProxyProbeReading = {
  serverId: string;
  observedAt: string;
  ok: boolean;
  elapsedMs?: number;
  httpStatus?: number;
};

export interface Node {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  city: string;
  protocol: Protocol;
  port: number;
  domain: string;
  primaryServerId: string;
  backupServerId?: string;
  foreignServerId: string;
  primaryTunnelId: string;
  backupTunnelId?: string;
  /** All registered routes; the scalar fields above select the failover pair. */
  tunnelIds?: string[];
  activeSide: "primary" | "backup";
  v2bxNodeState: "active" | "config-error" | "disabled";
  proxyProbe?: ProxyProbeReading;
  proxyObservationSet?: { expectedObservers: number; samples: ProxyProbeReading[] };
  failoverState: FailoverState;
  lastFailoverAt?: string;
  tags: string[];
  settings: NodeSettings;
  health: HealthStatus;
  rttMs: number;
  packetLoss: number;
  jitterMs: number;
  uptimePct: number;
  v2bxStatus: "running" | "stopped" | "degraded";
  dnsStatus: DnsStatus;
}

export interface AvailabilityCount {
  samples: number;
  successful: number;
}

export interface ObservedAvailability {
  range: TimeRange;
  since: number;
  through: number;
  proxy: AvailabilityCount;
  nodes: Partial<Record<string, AvailabilityCount>>;
  tunnels: Partial<Record<string, AvailabilityCount>>;
  series: (AvailabilityCount & { ts: number; label: string; availability: number | null })[];
}

export interface MetricPoint {
  ts: number;
  label: string;
  availability: number;
  rtt: number;
  loss: number;
  bandwidth: number;
  cpu: number;
  ram: number;
  rx: number;
  tx: number;
  diskReadMiBps?: number;
  diskWriteMiBps?: number;
  incidents: number;
  failovers: number;
}

export interface DNSResolverObservation {
  aRecords: string[];
  aaaaRecords: string[];
  cnameRecords: string[];
  ttl?: number;
  checkedAt: string;
  complete: boolean;
}

export interface DNSRecord {
  resolverOnly?: boolean;
  expectedIranIp?: string;
  provider?: "cloudflare" | "arvan";
  id: string;
  nodeId: string;
  domain: string;
  v2boardHost: string;
  v2boardIp?: string;
  v2boardObservedAt?: string;
  v2boardMissing?: boolean;
  aRecords: string[];
  aaaaRecords: string[];
  cname?: string;
  ttl: number;
  authoritativeStatus: DnsStatus;
  resolverStatus: DnsStatus;
  resolverObservation?: DNSResolverObservation;
  stale?: boolean;
  proxied: boolean;
  lastCheck: string;
  note: string;
}

export type HealthDimensionKey =
  | "agent"
  | "host"
  | "reachability"
  | "tunnel"
  | "v2bx"
  | "dns"
  | "e2e"
  | "backup";

export interface HealthDimension {
  key: HealthDimensionKey;
  status: HealthStatus;
  score: number;
  summary: string;
}

export interface HealthCheck {
  nodeId: string;
  score: number;
  status: HealthStatus;
  dimensions: HealthDimension[];
  rootCause: string;
  recommendation: string;
  checkedAt: string;
  backupReady: boolean;
}

export interface SpeedtestConfig {
  mode: "tunnel" | "internet";
  sourceServerId: string;
  destServerId?: string;
  tunnelId?: string;
  protocol: "tcp" | "udp";
  direction: "download" | "upload" | "bidirectional";
  reverse: boolean;
  durationSec: number;
  streams: number;
  bandwidthLimitMbps?: number;
  nodeId?: string;
}

export interface SpeedtestResult {
  id: string;
  createdAt: string;
  mode: "tunnel" | "internet";
  sourceServerId: string;
  destServerId?: string;
  tunnelId?: string;
  nodeId?: string;
  protocol: "tcp" | "udp";
  direction: "download" | "upload" | "bidirectional";
  reverse: boolean;
  durationSec: number;
  streams: number;
  bandwidthLimitMbps?: number;
  avgMbps: number;
  maxMbps: number;
  minMbps: number;
  rttMs: number;
  jitterMs: number;
  lossPct: number;
  samples: { t: number; mbps: number }[];
  status: "completed" | "stopped" | "failed";
}

export interface SpeedtestRun {
  config: SpeedtestConfig;
  running: boolean;
  startedAt: string;
  elapsedSec: number;
  samples: { t: number; mbps: number }[];
  currentMbps: number;
  rttMs: number;
  lossPct: number;
  jitterMs: number;
}

export interface FailoverPolicy {
  trigger?: "independent" | "server-ping" | "packet-loss" | "tunnel-ping" | "tunnel-loss";
  packetLossThreshold?: number;
  notifyTelegram?: boolean;
  nodeId: string;
  intervalSec: number;
  failureThreshold: number;
  probeTimeoutMs: number;
  minConfirmations: number;
  autoEnabled: boolean;
  manualApproval: boolean;
  cooldownSec: number;
  backupPriority: "latency" | "capacity" | "manual";
  minBackupCapacity: number;
  autoFailback: boolean;
  stabilitySec: number;
  dnsStrategy: "lowest-ttl" | "weighted" | "manual-preview";
  rollbackStrategy: "restore-primary-dns" | "keep-backup" | "freeze";
}

export type FailoverDefaults = Omit<FailoverPolicy, "nodeId">;

export interface FailoverEvent {
  id: string;
  nodeId: string;
  at: string;
  scenario: FailoverScenario | "manual" | "rollback" | "operational";
  fromServerId: string;
  toServerId: string;
  result: "success" | "failed" | "rolled-back";
  state: FailoverState;
  summary: string;
}

export interface FailoverRun {
  id: string;
  nodeId: string;
  scenario: FailoverScenario | "manual" | "rollback";
  state: FailoverState;
  running: boolean;
  log: { at: string; message: string }[];
  startedAt: string;
  error?: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: AlertSeverity;
  status: "open" | "ack" | "resolved";
  category: AlertCategory;
  nodeId?: string;
  serverId?: string;
  tunnelId?: string;
  assignee?: string;
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string;
  silencedUntil?: string;
  summary: string;
  timeline: { at: string; text: string }[];
}

export interface Alert {
  metricRuleId?: string;
  id: string;
  incidentId?: string;
  title: string;
  severity: AlertSeverity;
  category: AlertCategory;
  nodeId?: string;
  serverId?: string;
  tunnelId?: string;
  createdAt: string;
  acked: boolean;
  resolved: boolean;
  archived?: boolean;
  archivedAt?: string;
  silencedUntil?: string;
  detail: string;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DeploymentJob {
  id: string;
  createdAt: string;
  serverId: string;
  component: string;
  status: DeployStatus;
  options: Record<string, string>;
  logs: { at: string; line: string }[];
  preflight: PreflightCheck[];
  configPreview: string;
  outcome: "success" | "fail" | "rollback";
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  role: DemoRole | "system";
  action: string;
  target: string;
  detail: string;
  simulated: boolean;
}

export interface Integration {
  id: string;
  type: "v2board" | "cloudflare" | "agent";
  name: string;
  status: "connected" | "degraded" | "disconnected";
  config: Record<string, string>;
  lastSync?: string;
  lastTest?: string;
  message: string;
}

export interface LogSnapshot {
  through: number;
  watermark: number;
}

export interface ObservedLogPage {
  data: LogEntry[];
  page: number;
  limit: number;
  total: number;
  snapshot: LogSnapshot;
}

export interface LogEntry {
  id: string;
  ts: string;
  severity: LogSeverity;
  serverId?: string;
  nodeId?: string;
  source: LogSource;
  message: string;
  repeatCount?: number;
  lastTs?: string;
}

export type ActivityCategory = "install" | "tunnel" | "server" | "node" | "settings" | "other";

export interface ActivityEntry {
  id: string;
  at: string;
  category: ActivityCategory;
  action: string;
  actor: string;
  role: string;
  target: string;
  serverId?: string;
  nodeId?: string;
  tunnelId?: string;
  detail: string;
  outcome: "success" | "failed" | "info";
}

export interface ActivityPage {
  data: ActivityEntry[];
  page: number;
  limit: number;
  total: number;
  summary: Record<ActivityCategory, number>;
  from: number;
  to: number;
}

export interface AppSettings {
  metricAlertRules?: import("@/lib/alert-rules").MetricAlertRule[];
  telemetryIntervals?: import("@/lib/telemetry-policy").TelemetryIntervals;
  orgName: string;
  monitoringIntervalSec: number;
  dataRetentionDays: number;
  thresholds: {
    rttMs: number;
    lossPct: number;
    cpu: number;
    ram: number;
    disk: number;
  };
  failover: FailoverDefaults;
  notifications: {
    telegram: boolean;
    email: boolean;
    webhook: boolean;
    telegramChat: string;
    emailTo: string;
    webhookUrl: string;
    onSeverity: AlertSeverity;
  };
}

export interface DemoUser {
  id: string;
  name: string;
  role: DemoRole;
  email: string;
}

export interface DemoSnapshot {
  nodes: Node[];
  servers: Server[];
  tunnels: Tunnel[];
  dns: DNSRecord[];
  alerts: Alert[];
  incidents: Incident[];
  failoverEvents: FailoverEvent[];
  policies: FailoverPolicy[];
  audit: AuditEvent[];
  deployments: DeploymentJob[];
  speedtests: SpeedtestResult[];
  logs: LogEntry[];
  integrations: Integration[];
  settings: AppSettings;
  users: DemoUser[];
}

export type IperfJobStatus = "queued" | "running" | "cancel_requested" | "completed" | "cancelled" | "failed";

export interface IperfConfig {
  tunnelId: string;
  sourceServerId: string;
  destServerId: string;
  protocol: "tcp" | "udp";
  direction: "upload" | "download" | "bidirectional";
  durationSec: number;
  streams: number;
  bandwidthLimitMbps: number;
}

export interface IperfResult {
  uploadMbps?: number;
  downloadMbps?: number;
  jitterMs?: number;
  lossPct?: number;
  samples: { t: number; uploadMbps?: number; downloadMbps?: number }[];
}

export interface IperfJob {
  id: string;
  status: IperfJobStatus;
  config: IperfConfig;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: IperfResult;
  error?: string;
}

export interface SpeedBatchPing {
  attempts: number;
  replies: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
}

export interface SpeedBatchTarget {
  id: string;
  targetId: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed";
  samples?: number[];
  ping?: SpeedBatchPing;
  avgMbps?: number;
  error?: string;
}

export interface SpeedBatch {
  id: string;
  mode: "gre" | "internet";
  status: "running" | "completed";
  createdAt: string;
  targets: SpeedBatchTarget[];
}

export interface FailoverPreflight {
  nodeId: string;
  target: "primary" | "backup";
  domain: string;
  fromIp: string | null;
  toIp: string | null;
  ready: boolean;
  automaticEligible: boolean;
  requiredConfirmations: number;
  targetConfirmations: number;
  failureConfirmations: number;
  checks: { code: string; ok: boolean; label: string }[];
}


export interface ProvisionTunnelBinding {
  tunnelId: string;
  iranProfileId: string;
  foreignProfileId: string;
}

export interface ProvisionCatalogPreview {
  fingerprint: string;
  profiles: ProvisionProfile[];
  tunnels: (ProvisionTunnelBinding & { previous?: ProvisionTunnelBinding })[];
  addedProfiles: number;
  updatedTunnels: number;
}

export interface ProvisionProfile {
  greTransport?: "native" | "udp";
  id: string;
  serverId: string;
  component: string;
  version: string;
  sha256: string;
  summary: string;
  forwardPort?: number;
  forwardTargetPort?: number;
  v2bxNode?: { apiHost: string; nodeId: number; nodeType: string };
}

export interface ProvisionJob {
  checks?: ("package" | "service" | "icmp" | "tcp")[];
  id: string;
  profile: ProvisionProfile;
  operation: "apply" | "rollback" | "remove" | "restart-v2bx" | "remove-v2bx" | "reboot" | "start-service" | "stop-service" | "restart-service";
  status: "queued" | "running" | "succeeded" | "failed" | "review" | "cancelled";
  rollbackOf?: string;
  coordinated?: boolean;
  createdAt: string;
  detail: string;
}



export interface V2BoardCatalog {
  enabled: boolean;
  automatic: boolean;
  intervalSec: number | null;
  inProgress: boolean;
  stale: boolean;
  lastAttemptAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  nodes: V2BoardCatalogEntry[];
  syncedAt: string | null;
}

export interface V2BoardCatalogEntry {
  key: string;
  name: string;
  host: string;
  port: number | string;
  type: string;
  tls?: "TLS" | "Reality" | "none";
  transport?: string;
  protocol?: Protocol;
  nodeId?: string;
  fingerprint: string;
  online?: number;
  parentKey?: string;
}

export interface TunnelDeploymentPreview {
  tunnelId: string;
  technology: TunnelTech;
  iran: ProvisionProfile;
  foreign: ProvisionProfile;
  fingerprint: string;
}

export interface TunnelDeployment {
  warning?: "tls_certificate" | "destination_service";
  id: string;
  operation?: "destroy" | "rebuild";
  standbyNodeId?: string;
  preview: TunnelDeploymentPreview;
  status: "deploying" | "verifying" | "succeeded" | "rolling_back" | "rolled_back" | "destroyed" | "failed" | "review";
  phase: "foreign_apply" | "iran_apply" | "verify" | "iran_restore" | "foreign_restore" | "iran_remove" | "foreign_remove" | "iran_bbr" | "foreign_bbr" | "dns";
  activation?: "pending" | "working" | "succeeded" | "failed";
  detail: string;
  createdAt: string;
  steps: { phase: TunnelDeployment["phase"]; job: ProvisionJob }[];
}

export interface FailoverExecution {
  status: "applying" | "verifying" | "rolling_back" | "succeeded" | "rolled_back" | "review" | "aborted";
  detail: string;
  updatedAt: string;
}

export interface OperationalFailoverPlan {
  execution?: FailoverExecution;
  id: string;
  nodeId: string;
  target: "primary" | "backup";
  status: "awaiting_approval" | "approved" | "rejected" | "expired" | "stale";
  preflight: FailoverPreflight;
  createdAt: string;
  expiresAt: string;
  requestedBy: string;
  decidedBy?: string;
  requireSecondActor: boolean;
  automatic: boolean;
}
