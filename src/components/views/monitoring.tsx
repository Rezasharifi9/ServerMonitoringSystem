"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/shared/chrome";
import { Button, Card, CardHeader, CardContent, CardTitle, Select } from "@/components/ui/kit";
import { PersianDateTimePicker } from "@/components/ui/persian-datetime-picker";
import { TrendChart } from "@/components/charts/trend-chart";
import { observedMetricSeries, useBackend } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";
import { isIranServer } from "@/lib/topology";
import { POLLING, pollingInterval } from "@/lib/polling";
import { useI18n } from "@/i18n/provider";

const metrics = {
  ram: { name: "RAM", series: [{ key: "ram", name: "RAM (%)", color: "#a78bfa" }] },
  cpu: { name: "CPU", series: [{ key: "cpu", name: "CPU (%)", color: "#38bdf8" }] },
  packet: { name: "PacketLoss", series: [{ key: "serverLoss", name: "Packet loss (%)", color: "#fb7185" }] },
  tunnel: { name: "Tunnel PacketLoss", series: [{ key: "loss", name: "Tunnel loss (%)", color: "#fbbf24" }] },
  bandwidth: { name: "Bandwidth Server", series: [{ key: "rx", name: "RX (Mbps)", color: "#2dd4bf" }, { key: "tx", name: "TX (Mbps)", color: "#60a5fa" }] },
};
type Metric = keyof typeof metrics;
type Target = { id: string; name: string; subtitle: string };

function MonitorChart({ target, metric, live, bounds }: { target: Target; metric: Metric; live: boolean; bounds?: { from: number; to: number } }) {
  const { locale } = useI18n();
  const fa = locale === "fa-IR";
  const spec = metrics[metric];
  const query = useQuery({
    queryKey: ["fleet-monitoring", target.id, metric, live, bounds],
    queryFn: () => observedMetricSeries(bounds ? "24h" : "1h", metric === "tunnel" ? { tunnelId: target.id } : { serverId: target.id }, bounds),
    refetchInterval: q => pollingInterval(q, live ? POLLING.metrics : false),
    refetchOnWindowFocus: live,
  });
  const points = query.data ?? [];
  const hasData = points.some(p => spec.series.some(s => typeof (p as Record<string, unknown>)[s.key] === "number"));
  return <Card>
    <CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>{target.name}</CardTitle><span className="text-xs text-muted-foreground" dir="ltr">{spec.name}</span></div><p className="text-xs text-muted-foreground">{target.subtitle}</p></CardHeader>
    <CardContent>
      {query.isPending ? <p className="flex h-60 items-center justify-center text-sm text-muted-foreground">{fa ? "در حال دریافت داده‌ها…" : "Loading metrics…"}</p>
        : query.isError ? <div role="alert" className="flex h-60 flex-col items-center justify-center gap-3 text-sm text-destructive">{fa ? "دریافت اطلاعات ناموفق بود." : "Unable to load metrics."}<Button variant="outline" onClick={() => query.refetch()}>{fa ? "تلاش مجدد" : "Retry"}</Button></div>
        : !hasData ? <p className="flex h-60 items-center justify-center text-sm text-muted-foreground">{fa ? "داده‌ای در این بازه ثبت نشده است." : "No recorded samples in this period."}</p>
        : <TrendChart data={points} series={spec.series} yDomain={metric === "bandwidth" ? undefined : [0, 100]} observedTime />}
      <p className="mt-2 text-xs text-muted-foreground">{fa ? "آخرین دریافت: " : "Last refreshed: "}{query.dataUpdatedAt ? new Intl.DateTimeFormat(locale, { timeZone: "Asia/Tehran", timeStyle: "medium" }).format(query.dataUpdatedAt) : "—"}</p>
    </CardContent>
  </Card>;
}

export function MonitoringView() {
  const { locale } = useI18n();
  const fa = locale === "fa-IR";
  const monitor = useBackend(s => s.mode === "monitor");
  const servers = useInfraStore(s => s.servers);
  const tunnels = useInfraStore(s => s.tunnels);
  const [metric, setMetric] = useState<Metric>("ram");
  const [region, setRegion] = useState("iran");
  const [historical, setHistorical] = useState(false);
  const [now] = useState(() => Math.floor(Date.now() / 60000) * 60000);
  const [from, setFrom] = useState(now - 86400000);
  const [to, setTo] = useState(now);
  const [bounds, setBounds] = useState({ from, to });
  const [revision, setRevision] = useState(0);
  const selected = servers.filter(s => region === "all" || (region === "iran" ? isIranServer(s.roles) : s.roles.includes("foreign")));
  const ids = new Set(selected.map(s => s.id));
  const targets: Target[] = metric === "tunnel" ? tunnels.filter(t => ids.has(t.iranEndpoint.serverId) || ids.has(t.foreignEndpoint.serverId)).map(t => ({ id: t.id, name: t.name, subtitle: `${servers.find(s => s.id === t.iranEndpoint.serverId)?.name ?? t.iranEndpoint.serverId} ↔ ${servers.find(s => s.id === t.foreignEndpoint.serverId)?.name ?? t.foreignEndpoint.serverId}` })) : selected.map(s => ({ id: s.id, name: s.name, subtitle: isIranServer(s.roles) ? (fa ? "ایران" : "Iran") : (fa ? "خارج" : "Foreign") }));
  const invalid = to <= from || to - from > 30 * 86400000 || to > Date.now() + 60000;
  return <div className="space-y-5">
    <PageHeader title={fa ? "مانیتورینگ" : "Monitoring"} description={fa ? "مقایسهٔ مصرف منابع و کیفیت ارتباط تمامی سرورها در یک صفحه" : "Monitor fleet resources and connection quality in one place"} actions={<span className="flex items-center gap-2 rounded-full border border-border px-3 py-2 text-xs"><Activity size={14} className={historical ? "text-muted-foreground" : "text-emerald-400"} />{historical ? (fa ? "تاریخچه" : "History") : (fa ? "لحظه‌ای · بروزرسانی هر ۳۰ ثانیه" : "Live · refreshes every 30s")}</span>} />
    <Card><CardContent className="space-y-4 pt-5">
      <div className="grid items-end gap-4 md:grid-cols-3">
        <label className="space-y-2 text-sm"><span>{fa ? "نوع گزارش" : "Metric"}</span><Select value={metric} onChange={e => setMetric(e.target.value as Metric)}>{Object.entries(metrics).map(([key, spec]) => <option key={key} value={key}>{spec.name}</option>)}</Select></label>
        <label className="space-y-2 text-sm"><span>{fa ? "موقعیت سرورها" : "Server region"}</span><Select value={region} onChange={e => setRegion(e.target.value)}><option value="iran">{fa ? "سرورهای ایران" : "Iran servers"}</option><option value="foreign">{fa ? "سرورهای خارج" : "Foreign servers"}</option><option value="all">{fa ? "تمامی سرورها" : "All servers"}</option></Select></label>
        <label className="flex h-10 items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={historical} onChange={e => setHistorical(e.target.checked)} />{fa ? "نمایش تاریخچه" : "Historical mode"}</label>
      </div>
      {historical && <div className="space-y-3 border-t border-border pt-4"><div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"><PersianDateTimePicker label={fa ? "از تاریخ" : "From"} value={from} onChange={setFrom} /><PersianDateTimePicker label={fa ? "تا تاریخ" : "To"} value={to} onChange={setTo} /><Button disabled={invalid} onClick={() => { setBounds({ from, to }); setRevision(r => r + 1); }}><RefreshCw size={15} />{fa ? "اعمال بازه" : "Apply range"}</Button></div><p className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`} role={invalid ? "alert" : undefined}>{fa ? "زمان‌ها به وقت تهران؛ بازه باید در گذشته و حداکثر ۳۰ روز باشد. پس از انتخاب، اعمال بازه را بزنید." : "Times are Tehran local time. Choose a past period of up to 30 days, then apply."}</p></div>}
    </CardContent></Card>
    <div className="flex justify-between text-sm text-muted-foreground"><span>{targets.length} {fa ? (metric === "tunnel" ? "تونل" : "سرور") : (metric === "tunnel" ? "tunnels" : "servers")}</span><span dir="ltr">{metrics[metric].name} · {metric === "bandwidth" ? "Mbps" : "%"}</span></div>
    {!monitor ? <Card><CardContent className="pt-5">{fa ? "برای نمایش داده‌های واقعی و تاریخچه، حالت پایش را فعال کنید." : "Enable monitoring mode to view recorded and live telemetry."}</CardContent></Card> : !targets.length ? <Card><CardContent className="pt-5">{fa ? "سرور یا تونلی برای این موقعیت ثبت نشده است." : "No servers or tunnels match this region."}</CardContent></Card> : <div className="grid gap-4 xl:grid-cols-2">{targets.map(target => <MonitorChart key={`${target.id}-${revision}`} target={target} metric={metric} live={!historical} bounds={historical ? bounds : undefined} />)}</div>}
  </div>;
}
