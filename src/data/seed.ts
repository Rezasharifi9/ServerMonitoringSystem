import { decorateNodes } from "@/lib/health";
import { agoIso } from "@/lib/utils";
import type {
  Alert,
  AuditEvent,
  DemoSnapshot,
  DemoUser,
  DeploymentJob,
  DNSRecord,
  FailoverDefaults,
  FailoverEvent,
  FailoverPolicy,
  Incident,
  Integration,
  LogEntry,
  LogSeverity,
  Node,
  Protocol,
  Server,
  ServerRole,
  Service,
  SpeedtestResult,
  Tunnel,
  TunnelTech,
} from "@/types";

export const DEMO_USERS: DemoUser[] = [
  { id: "usr-reza", name: "رضا مرادی", role: "super-admin", email: "reza@nodeguard.example" },
  { id: "usr-sara", name: "سارا کیانی", role: "infra-admin", email: "sara@nodeguard.example" },
  { id: "usr-arman", name: "آرمان نوری", role: "operator", email: "arman@nodeguard.example" },
  { id: "usr-leila", name: "لیلا احمدی", role: "readonly", email: "leila@nodeguard.example" },
];

export function defaultFailover(): FailoverDefaults {
  return {
    intervalSec: 15,
    failureThreshold: 3,
    probeTimeoutMs: 2000,
    minConfirmations: 2,
    autoEnabled: true,
    manualApproval: false,
    cooldownSec: 180,
    backupPriority: "latency",
    minBackupCapacity: 20,
    autoFailback: true,
    stabilitySec: 180,
    dnsStrategy: "lowest-ttl",
    rollbackStrategy: "restore-primary-dns",
  };
}

export function defaultSettings(): DemoSnapshot["settings"] {
  return {
    orgName: "NodeGuard",
    monitoringIntervalSec: 30,
    dataRetentionDays: 30,
    thresholds: { rttMs: 180, lossPct: 3, cpu: 90, ram: 90, disk: 92 },
    failover: defaultFailover(),
    notifications: {
      telegram: true,
      email: true,
      webhook: false,
      telegramChat: "@nodeguard_noc_demo",
      emailTo: "noc@nodeguard.example",
      webhookUrl: "https://hooks.nodeguard.example/alerts",
      onSeverity: "warning",
    },
  };
}

interface ServerSeed {
  id: string;
  name: string;
  region: string;
  country: string;
  cc: string;
  city: string;
  ipv4: string;
  ipv6?: string;
  tip: string;
  provider: string;
  os: string;
  roles: ServerRole[];
  status: Server["status"];
  cpu: number;
  ram: number;
  disk: number;
  rx: number;
  tx: number;
  agent: "online" | "offline" | "degraded";
  v2bx?: "running" | "stopped" | "degraded";
  uptimeDays: number;
}

interface NodeSeed {
  id: string;
  name: string;
  country: string;
  cc: string;
  city: string;
  protocol: Protocol;
  port: number;
  domain: string;
  primary: string;
  backup: string;
  foreign: string;
  tech: TunnelTech;
  remark?: string;
  tunnel?: Partial<Pick<Tunnel, "status" | "rttMs" | "packetLoss" | "jitterMs" | "rxMbps" | "txMbps" | "uptimePct">>;
  dnsMode?: "mismatch" | "propagation" | "proxied" | "cname" | "error";
}

const SERVERS: ServerSeed[] = [
  { id: "ir-thr-01", name: "تهران-لبه-۰۱", region: "ایران", country: "ایران", cc: "IR", city: "تهران", ipv4: "203.0.113.11", ipv6: "2001:db8:10::11", tip: "10.88.0.11", provider: "آسیاتک (نمونه)", os: "Ubuntu 24.04", roles: ["iran-primary"], status: "healthy", cpu: 37, ram: 52, disk: 41, rx: 640, tx: 610, agent: "online", uptimeDays: 41 },
  { id: "ir-thr-02", name: "تهران-لبه-۰۲", region: "ایران", country: "ایران", cc: "IR", city: "تهران", ipv4: "203.0.113.12", ipv6: "2001:db8:10::12", tip: "10.88.0.12", provider: "رسپینا (نمونه)", os: "Ubuntu 22.04", roles: ["iran-primary"], status: "healthy", cpu: 84, ram: 71, disk: 49, rx: 710, tx: 690, agent: "online", uptimeDays: 18 },
  { id: "ir-isf-01", name: "اصفهان-لبه-۰۱", region: "ایران", country: "ایران", cc: "IR", city: "اصفهان", ipv4: "203.0.113.21", ipv6: "2001:db8:10::21", tip: "10.88.0.21", provider: "هاست‌ایران (نمونه)", os: "Debian 12", roles: ["iran-primary", "iran-backup"], status: "healthy", cpu: 29, ram: 44, disk: 36, rx: 280, tx: 260, agent: "online", uptimeDays: 63 },
  { id: "ir-mhd-01", name: "مشهد-لبه-۰۱", region: "ایران", country: "ایران", cc: "IR", city: "مشهد", ipv4: "203.0.113.31", tip: "10.88.0.31", provider: "آسیاتک (نمونه)", os: "Ubuntu 24.04", roles: ["iran-primary"], status: "healthy", cpu: 33, ram: 48, disk: 58, rx: 310, tx: 290, agent: "online", uptimeDays: 27 },
  { id: "ir-bak-01", name: "تهران-پشتیبان-۰۱", region: "ایران", country: "ایران", cc: "IR", city: "تهران", ipv4: "203.0.113.41", ipv6: "2001:db8:10::41", tip: "10.88.1.41", provider: "ابر آروان (نمونه)", os: "Ubuntu 24.04", roles: ["iran-backup"], status: "healthy", cpu: 18, ram: 31, disk: 27, rx: 40, tx: 36, agent: "online", uptimeDays: 54 },
  { id: "ir-bak-02", name: "تهران-پشتیبان-۰۲", region: "ایران", country: "ایران", cc: "IR", city: "تهران", ipv4: "203.0.113.42", tip: "10.88.1.42", provider: "رسپینا (نمونه)", os: "Ubuntu 22.04", roles: ["iran-backup"], status: "offline", cpu: 0, ram: 0, disk: 44, rx: 0, tx: 0, agent: "offline", uptimeDays: 0 },
  { id: "ir-isf-bak-01", name: "اصفهان-پشتیبان-۰۱", region: "ایران", country: "ایران", cc: "IR", city: "اصفهان", ipv4: "203.0.113.51", ipv6: "2001:db8:10::51", tip: "10.88.1.51", provider: "هاست‌ایران (نمونه)", os: "Debian 12", roles: ["iran-backup"], status: "healthy", cpu: 22, ram: 39, disk: 33, rx: 55, tx: 48, agent: "online", uptimeDays: 36 },
  { id: "eu-fra-01", name: "فرانکفورت-۰۱", region: "اروپا", country: "آلمان", cc: "DE", city: "فرانکفورت", ipv4: "198.51.100.11", ipv6: "2001:db8:20::11", tip: "10.88.2.11", provider: "Hetzner (نمونه)", os: "Ubuntu 24.04", roles: ["foreign"], status: "healthy", cpu: 41, ram: 58, disk: 46, rx: 820, tx: 790, agent: "online", v2bx: "running", uptimeDays: 72 },
  { id: "eu-fra-02", name: "فرانکفورت-۰۲", region: "اروپا", country: "آلمان", cc: "DE", city: "فرانکفورت", ipv4: "198.51.100.12", ipv6: "2001:db8:20::12", tip: "10.88.2.12", provider: "Hetzner (نمونه)", os: "Ubuntu 24.04", roles: ["foreign"], status: "healthy", cpu: 36, ram: 49, disk: 38, rx: 540, tx: 510, agent: "online", v2bx: "running", uptimeDays: 22 },
  { id: "eu-ams-01", name: "آمستردام-۰۱", region: "اروپا", country: "هلند", cc: "NL", city: "آمستردام", ipv4: "198.51.100.21", ipv6: "2001:db8:20::21", tip: "10.88.2.21", provider: "OVH (نمونه)", os: "Debian 12", roles: ["foreign"], status: "healthy", cpu: 28, ram: 45, disk: 51, rx: 430, tx: 410, agent: "online", v2bx: "running", uptimeDays: 48 },
  { id: "eu-hel-01", name: "هلسینکی-۰۱", region: "اروپا", country: "فنلاند", cc: "FI", city: "هلسینکی", ipv4: "198.51.100.31", ipv6: "2001:db8:20::31", tip: "10.88.2.31", provider: "Hetzner (نمونه)", os: "Ubuntu 22.04", roles: ["foreign"], status: "healthy", cpu: 47, ram: 88, disk: 62, rx: 260, tx: 240, agent: "online", v2bx: "running", uptimeDays: 15 },
  { id: "eu-lon-01", name: "لندن-۰۱", region: "اروپا", country: "بریتانیا", cc: "GB", city: "لندن", ipv4: "198.51.100.41", ipv6: "2001:db8:20::41", tip: "10.88.2.41", provider: "OVH (نمونه)", os: "Ubuntu 24.04", roles: ["foreign"], status: "healthy", cpu: 31, ram: 42, disk: 83, rx: 300, tx: 280, agent: "online", v2bx: "running", uptimeDays: 9 },
  { id: "me-ist-01", name: "استانبول-۰۱", region: "خاورمیانه", country: "ترکیه", cc: "TR", city: "استانبول", ipv4: "192.0.2.11", ipv6: "2001:db8:30::11", tip: "10.88.3.11", provider: "Radore (نمونه)", os: "Ubuntu 24.04", roles: ["foreign"], status: "healthy", cpu: 44, ram: 57, disk: 40, rx: 690, tx: 650, agent: "online", v2bx: "running", uptimeDays: 33 },
  { id: "me-dxb-01", name: "دبی-۰۱", region: "خاورمیانه", country: "امارات", cc: "AE", city: "دبی", ipv4: "192.0.2.21", ipv6: "2001:db8:30::21", tip: "10.88.3.21", provider: "GCore (نمونه)", os: "Ubuntu 22.04", roles: ["foreign"], status: "healthy", cpu: 26, ram: 38, disk: 29, rx: 210, tx: 190, agent: "online", v2bx: "running", uptimeDays: 44 },
  { id: "ap-sgp-01", name: "سنگاپور-۰۱", region: "آسیا", country: "سنگاپور", cc: "SG", city: "سنگاپور", ipv4: "192.0.2.31", ipv6: "2001:db8:40::31", tip: "10.88.4.31", provider: "Vultr (نمونه)", os: "Ubuntu 24.04", roles: ["foreign"], status: "healthy", cpu: 39, ram: 53, disk: 47, rx: 360, tx: 340, agent: "online", v2bx: "running", uptimeDays: 21 },
  { id: "ap-nrt-01", name: "توکیو-۰۱", region: "آسیا", country: "ژاپن", cc: "JP", city: "توکیو", ipv4: "192.0.2.41", ipv6: "2001:db8:40::41", tip: "10.88.4.41", provider: "Vultr (نمونه)", os: "Ubuntu 24.04", roles: ["foreign"], status: "healthy", cpu: 12, ram: 34, disk: 31, rx: 4, tx: 3, agent: "online", v2bx: "stopped", uptimeDays: 11 },
  { id: "us-lax-01", name: "لس‌آنجلس-۰۱", region: "آمریکای شمالی", country: "آمریکا", cc: "US", city: "لس‌آنجلس", ipv4: "192.0.2.51", ipv6: "2001:db8:50::51", tip: "10.88.5.51", provider: "BuyVM (نمونه)", os: "Debian 12", roles: ["foreign"], status: "healthy", cpu: 35, ram: 50, disk: 43, rx: 480, tx: 450, agent: "online", v2bx: "running", uptimeDays: 29 },
];

const NODES: NodeSeed[] = [
  { id: "1001", name: "فرانکفورت-۰۱", country: "آلمان", cc: "DE", city: "فرانکفورت", protocol: "VLESS", port: 443, domain: "fra01.nodeguard.example", primary: "ir-thr-01", backup: "ir-bak-01", foreign: "eu-fra-01", tech: "GRE" },
  { id: "1002", name: "فرانکفورت-۰۲", country: "آلمان", cc: "DE", city: "فرانکفورت", protocol: "Trojan", port: 8443, domain: "fra02.nodeguard.example", primary: "ir-thr-01", backup: "ir-bak-01", foreign: "eu-fra-01", tech: "WireGuard" },
  { id: "1003", name: "فرانکفورت-۰۳", country: "آلمان", cc: "DE", city: "فرانکفورت", protocol: "VMess", port: 2053, domain: "fra03.nodeguard.example", primary: "ir-thr-02", backup: "ir-bak-01", foreign: "eu-fra-02", tech: "IPIP" },
  { id: "1004", name: "آمستردام-۰۱", country: "هلند", cc: "NL", city: "آمستردام", protocol: "VLESS", port: 443, domain: "ams01.nodeguard.example", primary: "ir-mhd-01", backup: "ir-isf-bak-01", foreign: "eu-ams-01", tech: "SIT" },
  { id: "1005", name: "آمستردام-۰۲", country: "هلند", cc: "NL", city: "آمستردام", protocol: "Hysteria2", port: 443, domain: "ams02.nodeguard.example", primary: "ir-thr-01", backup: "ir-isf-bak-01", foreign: "eu-ams-01", tech: "Geneve" },
  { id: "1006", name: "هلسینکی-۰۱", country: "فنلاند", cc: "FI", city: "هلسینکی", protocol: "Shadowsocks", port: 8388, domain: "hel01.nodeguard.example", primary: "ir-thr-02", backup: "ir-bak-01", foreign: "eu-hel-01", tech: "GRE6", tunnel: { status: "degraded", rttMs: 264, packetLoss: 1.8, jitterMs: 28, uptimePct: 98.4 } },
  { id: "1007", name: "استانبول-۰۱", country: "ترکیه", cc: "TR", city: "استانبول", protocol: "VLESS", port: 443, domain: "ist01.nodeguard.example", primary: "ir-thr-01", backup: "ir-isf-bak-01", foreign: "me-ist-01", tech: "GOST" },
  { id: "1008", name: "استانبول-۰۲", country: "ترکیه", cc: "TR", city: "استانبول", protocol: "Trojan", port: 2096, domain: "ist02.nodeguard.example", primary: "ir-isf-01", backup: "ir-bak-01", foreign: "me-ist-01", tech: "Backhaul", tunnel: { status: "degraded", rttMs: 96, packetLoss: 7.4, jitterMs: 14, uptimePct: 97.1 } },
  { id: "1009", name: "استانبول-۰۳", country: "ترکیه", cc: "TR", city: "استانبول", protocol: "VLESS", port: 443, domain: "ist03.nodeguard.example", primary: "ir-mhd-01", backup: "ir-isf-bak-01", foreign: "me-ist-01", tech: "Rathole", dnsMode: "cname" },
  { id: "1010", name: "دبی-۰۱", country: "امارات", cc: "AE", city: "دبی", protocol: "VMess", port: 8443, domain: "dxb01.nodeguard.example", primary: "ir-thr-01", backup: "ir-bak-01", foreign: "me-dxb-01", tech: "WireGuard" },
  { id: "1011", name: "دبی-۰۲", country: "امارات", cc: "AE", city: "دبی", protocol: "Hysteria2", port: 443, domain: "dxb02.nodeguard.example", primary: "ir-thr-02", backup: "ir-isf-bak-01", foreign: "me-dxb-01", tech: "GRE", dnsMode: "proxied" },
  { id: "1012", name: "سنگاپور-۰۱", country: "سنگاپور", cc: "SG", city: "سنگاپور", protocol: "VLESS", port: 443, domain: "sgp01.nodeguard.example", primary: "ir-isf-01", backup: "ir-bak-01", foreign: "ap-sgp-01", tech: "IPIP", tunnel: { status: "offline", rttMs: 0, packetLoss: 100, jitterMs: 0, rxMbps: 0, txMbps: 0, uptimePct: 91.6 } },
  { id: "1013", name: "سنگاپور-۰۲", country: "سنگاپور", cc: "SG", city: "سنگاپور", protocol: "Trojan", port: 2053, domain: "sgp02.nodeguard.example", primary: "ir-mhd-01", backup: "ir-isf-bak-01", foreign: "ap-sgp-01", tech: "GRE", dnsMode: "propagation" },
  { id: "1014", name: "سنگاپور-۰۳", country: "سنگاپور", cc: "SG", city: "سنگاپور", protocol: "Shadowsocks", port: 443, domain: "sgp03.nodeguard.example", primary: "ir-thr-02", backup: "ir-bak-01", foreign: "ap-sgp-01", tech: "SIT" },
  { id: "1015", name: "توکیو-۰۱", country: "ژاپن", cc: "JP", city: "توکیو", protocol: "VLESS", port: 443, domain: "nrt01.nodeguard.example", primary: "ir-isf-01", backup: "ir-bak-01", foreign: "ap-nrt-01", tech: "WireGuard", remark: "تونل بالا است؛ سرویس V2bX روی سرور توکیو متوقف شده." },
  { id: "1016", name: "فرانکفورت-۰۴", country: "آلمان", cc: "DE", city: "فرانکفورت", protocol: "VMess", port: 2083, domain: "fra04.nodeguard.example", primary: "ir-thr-01", backup: "ir-isf-bak-01", foreign: "eu-fra-02", tech: "GRE" },
  { id: "1017", name: "لس‌آنجلس-۰۱", country: "آمریکا", cc: "US", city: "لس‌آنجلس", protocol: "Hysteria2", port: 443, domain: "lax01.nodeguard.example", primary: "ir-mhd-01", backup: "ir-bak-01", foreign: "us-lax-01", tech: "Geneve", dnsMode: "error" },
  { id: "1018", name: "لس‌آنجلس-۰۲", country: "آمریکا", cc: "US", city: "لس‌آنجلس", protocol: "Trojan", port: 443, domain: "lax02.nodeguard.example", primary: "ir-mhd-01", backup: "ir-isf-bak-01", foreign: "us-lax-01", tech: "GOST", dnsMode: "mismatch" },
  { id: "1019", name: "آمستردام-۰۳", country: "هلند", cc: "NL", city: "آمستردام", protocol: "VLESS", port: 8443, domain: "ams03.nodeguard.example", primary: "ir-thr-02", backup: "ir-bak-01", foreign: "eu-ams-01", tech: "IPIP" },
  { id: "1020", name: "هلسینکی-۰۲", country: "فنلاند", cc: "FI", city: "هلسینکی", protocol: "VMess", port: 443, domain: "hel02.nodeguard.example", primary: "ir-isf-01", backup: "ir-isf-bak-01", foreign: "eu-hel-01", tech: "GOST" },
  { id: "1021", name: "لندن-۰۱", country: "بریتانیا", cc: "GB", city: "لندن", protocol: "Shadowsocks", port: 443, domain: "lon01.nodeguard.example", primary: "ir-mhd-01", backup: "ir-bak-02", foreign: "eu-lon-01", tech: "Rathole", remark: "پشتیبان این نود آفلاین است و Failover خودکار غیرفعال شده." },
  { id: "1022", name: "لس‌آنجلس-۰۳", country: "آمریکا", cc: "US", city: "لس‌آنجلس", protocol: "VLESS", port: 2053, domain: "lax03.nodeguard.example", primary: "ir-isf-01", backup: "ir-bak-01", foreign: "us-lax-01", tech: "GRE6" },
  { id: "1023", name: "لندن-۰۲", country: "بریتانیا", cc: "GB", city: "لندن", protocol: "Trojan", port: 8443, domain: "lon02.nodeguard.example", primary: "ir-mhd-01", backup: "ir-bak-02", foreign: "eu-lon-01", tech: "Backhaul" },
  { id: "1024", name: "لندن-۰۳", country: "بریتانیا", cc: "GB", city: "لندن", protocol: "Hysteria2", port: 443, domain: "lon03.nodeguard.example", primary: "ir-mhd-01", backup: "ir-isf-bak-01", foreign: "eu-lon-01", tech: "Geneve" },
];

function techProfile(tech: TunnelTech, index: number) {
  const table: Record<TunnelTech, { kind: Tunnel["kind"]; mtu: number; iface?: string; service?: string; port?: number; rtt: number }> = {
    GRE: { kind: "interface", mtu: 1476, iface: `gre-ng${index}`, rtt: 36 },
    IPIP: { kind: "interface", mtu: 1480, iface: `ipip-ng${index}`, rtt: 34 },
    SIT: { kind: "interface", mtu: 1480, iface: `sit-ng${index}`, rtt: 42 },
    WireGuard: { kind: "interface", mtu: 1420, iface: `wg-ng${index}`, rtt: 31 },
    GRE6: { kind: "interface", mtu: 1460, iface: `gre6-ng${index}`, rtt: 45 },
    Geneve: { kind: "interface", mtu: 1450, iface: `gnv-ng${index}`, rtt: 39 },
    GOST: { kind: "forwarder", mtu: 1500, service: `gost-ng${index}.service`, port: 4400 + index, rtt: 49 },
    Backhaul: { kind: "forwarder", mtu: 1500, service: `backhaul-ng${index}.service`, port: 5400 + index, rtt: 53 },
    Rathole: { kind: "forwarder", mtu: 1500, service: `rathole-ng${index}.service`, port: 6400 + index, rtt: 47 },
  };
  return table[tech];
}

function makeServer(seed: ServerSeed): Server {
  const heartbeat = seed.agent === "offline" ? agoIso(18 * 60 * 1000) : agoIso(12_000 + seed.uptimeDays * 100);
  const services: Service[] = [
    { id: `${seed.id}-agent`, name: "nodeguard-agent", status: seed.agent === "offline" ? "stopped" : "running", version: seed.agent === "offline" ? "1.3.8" : "1.4.2" },
    { id: `${seed.id}-bbr`, name: "bbr", status: seed.status === "offline" ? "stopped" : "running", version: "6.8" },
  ];
  if (seed.v2bx) {
    services.push({
      id: `${seed.id}-v2bx`,
      name: "v2bx",
      status: seed.v2bx === "running" ? "running" : seed.v2bx === "degraded" ? "degraded" : "stopped",
      version: "0.8.5-demo",
      port: 443,
    });
  }
  return {
    id: seed.id,
    name: seed.name,
    region: seed.region,
    country: seed.country,
    countryCode: seed.cc,
    city: seed.city,
    publicIpv4: seed.ipv4,
    publicIpv6: seed.ipv6,
    tunnelIp: seed.tip,
    provider: seed.provider,
    os: seed.os,
    hardware: seed.roles.includes("foreign") ? { cpuCores: 8, ramBytes: 16 * 1024 ** 3, diskBytes: 160 * 1024 ** 3 }
      : { cpuCores: 4, ramBytes: 8 * 1024 ** 3, diskBytes: 80 * 1024 ** 3 },
    cpu: seed.cpu,
    ram: seed.ram,
    disk: seed.disk,
    rxMbps: seed.rx,
    txMbps: seed.tx,
    roles: seed.roles,
    status: seed.status,
    uptimeSec: seed.uptimeDays * 86400 + 3600,
    notes: seed.status === "offline" ? "آخرین ضربان عامل دریافت نشده است. این رکورد فقط داده نمایشی است." : "میزبان نمونه برای محیط نمایش.",
    agent: {
      id: `ag-${seed.id}`,
      serverId: seed.id,
      version: seed.agent === "offline" ? "1.3.8" : seed.id === "eu-hel-01" ? "1.4.0" : "1.4.2",
      status: seed.agent,
      lastHeartbeat: heartbeat,
      capabilities: ["metrics", "systemd", "tunnel", "dns-observe", "speedtest"],
    },
    services,
    interfaces: [
      { name: "eth0", kind: "public", ipv4: seed.ipv4, ipv6: seed.ipv6, rxMbps: seed.rx, txMbps: seed.tx, mtu: 1500, up: seed.status !== "offline" },
      { name: "lo", kind: "loopback", ipv4: "127.0.0.1", rxMbps: 0, txMbps: 0, mtu: 65536, up: true },
    ],
  };
}

function makeTunnel(
  spec: NodeSeed,
  servers: Server[],
  side: "primary" | "backup",
  index: number,
): Tunnel {
  const iran = servers.find((server) => server.id === (side === "primary" ? spec.primary : spec.backup));
  const foreign = servers.find((server) => server.id === spec.foreign);
  if (!iran || !foreign) throw new Error(`missing endpoint for ${spec.id}`);
  const profile = techProfile(spec.tech, index);
  const backupOffline = side === "backup" && iran.status === "offline";
  const baseStatus = backupOffline ? "offline" : side === "primary" ? spec.tunnel?.status ?? "healthy" : "healthy";
  const rtt = backupOffline ? 0 : side === "primary" ? spec.tunnel?.rttMs ?? profile.rtt + (index % 5) : profile.rtt + 7;
  const loss = backupOffline ? 100 : side === "primary" ? spec.tunnel?.packetLoss ?? 0.15 + (index % 4) * 0.05 : 0.2;
  const id = `tn-${spec.id}-${side === "primary" ? "p" : "b"}`;
  const octet = index + (side === "backup" ? 80 : 0);
  return {
    id,
    name: `${spec.tech} ${iran.name} → ${foreign.name}`,
    technology: spec.tech,
    kind: profile.kind,
    side,
    iranEndpoint: {
      serverId: iran.id,
      publicIp: iran.publicIpv4,
      tunnelIp: profile.kind === "interface" ? `10.90.${octet}.1` : undefined,
      port: profile.port,
      interfaceName: profile.iface,
    },
    foreignEndpoint: {
      serverId: foreign.id,
      publicIp: foreign.publicIpv4,
      tunnelIp: profile.kind === "interface" ? `10.90.${octet}.2` : undefined,
      port: profile.port ? profile.port + 1 : undefined,
      interfaceName: profile.iface,
    },
    interfaceName: profile.iface,
    serviceName: profile.service,
    status: baseStatus,
    rttMs: rtt,
    jitterMs: backupOffline ? 0 : side === "primary" ? spec.tunnel?.jitterMs ?? 2 + (index % 3) : 4,
    packetLoss: loss,
    mtu: profile.mtu,
    rxMbps: backupOffline || baseStatus === "offline" ? 0 : spec.tunnel?.rxMbps ?? 80 + (index % 7) * 35,
    txMbps: backupOffline || baseStatus === "offline" ? 0 : spec.tunnel?.txMbps ?? 74 + (index % 6) * 32,
    lastCheck: agoIso(baseStatus === "offline" ? 4 * 60 * 1000 : 20_000),
    uptimePct: spec.tunnel?.uptimePct && side === "primary" ? spec.tunnel.uptimePct : baseStatus === "offline" ? 90 : 99.9 - (index % 5) * 0.02,
    nodeIds: [spec.id],
    config:
      profile.kind === "interface"
        ? {
            encapsulation: spec.tech,
            mtu: String(profile.mtu),
            key: "demo-only-not-a-secret",
            note: "پیکربندی نمایشی؛ روی هیچ میزبانی اعمال نمی‌شود.",
          }
        : {
            mode: spec.tech === "GOST" ? "relay+tls" : spec.tech === "Backhaul" ? "tcp-transport" : "reverse-tunnel",
            listen: String(profile.port),
            token: "demo-token-masked",
            note: "سرویس هدایت پورت، نه رابط شبکه.",
          },
  };
}

function makeDns(spec: NodeSeed, servers: Server[]): DNSRecord {
  const primary = servers.find((server) => server.id === spec.primary)!;
  const base = {
    id: `dns-${spec.id}`,
    nodeId: spec.id,
    domain: spec.domain,
    v2boardHost: spec.domain,
    v2boardIp: primary.publicIpv4,
    aaaaRecords: primary.publicIpv6 ? [primary.publicIpv6] : [],
    ttl: spec.dnsMode === "propagation" ? 300 : 120,
    proxied: spec.dnsMode === "proxied",
    lastCheck: agoIso(90_000),
    cname: undefined as string | undefined,
    aRecords: [primary.publicIpv4],
    authoritativeStatus: "matched" as DNSRecord["authoritativeStatus"],
    resolverStatus: "matched" as DNSRecord["resolverStatus"],
    note: "رکورد نمونه با IP فعال سرور ایرانی منطبق است.",
  };
  if (spec.dnsMode === "mismatch") {
    base.aRecords = ["203.0.113.99"];
    base.authoritativeStatus = "mismatched";
    base.resolverStatus = "mismatched";
    base.note = "A record هنوز به 203.0.113.99 اشاره دارد، در حالی که IP فعال سرور ایرانی متفاوت است.";
  }
  if (spec.dnsMode === "propagation") {
    base.authoritativeStatus = "matched";
    base.resolverStatus = "propagation";
    base.note = "سرور authoritative به‌روز است، اما resolver نمونه هنوز 203.0.113.88 را برمی‌گرداند.";
  }
  if (spec.dnsMode === "proxied") {
    base.aRecords = ["203.0.113.200"];
    base.authoritativeStatus = "proxied";
    base.resolverStatus = "proxied";
    base.note = "رکورد پشت پروکسی دیده می‌شود. IP مبدأ برای کلاینت پنهان است و سوییچ مستقیم باید با احتیاط انجام شود.";
  }
  if (spec.dnsMode === "cname") {
    base.aRecords = [];
    base.cname = "edge.nodeguard.example";
    base.authoritativeStatus = "cname";
    base.resolverStatus = "cname";
    base.note = "به‌جای A، یک CNAME به edge.nodeguard.example دیده شد.";
  }
  if (spec.dnsMode === "error") {
    base.aRecords = [];
    base.aaaaRecords = [];
    base.authoritativeStatus = "error";
    base.resolverStatus = "error";
    base.note = "پرس‌وجوی نمونه با SERVFAIL پاسخ داده است. هیچ تغییری روی DNS واقعی انجام نشده.";
  }
  return base;
}

function buildLogs(): LogEntry[] {
  const severities: LogSeverity[] = ["DEBUG", "INFO", "INFO", "INFO", "WARNING", "ERROR"];
  const shared = [
    "هسته V2bX راه‌اندازی شد و فایل پیکربندی نمونه خوانده شد",
    "گواهی TLS نمونه برای دامنه nodeguard.example بارگذاری شد",
    "سیگنال بازنشانی پیکربندی دریافت شد؛ اعمال فقط در حالت نمایشی است",
    "آمار اتصال دوره‌ای ثبت شد",
    "بررسی سلامت داخلی سرویس با موفقیت انجام شد",
  ];
  const nodeLines = [
    "ورودی نود بارگذاری شد",
    "نشست کاربر نمونه پذیرفته شد",
    "زمان خروج از مسیر خارجی بالاتر از میانگین کوتاه‌مدت بود",
    "بازنویسی موقت مسیر به‌خاطر اتلاف بسته",
  ];
  const foreign = ["eu-fra-01", "eu-fra-02", "eu-ams-01", "me-ist-01", "us-lax-01", "ap-nrt-01", "eu-lon-01"];
  const logs: LogEntry[] = [];
  for (let i = 0; i < 140; i += 1) {
    const serverId = foreign[i % foreign.length];
    const nodeId = i % 3 === 0 ? undefined : NODES[i % NODES.length].id;
    const severity: LogSeverity = serverId === "ap-nrt-01" && i % 5 === 0 ? "ERROR" : severities[i % severities.length];
    const message = nodeId
      ? `[V2bX] ${nodeLines[i % nodeLines.length]}؛ نود ${nodeId}`
      : `[V2bX] ${shared[i % shared.length]}؛ میزبان ${serverId}`;
    logs.push({
      id: `log-${i + 1}`,
      ts: agoIso((140 - i) * 45_000),
      severity,
      serverId,
      nodeId,
      source: nodeId ? "v2bx-node" : "v2bx-shared",
      message: serverId === "ap-nrt-01" && !nodeId && i % 5 === 0
        ? "[V2bX] فرآیند سرویس متوقف است؛ لاگ مشترک به نود خاصی نسبت داده نمی‌شود"
        : message,
    });
  }
  logs.push({
    id: "log-boot",
    ts: agoIso(12 * 60 * 1000),
    severity: "CRITICAL",
    serverId: "ap-nrt-01",
    source: "v2bx-shared",
    message: "[V2bX] خروج غیرمنتظره سرویس. تونل WireGuard همچنان بالا گزارش شده است",
  });
  return logs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

function incident(
  partial: Omit<Incident, "timeline" | "updatedAt"> & { timeline?: Incident["timeline"] },
): Incident {
  return {
    ...partial,
    updatedAt: partial.resolvedAt ?? partial.openedAt,
    timeline: partial.timeline ?? [{ at: partial.openedAt, text: partial.summary }],
  };
}

export function buildSeed(): DemoSnapshot {
  const settings = defaultSettings();
  const servers = SERVERS.map(makeServer);
  const tunnels = NODES.flatMap((spec, index) => [
    makeTunnel(spec, servers, "primary", index + 1),
    makeTunnel(spec, servers, "backup", index + 1),
  ]);
  const dns = NODES.map((spec) => makeDns(spec, servers));
  const rawNodes: Node[] = NODES.map((spec) => ({
    id: spec.id,
    name: spec.name,
    country: spec.country,
    countryCode: spec.cc,
    city: spec.city,
    protocol: spec.protocol,
    port: spec.port,
    domain: spec.domain,
    primaryServerId: spec.primary,
    backupServerId: spec.backup,
    foreignServerId: spec.foreign,
    primaryTunnelId: `tn-${spec.id}-p`,
    backupTunnelId: `tn-${spec.id}-b`,
    activeSide: "primary",
    v2bxNodeState: "active",
    failoverState: "HEALTHY",
    tags: ["تولید"],
    settings: {
      remark: spec.remark ?? "نود واردشده از همگام‌سازی نمونه V2Board.",
      rateLimitMbps: spec.protocol === "Hysteria2" ? 400 : 0,
      probeEnabled: true,
      alertOnLoss: true,
    },
    health: "healthy",
    rttMs: 0,
    packetLoss: 0,
    jitterMs: 0,
    uptimePct: 99.9,
    v2bxStatus: "running",
    dnsStatus: "matched",
  }));
  const nodes = decorateNodes(rawNodes, servers, tunnels, dns, settings);
  const failover = defaultFailover();
  const policies: FailoverPolicy[] = nodes.map((node) => ({
    ...failover,
    nodeId: node.id,
    autoEnabled: node.id === "1004" || node.id === "1021" || node.id === "1023" ? false : failover.autoEnabled,
    manualApproval: node.id === "1021" || node.id === "1023",
  }));

  const incidents: Incident[] = [
    incident({
      id: "inc-1012",
      title: "قطع تونل سنگاپور-۰۱",
      severity: "critical",
      status: "open",
      category: "tunnel-disconnected",
      nodeId: "1012",
      serverId: "ir-isf-01",
      tunnelId: "tn-1012-p",
      openedAt: agoIso(42 * 60 * 1000),
      summary: "تونل IPIP بین اصفهان و سنگاپور قطع است. سرور میزبان همچنان ضربان دارد.",
      timeline: [
        { at: agoIso(50 * 60 * 1000), text: "اتلاف بسته از ۲۰٪ عبور کرد." },
        { at: agoIso(42 * 60 * 1000), text: "سه کاوش پیاپی ناموفق بود و حادثه باز شد." },
      ],
    }),
    incident({
      id: "inc-1015",
      title: "توقف V2bX در توکیو",
      severity: "critical",
      status: "open",
      category: "v2bx-failure",
      nodeId: "1015",
      serverId: "ap-nrt-01",
      tunnelId: "tn-1015-p",
      openedAt: agoIso(25 * 60 * 1000),
      summary: "رابط WireGuard بالا است، اما سرویس V2bX روی توکیو-۰۱ متوقف شده.",
      timeline: [
        { at: agoIso(28 * 60 * 1000), text: "آخرین لاگ مشترک V2bX خروج فرآیند را ثبت کرد." },
        { at: agoIso(25 * 60 * 1000), text: "اتصال سرتاسری ناموفق شد در حالی که تونل سالم ماند." },
      ],
    }),
    incident({
      id: "inc-1018",
      title: "عدم تطابق DNS لس‌آنجلس-۰۲",
      severity: "warning",
      status: "ack",
      category: "dns-mismatch",
      nodeId: "1018",
      assignee: "سارا کیانی",
      openedAt: agoIso(3 * 3600 * 1000),
      summary: "رکورد A به 203.0.113.99 اشاره دارد و با IP سرور ایرانی فعال یکی نیست.",
    }),
    incident({
      id: "inc-1008",
      title: "اتلاف بسته بالای استانبول-۰۲",
      severity: "warning",
      status: "open",
      category: "high-loss",
      nodeId: "1008",
      tunnelId: "tn-1008-p",
      openedAt: agoIso(70 * 60 * 1000),
      summary: "اتلاف بسته مسیر Backhaul به ۷٫۴٪ رسیده است.",
    }),
    incident({
      id: "inc-1006",
      title: "تأخیر بالای هلسینکی-۰۱",
      severity: "warning",
      status: "open",
      category: "high-rtt",
      nodeId: "1006",
      tunnelId: "tn-1006-p",
      openedAt: agoIso(2 * 3600 * 1000),
      summary: "RTT مسیر GRE6 حدود ۲۶۴ میلی‌ثانیه است.",
    }),
    incident({
      id: "inc-bak-02",
      title: "قطع عامل تهران-پشتیبان-۰۲",
      severity: "critical",
      status: "open",
      category: "agent-disconnected",
      serverId: "ir-bak-02",
      openedAt: agoIso(5 * 3600 * 1000),
      summary: "سرور پشتیبان آفلاین است و نودهای لندن-۰۱ و لندن-۰۲ پشتیبان آماده ندارند.",
    }),
    incident({
      id: "inc-tls-1024",
      title: "نزدیک شدن انقضای گواهی لندن-۰۳",
      severity: "info",
      status: "open",
      category: "tls-expiry",
      nodeId: "1024",
      openedAt: agoIso(8 * 3600 * 1000),
      summary: "گواهی نمونه تا ۹ روز دیگر منقضی می‌شود. این هشدار واقعی نیست.",
    }),
    incident({
      id: "inc-deploy-gost",
      title: "شکست نصب نمونه GOST",
      severity: "warning",
      status: "resolved",
      category: "deploy-failed",
      serverId: "ap-sgp-01",
      openedAt: agoIso(5 * 86400 * 1000),
      resolvedAt: agoIso(5 * 86400 * 1000 + 20 * 60 * 1000),
      summary: "پیش‌بررسی پورت در سناریوی نمایشی ناموفق بود و نصب متوقف شد.",
    }),
  ];

  const alerts: Alert[] = incidents.map((item, index) => ({
    id: `al-${item.id}`,
    incidentId: item.id,
    title: item.title,
    severity: item.severity,
    category: item.category,
    nodeId: item.nodeId,
    serverId: item.serverId,
    tunnelId: item.tunnelId,
    createdAt: item.openedAt,
    acked: item.status !== "open",
    resolved: item.status === "resolved",
    detail: item.summary,
    silencedUntil: index === 4 ? agoIso(-2 * 3600 * 1000) : undefined,
  }));
  alerts.push({
    id: "al-resource-hel",
    title: "مصرف RAM هلسینکی-۰۱",
    severity: "warning",
    category: "high-resource",
    serverId: "eu-hel-01",
    createdAt: agoIso(90 * 60 * 1000),
    acked: false,
    resolved: false,
    detail: "RAM نمونه به ۸۸٪ رسیده است. آستانه سلامت میزبان هنوز ۹۰٪ است.",
  });
  alerts.push({
    id: "al-failover-old",
    incidentId: "inc-old-fo",
    title: "Failover تمرینی فرانکفورت-۰۳",
    severity: "info",
    category: "failover",
    nodeId: "1003",
    createdAt: agoIso(6 * 86400 * 1000),
    acked: true,
    resolved: true,
    detail: "رویداد تاریخی نمونه که پس از پایداری به مسیر اصلی بازگشت.",
  });

  const failoverEvents: FailoverEvent[] = [
    {
      id: "fe-1003",
      nodeId: "1003",
      at: agoIso(6 * 86400 * 1000),
      scenario: "primary-failure",
      fromServerId: "ir-thr-02",
      toServerId: "ir-bak-01",
      result: "rolled-back",
      state: "HEALTHY",
      summary: "تمرین گذشته با موفقیت سوییچ و سپس به مسیر اصلی بازگردانده شد.",
    },
    {
      id: "fe-1010",
      nodeId: "1010",
      at: agoIso(2 * 86400 * 1000),
      scenario: "tunnel-failure",
      fromServerId: "ir-thr-01",
      toServerId: "ir-bak-01",
      result: "success",
      state: "RECOVERED",
      summary: "سوییچ تمرینی انجام شد و در داده پایه فعلی مسیر اصلی دوباره فعال است.",
    },
    {
      id: "fe-1007",
      nodeId: "1007",
      at: agoIso(20 * 3600 * 1000),
      scenario: "validation-failed",
      fromServerId: "ir-thr-01",
      toServerId: "ir-isf-bak-01",
      result: "failed",
      state: "FAILED",
      summary: "راستی‌آزمایی انتهایی در تمرین قبلی شکست خورد و DNS به حالت قبل برگشت.",
    },
  ];

  const audit: AuditEvent[] = [
    { id: "au-1", at: agoIso(6 * 86400 * 1000), actor: "رضا مرادی", role: "super-admin", action: "failover.simulate", target: "نود 1003", detail: "تمرین Failover و بازگشت", simulated: true },
    { id: "au-2", at: agoIso(5 * 86400 * 1000), actor: "سارا کیانی", role: "infra-admin", action: "deploy.fail", target: "ap-sgp-01", detail: "نصب GOST در پیش‌بررسی متوقف شد", simulated: true },
    { id: "au-3", at: agoIso(3 * 3600 * 1000), actor: "سارا کیانی", role: "infra-admin", action: "incident.ack", target: "inc-1018", detail: "عدم تطابق DNS تأیید شد", simulated: true },
    { id: "au-4", at: agoIso(26 * 3600 * 1000), actor: "آرمان نوری", role: "operator", action: "dns.check", target: "نود 1011", detail: "بررسی رکورد پروکسی‌شده", simulated: true },
    { id: "au-5", at: agoIso(90 * 60 * 1000), actor: "سیستم نمونه", role: "operator", action: "alert.raise", target: "eu-hel-01", detail: "هشدار RAM", simulated: true },
  ];

  const deployments: DeploymentJob[] = [
    {
      id: "job-agent-fra",
      createdAt: agoIso(9 * 86400 * 1000),
      serverId: "eu-fra-01",
      component: "NodeGuard Agent",
      status: "completed",
      outcome: "success",
      options: { version: "1.4.2", region: "eu" },
      preflight: [
        { name: "سیستم‌عامل", ok: true, detail: "Ubuntu 24.04 پشتیبانی می‌شود." },
        { name: "دسترسی", ok: true, detail: "دسترسی نمونه تأیید شد." },
      ],
      logs: [
        { at: agoIso(9 * 86400 * 1000), line: "شروع نصب نمایشی عامل" },
        { at: agoIso(9 * 86400 * 1000 - 20_000), line: "خدمت nodeguard-agent فعال شد" },
      ],
      configPreview: "agent:\n  id: ag-eu-fra-01\n  mode: demo\n",
    },
    {
      id: "job-gost-sgp",
      createdAt: agoIso(5 * 86400 * 1000),
      serverId: "ap-sgp-01",
      component: "GOST",
      status: "failed",
      outcome: "fail",
      options: { port: "4430" },
      preflight: [
        { name: "پورت", ok: false, detail: "پورت ۴۴۳۰ در سناریوی نمونه اشغال گزارش شد." },
        { name: "منابع", ok: true, detail: "CPU و RAM کافی است." },
      ],
      logs: [
        { at: agoIso(5 * 86400 * 1000), line: "پیش‌بررسی پورت ناموفق بود" },
        { at: agoIso(5 * 86400 * 1000 - 10_000), line: "نصب متوقف شد. دستوری اجرا نشده است" },
      ],
      configPreview: "services:\n  gost:\n    listen: :4430\n    mode: demo\n",
    },
  ];

  const speedtests: SpeedtestResult[] = [
    {
      id: "st-1",
      createdAt: agoIso(5 * 3600 * 1000),
      mode: "tunnel",
      sourceServerId: "ir-thr-01",
      destServerId: "eu-fra-01",
      tunnelId: "tn-1001-p",
      nodeId: "1001",
      protocol: "tcp",
      direction: "download",
      reverse: false,
      durationSec: 15,
      streams: 4,
      avgMbps: 812,
      maxMbps: 864,
      minMbps: 740,
      rttMs: 36,
      jitterMs: 2.1,
      lossPct: 0.1,
      samples: [740, 790, 820, 864, 830].map((mbps, t) => ({ t, mbps })),
      status: "completed",
    },
    {
      id: "st-2",
      createdAt: agoIso(26 * 3600 * 1000),
      mode: "internet",
      sourceServerId: "eu-ams-01",
      protocol: "tcp",
      direction: "bidirectional",
      reverse: false,
      durationSec: 10,
      streams: 2,
      avgMbps: 540,
      maxMbps: 610,
      minMbps: 470,
      rttMs: 18,
      jitterMs: 1.4,
      lossPct: 0,
      samples: [470, 520, 610, 540].map((mbps, t) => ({ t, mbps })),
      status: "completed",
    },
  ];

  const integrations: Integration[] = [
    {
      id: "int-v2board",
      type: "v2board",
      name: "V2Board",
      status: "connected",
      lastSync: agoIso(6 * 60 * 1000),
      lastTest: agoIso(6 * 60 * 1000),
      message: "همگام‌سازی نمونه ۲۴ نود را برگرداند. API واقعی فراخوانی نشده است.",
      config: {
        panelUrl: "https://panel.nodeguard.example",
        securePath: "/demo-admin",
        apiStyle: "v2board-admin-v1",
        token: "vb_demo_token_example",
        syncMinutes: "5",
        imported: "24",
      },
    },
    {
      id: "int-cloudflare",
      type: "cloudflare",
      name: "Cloudflare DNS",
      status: "connected",
      lastSync: agoIso(12 * 60 * 1000),
      lastTest: agoIso(12 * 60 * 1000),
      message: "ناحیه نمونه nodeguard.example متصل است. هیچ رکورد واقعی تغییر نمی‌کند.",
      config: {
        zone: "nodeguard.example",
        account: "demo-account",
        token: "cfut_demo_example_token",
      },
    },
    {
      id: "int-agent",
      type: "agent",
      name: "NodeGuard Agent",
      status: "degraded",
      lastSync: agoIso(20_000),
      message: "۱۶ عامل آنلاین هستند و عامل تهران-پشتیبان-۰۲ قطع است.",
      config: {
        channel: "wss://agent.nodeguard.example/demo",
        version: "1.4.2",
      },
    },
  ];

  return {
    nodes,
    servers,
    tunnels,
    dns,
    alerts,
    incidents,
    failoverEvents,
    policies,
    audit,
    deployments,
    speedtests,
    logs: buildLogs(),
    integrations,
    settings,
    users: DEMO_USERS,
  };
}

export function craftLog(snapshot: Pick<DemoSnapshot, "servers" | "nodes">): LogEntry {
  const foreign = snapshot.servers.filter((server) => server.roles.includes("foreign"));
  const server = foreign[Math.floor(Math.random() * foreign.length)] ?? foreign[0];
  const shared = Math.random() > 0.55;
  const node = snapshot.nodes[Math.floor(Math.random() * snapshot.nodes.length)];
  const severity: LogSeverity = Math.random() > 0.92 ? "ERROR" : Math.random() > 0.8 ? "WARNING" : "INFO";
  return {
    id: `log-live-${Date.now()}`,
    ts: new Date().toISOString(),
    severity,
    serverId: server?.id,
    nodeId: shared ? undefined : node?.id,
    source: shared ? "v2bx-shared" : "v2bx-node",
    message: shared
      ? `[V2bX] رویداد مشترک سرویس روی ${server?.name ?? "میزبان"}`
      : `[V2bX] رویداد نود ${node?.id}؛ این خط به همان نود تعلق دارد`,
  };
}
