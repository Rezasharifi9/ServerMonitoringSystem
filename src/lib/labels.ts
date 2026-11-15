import type {
  AlertCategory,
  AlertSeverity,
  DemoRole,
  DeployStatus,
  DnsStatus,
  FailoverScenario,
  FailoverState,
  HealthStatus,
  LogSeverity,
  ServerRole,
  TimeRange,
  TunnelTech,
} from "@/types";

export const healthLabel: Record<HealthStatus, string> = {
  healthy: "سالم",
  degraded: "ناپایدار",
  offline: "آفلاین",
};

export const roleLabel: Record<ServerRole, string> = {
  iran: "سرور ایران",
  "iran-primary": "سرور ایران",
  "iran-backup": "سرور ایران",
  foreign: "سرور خارجی",
};

export const dnsLabel: Record<DnsStatus, string> = {
  matched: "منطبق",
  mismatched: "عدم تطابق",
  propagation: "در انتظار تطبیق",
  stale: "مشاهدهٔ کهنه",
  proxied: "پروکسی‌شده",
  cname: "CNAME شناسایی شد",
  error: "خطای وضوح",
};

export const failoverStateLabel: Record<FailoverState, string> = {
  HEALTHY: "سالم",
  SUSPECT: "مشکوک",
  CONFIRMED_DOWN: "قطعی تأییدشده",
  PREPARING_BACKUP: "آماده‌سازی پشتیبان",
  SWITCHING: "در حال سوییچ",
  VERIFYING: "در حال راستی‌آزمایی",
  RECOVERED: "بازیابی‌شده",
  ROLLBACK: "بازگشت",
  FAILED: "ناموفق",
};

export const scenarioLabel: Record<FailoverScenario, string> = {
  "primary-failure": "خرابی سرور اصلی",
  "tunnel-failure": "خرابی تونل",
  "v2bx-failure": "خرابی سرویس V2bX",
  "dns-mismatch": "عدم تطابق DNS",
  "backup-unavailable": "پشتیبان در دسترس نیست",
  "validation-failed": "شکست راستی‌آزمایی بازیابی",
  "auto-recovery": "بازیابی خودکار موفق",
};

export const severityLabel: Record<AlertSeverity, string> = {
  info: "اطلاع",
  warning: "هشدار",
  critical: "بحرانی",
};

export const categoryLabel: Record<AlertCategory, string> = {
  "server-offline": "سرور آفلاین",
  "agent-disconnected": "قطع عامل",
  "tunnel-disconnected": "قطع تونل",
  "high-loss": "اتلاف بسته بالا",
  "high-rtt": "تأخیر بالا",
  "high-resource": "مصرف بالای منابع",
  "dns-mismatch": "عدم تطابق DNS",
  "proxy-unreachable": "قطعی سرتاسری پروکسی",
  "v2bx-failure": "خرابی V2bX",
  "deploy-failed": "شکست استقرار",
  failover: "اجرای Failover",
  "backup-unavailable": "پشتیبان ناموجود",
  "tls-expiry": "انقضای گواهی TLS",
};

export const logSeverityLabel: Record<LogSeverity, string> = {
  DEBUG: "اشکال‌زدایی",
  INFO: "اطلاعات",
  WARNING: "هشدار",
  ERROR: "خطا",
  CRITICAL: "بحرانی",
};

export const rangeLabel: Record<TimeRange, string> = {
  "15m": "۱۵ دقیقه اخیر",
  "1h": "۱ ساعت اخیر",
  "6h": "۶ ساعت اخیر",
  "24h": "۲۴ ساعت اخیر",
  "7d": "۷ روز اخیر",
  "30d": "۳۰ روز اخیر",
};

export const demoRoleLabel: Record<DemoRole, string> = {
  "super-admin": "ابرمدیر",
  "infra-admin": "مدیر زیرساخت",
  operator: "اپراتور",
  readonly: "فقط مشاهده",
};

export const deployStatusLabel: Record<DeployStatus, string> = {
  pending: "در انتظار",
  validating: "اعتبارسنجی",
  installing: "نصب",
  configuring: "پیکربندی",
  testing: "آزمایش",
  completed: "تکمیل‌شده",
  failed: "ناموفق",
  "rolled-back": "بازگردانده‌شده",
};

export const techKindLabel: Record<TunnelTech, string> = {
  GRE: "رابط شبکه",
  IPIP: "رابط شبکه",
  SIT: "رابط شبکه",
  WireGuard: "رابط شبکه",
  GRE6: "رابط شبکه",
  Geneve: "رابط شبکه",
  GOST: "هدایت پورت",
  Backhaul: "هدایت پورت",
  Rathole: "هدایت پورت",
};

export const dimensionLabel = {
  agent: "سلامت عامل",
  host: "سلامت میزبان",
  reachability: "دسترسی شبکه",
  tunnel: "تونل / رابط",
  v2bx: "سرویس V2bX",
  dns: "سلامت DNS",
  e2e: "اتصال سرتاسری",
  backup: "آمادگی پشتیبان",
} as const;

export const RANGES: TimeRange[] = ["15m", "1h", "6h", "24h", "7d", "30d"];
