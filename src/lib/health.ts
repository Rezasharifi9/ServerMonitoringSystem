import type {
  AppSettings,
  DNSRecord,
  DnsStatus,
  HealthCheck,
  HealthDimension,
  HealthStatus,
  Node,
  Server,
  Tunnel,
} from "@/types";
import { summarizeProxyProbes } from "./proxy-health";

export function activeServerId(node: Node) {
  return node.activeSide === "backup" && node.backupServerId ? node.backupServerId : node.primaryServerId;
}

export function activeTunnelId(node: Node) {
  return node.activeSide === "backup" && node.backupTunnelId ? node.backupTunnelId : node.primaryTunnelId;
}

export function byId<T extends { id: string }>(items: T[], id?: string) {
  return items.find((item) => item.id === id);
}

function statusFromScore(score: number): HealthStatus {
  if (score >= 85) return "healthy";
  if (score >= 55) return "degraded";
  return "offline";
}

function dnsCombined(record?: DNSRecord): DnsStatus {
  if (!record) return "error";
  if (record.stale) return "stale";
  if (record.resolverOnly) return record.resolverStatus;
  const values = [record.authoritativeStatus, record.resolverStatus];
  if (values.includes("error")) return "error";
  if (values.includes("mismatched")) return "mismatched";
  if (values.includes("propagation")) return "propagation";
  if (values.includes("cname")) return "cname";
  if (values.includes("proxied")) return "proxied";
  return "matched";
}

function dim(
  key: HealthDimension["key"],
  status: HealthStatus,
  score: number,
  summary: string,
): HealthDimension {
  return { key, status, score, summary };
}

export function assessNode(
  node: Node,
  servers: Server[],
  tunnels: Tunnel[],
  dnsRecords: DNSRecord[],
  settings: AppSettings,
  observed = false,
): HealthCheck {
  const foreign = byId(servers, node.foreignServerId);
  const backup = byId(servers, node.backupServerId);
  const active = byId(servers, activeServerId(node));
  const tunnel = byId(tunnels, activeTunnelId(node));
  const backupTunnel = byId(tunnels, node.backupTunnelId);
  const record = dnsRecords.find((item) => item.nodeId === node.id);
  const v2bx = foreign?.services.find((service) => service.name === "v2bx");
  const thresholds = settings.thresholds;

  let v2bxStatus: Node["v2bxStatus"] = "stopped";
  if (v2bx?.status === "running") v2bxStatus = "running";
  if (v2bx?.status === "degraded" || v2bx?.status === "restarting") v2bxStatus = "degraded";
  if (v2bxStatus === "running" && node.v2bxNodeState === "config-error") v2bxStatus = "degraded";
  if (node.v2bxNodeState === "disabled") v2bxStatus = "stopped";

  const agentOffline = active?.agent.status === "offline" || foreign?.agent.status === "offline";
  const agentDegraded = active?.agent.status === "degraded" || foreign?.agent.status === "degraded";
  const agent = agentOffline
    ? dim("agent", "offline", 15, "ضربان عامل روی مسیر فعال یا سرور خارجی قطع است.")
    : agentDegraded
      ? dim("agent", "degraded", 62, "عامل پاسخ می‌دهد اما نسخه یا ضربان ناپایدار است.")
      : dim("agent", "healthy", 100, "عامل NodeGuard روی مسیر فعال و سرور خارجی آنلاین است.");

  const hottest = Math.max(active?.cpu ?? 0, active?.ram ?? 0, active?.disk ?? 0, foreign?.cpu ?? 0);
  const hostOffline = active?.status === "offline" || foreign?.status === "offline";
  const hostPressure =
    (active?.cpu ?? 0) >= thresholds.cpu ||
    (active?.ram ?? 0) >= thresholds.ram ||
    (active?.disk ?? 0) >= thresholds.disk;
  const host = hostOffline
    ? dim("host", "offline", 10, "میزبان فعال یا سرور خارجی آفلاین است.")
    : active?.status === "degraded" || hostPressure
      ? dim("host", "degraded", 64, `مصرف منابع به ${Math.round(hottest)}٪ رسیده و نیاز به توجه دارد.`)
      : dim("host", "healthy", 100, "CPU، RAM و دیسک میزبان در محدوده عادی است.");

  const rtt = tunnel?.rttMs ?? 0;
  const loss = tunnel?.packetLoss ?? 100;
  const reach =
    !tunnel || tunnel.status === "offline"
      ? dim("reachability", "offline", 5, "مسیر فعال به کاوش شبکه پاسخ نمی‌دهد.")
      : observed && tunnel.kind === "forwarder"
        ? tunnel.forwarderProbe?.ok
          ? dim("reachability", "healthy", 100, `کاوش HTTPS از مسیر هدایت پورت در ${tunnel.forwarderProbe.elapsedMs} میلی‌ثانیه پاسخ داد.`)
          : dim("reachability", "degraded", 55, "کاوش تازهٔ HTTPS برای سرویس هدایت پورت در دسترس نیست.")
      : loss >= thresholds.lossPct || rtt >= thresholds.rttMs
        ? dim("reachability", "degraded", 58, `RTT ${Math.round(rtt)}ms و اتلاف ${loss.toFixed(1)}٪ از آستانه فراتر است.`)
        : dim("reachability", "healthy", 100, `RTT ${Math.round(rtt)}ms و اتلاف ${loss.toFixed(1)}٪ در محدوده قبول است.`);

  const tunnelDim =
    !tunnel
      ? dim("tunnel", "offline", 0, "تونل فعالی به این نود وصل نیست.")
      : tunnel.status === "offline"
          ? dim("tunnel", "offline", 8, "تونل یا سرویس هدایت پورت قطع است.")
          : tunnel.status === "degraded"
            ? dim("tunnel", "degraded", 55, "تونل برقرار است اما کیفیت مسیر افت کرده.")
            : dim("tunnel", "healthy", 100, tunnel.kind === "interface" ? "رابط تونل بالا است." : "سرویس هدایت پورت در حال اجرا است.");

  const v2bxDim =
    v2bxStatus === "stopped"
      ? dim("v2bx", "offline", 8, "فرآیند V2bX روی سرور خارجی متوقف است. خود تونل لزوماً خراب نیست.")
      : v2bxStatus === "degraded"
        ? dim("v2bx", "degraded", 60, "V2bX بالا است اما پیکربندی این نود ناپایدار است.")
        : dim("v2bx", "healthy", 100, "نمونه V2bX این نود را سرویس می‌دهد.");

  const dnsStatus = dnsCombined(record);
  const dnsDim =
    dnsStatus === "matched"
      ? dim("dns", "healthy", 100, "رکورد authoritative و مشاهده resolver با IP فعال یکی است.")
      : dnsStatus === "stale"
        ? dim("dns", "degraded", 48, "مهلت اعتبار آخرین مشاهدهٔ DNS گذشته است.")
      : dnsStatus === "propagation"
        ? dim("dns", "degraded", 72, "تطابق پاسخ resolver و رکورد DNS هنوز تأیید نشده است.")
        : dnsStatus === "proxied"
          ? dim("dns", "degraded", 68, "رکورد پشت پروکسی است و IP مبدأ پنهان مانده.")
          : dnsStatus === "cname"
            ? dim("dns", "degraded", 66, "CNAME شناسایی شده و سوییچ مستقیم A نیاز به بررسی دارد.")
            : dnsStatus === "mismatched"
              ? dim("dns", "degraded", 42, "IP یا مقصد DNS با مسیر مورد انتظار فرق دارد.")
              : dim("dns", "offline", 18, "وضوح DNS برای دامنه این نود ناموفق بود.");

  const e2eBroken = tunnelDim.status === "offline" || v2bxDim.status === "offline" || hostOffline;
  const e2eDegraded =
    tunnelDim.status === "degraded" ||
    v2bxDim.status === "degraded" ||
    reach.status === "degraded" ||
    dnsStatus === "mismatched" ||
    dnsStatus === "error";
  const proxy = observed ? summarizeProxyProbes(node, settings) : "unobserved";
  const probeDimensions = {
    up: dim("e2e", "healthy", 100, "کاوش‌های مستقل مسیر فعال موفق بودند."),
    down: dim("e2e", "offline", 0, "کاوش‌های مستقل قطعی مسیر فعال را تأیید کردند."),
    mixed: dim("e2e", "degraded", 55, "مشاهده‌گرهای مستقل دربارهٔ دسترسی به پروکسی نتیجه‌های متفاوتی گزارش دادند."),
    insufficient: dim("e2e", "degraded", 55, "تعداد گزارش‌های تازه برای تأیید وضعیت پروکسی کافی نیست."),
    unobserved: dim("e2e", "degraded", 0, "کاوش مستقل تازه برای این نود در دسترس نیست."),
  };
  const e2e = observed
    ? probeDimensions[proxy]
    : e2eBroken
    ? dim("e2e", "offline", 12, "کاربر نهایی روی این مسیر به پروکسی نمی‌رسد.")
    : e2eDegraded
      ? dim("e2e", "degraded", 60, "اتصال برقرار است اما کیفیت یا همگام‌سازی کامل نیست.")
      : dim("e2e", "healthy", 100, "مسیر کاربر تا خروج خارجی قابل استفاده است.");

  const backupTunnelDown = !backupTunnel || backupTunnel.status === "offline";
  const backupDown = !backup || backup.status === "offline" || backup.agent.status === "offline" || backupTunnelDown;
  const backupCapacity = backup ? 100 - backup.cpu : 0;
  const backupDim = !node.backupTunnelId
    ? dim("backup", "offline", 0, "مسیر پشتیبان برای این نود ثبت نشده است.")
    : backupDown
    ? dim("backup", "offline", 20, "سرور یا تونل پشتیبان آماده پذیرش ترافیک نیست.")
    : backupCapacity < settings.failover.minBackupCapacity
      ? dim("backup", "degraded", 58, "پشتیبان آنلاین است اما ظرفیت آزاد کم است.")
      : dim("backup", "healthy", 100, "پشتیبان و تونل جایگزین آماده‌اند.");

  const dimensions = [agent, host, reach, tunnelDim, v2bxDim, dnsDim, e2e, backupDim];
  const weights: Record<HealthDimension["key"], number> = {
    agent: 10,
    host: 10,
    reachability: 10,
    tunnel: 18,
    v2bx: 18,
    dns: 10,
    e2e: 19,
    backup: 5,
  };
  const scored = dimensions.filter(({ key }) => (key !== "e2e" || !observed || proxy !== "unobserved") &&
    (key !== "backup" || Boolean(node.backupTunnelId)));
  const score = Math.round(
    scored.reduce((sum, item) => sum + item.score * weights[item.key], 0) /
    scored.reduce((sum, item) => sum + weights[item.key], 0),
  );

  let status = statusFromScore(score);
  if (e2eBroken || proxy === "down") status = "offline";
  else if (scored.some((item) => item.key !== "backup" && item.status === "degraded")) status = "degraded";

  const root =
    proxy === "down" && !e2eBroken
      ? "مشاهده‌گرهای مستقل، اختلال در دسترسی از طریق کلاینت پروکسی را تأیید کردند."
      : (proxy === "mixed" || proxy === "insufficient") && !e2eBroken
      ? e2e.summary
      : v2bxDim.status === "offline" && tunnelDim.status === "healthy"
      ? "تونل سالم است. منبع محتمل حادثه، توقف سرویس V2bX روی سرور خارجی است."
      : tunnelDim.status === "offline"
        ? "قطع تونل بین سرور ایرانی فعال و سرور خارجی، دسترسی سرتاسری را مختل کرده است."
        : hostOffline
          ? "میزبان مسیر فعال آفلاین است و تا بازگشت یا Failover ترافیک سرویس نمی‌شود."
          : tunnelDim.status === "degraded"
            ? "کیفیت تونل افت کرده و تأخیر یا اتلاف بسته از آستانه گذشته است."
            : dnsStatus === "stale"
              ? "آخرین مشاهدهٔ DNS برای ارزیابی مسیر فعلی کافی نیست."
              : dnsStatus === "mismatched" || dnsStatus === "error"
              ? "مسیر شبکه ممکن است سالم باشد، اما DNS کاربر را به مقصد درست نمی‌رساند."
              : reach.status === "degraded"
                ? "کیفیت مسیر به‌خاطر تأخیر یا اتلاف بسته افت کرده است."
                : backupDim.status !== "healthy"
                  ? "سرویس فعلی پایدار است، اما آمادگی پشتیبان کامل نیست."
                  : "بعد تازه‌ای از خرابی دیده نمی‌شود.";

  const recommendation =
    v2bxDim.status === "offline"
      ? "راه‌اندازی مجدد V2bX روی سرور خارجی را شبیه‌سازی کنید. سوییچ DNS به ایران پشتیبان این خطا را برطرف نمی‌کند."
      : tunnelDim.status === "offline"
        ? "تشخیص تونل را اجرا کنید یا Failover به مسیر پشتیبان را شبیه‌سازی کنید."
        : hostOffline
          ? "اگر پشتیبان آماده است Failover را شبیه‌سازی کنید و سپس میزبان اصلی را بررسی کنید."
          : dnsStatus === "stale"
            ? "آخرین بررسی DNS منقضی شده است. رکورد را دوباره از سرویس‌دهنده بخوانید."
          : dnsStatus === "mismatched"
            ? observed ? "رکورد را از سرویس‌دهندهٔ DNS بخوانید و با IP مسیر فعال مقایسه کنید."
              : "پیش‌نمایش تغییر DNS را ببینید و سوییچ شبیه‌سازی‌شده را فقط پس از تأیید اجرا کنید."
            : backupDim.status !== "healthy"
              ? "قبل از اتکا به Failover خودکار، عامل و تونل سرور پشتیبان را بازیابی کنید."
              : "پایش را ادامه دهید. اقدام فوری لازم نیست.";

  return {
    nodeId: node.id,
    score,
    status,
    dimensions,
    rootCause: root,
    recommendation,
    checkedAt: new Date().toISOString(),
    backupReady: backupDim.status === "healthy",
  };
}

export function decorateNode(
  node: Node,
  servers: Server[],
  tunnels: Tunnel[],
  dnsRecords: DNSRecord[],
  settings: AppSettings,
  observed = false,
): Node {
  const report = assessNode(node, servers, tunnels, dnsRecords, settings, observed);
  const tunnel = byId(tunnels, activeTunnelId(node));
  const foreign = byId(servers, node.foreignServerId);
  const v2bx = foreign?.services.find((service) => service.name === "v2bx");
  let v2bxStatus: Node["v2bxStatus"] = "stopped";
  if (v2bx?.status === "running") v2bxStatus = "running";
  if (v2bx?.status === "degraded" || v2bx?.status === "restarting") v2bxStatus = "degraded";
  if (v2bxStatus === "running" && node.v2bxNodeState === "config-error") v2bxStatus = "degraded";
  if (node.v2bxNodeState === "disabled") v2bxStatus = "stopped";
  const record = dnsRecords.find((item) => item.nodeId === node.id);
  return {
    ...node,
    health: report.status,
    rttMs: tunnel?.status === "offline" ? 0 : tunnel?.rttMs ?? 0,
    packetLoss: tunnel?.packetLoss ?? 0,
    jitterMs: tunnel?.jitterMs ?? 0,
    uptimePct: tunnel?.uptimePct ?? node.uptimePct,
    v2bxStatus,
    dnsStatus: dnsCombined(record),
  };
}

export function decorateNodes(
  nodes: Node[],
  servers: Server[],
  tunnels: Tunnel[],
  dnsRecords: DNSRecord[],
  settings: AppSettings,
  observed = false,
) {
  return nodes.map((node) => decorateNode(node, servers, tunnels, dnsRecords, settings, observed));
}
