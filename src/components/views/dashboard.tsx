"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import Link from "next/link";
import { Activity, Users, ShieldCheck, TriangleAlert, Unplug, ArrowUpRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { BarTrend, TrendChart } from "@/components/charts/trend-chart";
import { toast } from "sonner";
import { DataTable } from "@/components/shared/data-table";
import { dashboardNodeCounts } from "@/lib/dashboard";
import { can } from "@/lib/rbac";
import { useCurrentUser } from "@/stores/infra-store";
import { telemetryIntervals } from "@/lib/telemetry-policy";
import { KpiCard, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle, Select, Button } from "@/components/ui/kit";
import { chartLabel } from "@/lib/format";
import { RANGES } from "@/lib/labels";
import { rangeMeta } from "@/lib/metrics";
import { useFormat, useI18n } from "@/i18n/provider";
import { panelOnlineSummary } from "@/lib/node-inventory";
import { getPanelOnlineSnapshot, getIranBandwidth, observedMetricSeries, useBackend, useInfraAction } from "@/services/backend";
import { getMetrics } from "@/services/api";
import { useInfraStore } from "@/stores/infra-store";
import type { TimeRange } from "@/types";
import { useV2BoardCatalog } from "./v2board-inventory";

export function DashboardView() {
  const { t, copy, locale } = useI18n();
  const format = useFormat();
  const range = useInfraStore((state) => state.range);
  const setRange = useInfraStore((state) => state.setRange);
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const alerts = useInfraStore((state) => state.alerts);
  const rules = useInfraStore((state) => state.settings.metricAlertRules) ?? [];
  const events = useInfraStore((state) => state.failoverEvents);
  const audit = useInfraStore((state) => state.audit);
  const settings = useInfraStore((state) => state.settings);
  const monitor = useBackend((state) => state.mode === "monitor");
  const recentAlerts = alerts.filter((alert) => !alert.archived && (!monitor || rules.some((rule) => rule.enabled && rule.id === alert.metricRuleId)));
  const catalog = useV2BoardCatalog(monitor);
  const user = useCurrentUser();
  const archive = useInfraAction("archiveAlert");
  const archiveLock = useRef(new Set<string>());
  const [archiving, setArchiving] = useState<string[]>([]);
  const presence = useQuery({ queryKey: ["dashboard-online", user.id], queryFn: getPanelOnlineSnapshot,
    enabled: monitor, staleTime: 0, refetchOnMount: "always", retry: false });
  const live = !presence.isFetching && !presence.isError ? presence.data : undefined;
  const online = useMemo(() => panelOnlineSummary(live?.nodes ?? []), [live]);
  const counts = dashboardNodeCounts(catalog.data?.nodes ?? [], nodes, tunnels,
    Math.max(90000, settings.monitoringIntervalSec * 3000,
      (settings.telemetryIntervals?.tunnelProbe ?? telemetryIntervals.tunnelProbe) * 2000 + 30000));
  const bandwidth = useQuery({ queryKey: ["iran-bandwidth", monitor, range], queryFn: () => getIranBandwidth(range),
    enabled: monitor, refetchInterval: (query) => pollingInterval(query, POLLING.metrics) });
  const presenceByKey = new Map(live?.nodes.map((item) => [item.key, item]));
  const onlineRows = (catalog.data?.nodes ?? []).map((entry) => ({ ...entry,
    online: presenceByKey.get(entry.key)?.online }));
  async function archiveRecent(id: string) {
    if (!can(user.role, "alert.manage") || archiveLock.current.has(id)) return;
    archiveLock.current.add(id);
    setArchiving([...archiveLock.current]);
    try {
      const error = await archive(id);
      if (error) toast.error(copy(error)); else toast.success(t("alerts.archived"));
    } catch { toast.error(t("dashboard.archiveFailed")); }
    finally { archiveLock.current.delete(id); setArchiving([...archiveLock.current]); }
  }
  const stress = useMemo(() => {
    const offline = nodes.filter((node) => node.health === "offline").length;
    const degraded = nodes.filter((node) => node.health === "degraded").length;
    return Math.min(1, (offline * 1.4 + degraded * 0.45) / Math.max(nodes.length, 1));
  }, [nodes]);
  const metrics = useQuery({
    queryKey: ["metrics", monitor, range, locale, monitor ? 0 : Math.round(stress * 20)],
    queryFn: () => monitor ? observedMetricSeries(range) : getMetrics({ range, stress }),
    refetchInterval: (query) => pollingInterval(query, monitor ? POLLING.metrics : false),
    placeholderData: monitor ? undefined : keepPreviousData,
  });
  const serverName = (id?: string) => servers.find((server) => server.id === id)?.name ?? "—";
  const activeTunnels = tunnels.filter((tunnel) => tunnel.side === "primary" && tunnel.status !== "offline").length;
  const failedTunnels = tunnels.filter((tunnel) => tunnel.side === "primary" && tunnel.status === "offline").length;
  const points = metrics.data ?? [];
  const failoverSeries = bucket(events.map((item) => item.at), range, locale);

  return (
    <div className="dashboard-view min-w-0">
      <PageHeader
        title={t("dashboard.title")}
        description={monitor ? t("dashboard.descriptionMonitor") : t("dashboard.descriptionDemo")}
        actions={
          <Select value={range} onChange={(event) => setRange(event.target.value as TimeRange)} className="w-44" aria-label={t("common.range." + range)}>
            {RANGES.map((item) => <option key={item} value={item}>{t(`common.range.${item}`)}</option>)}
          </Select>
        }
      />
      {monitor && alerts.filter((alert) => alert.id.startsWith("failover-switch:") && !alert.archived && !alert.resolved).map((alert) =>
        <Link key={alert.id} href="/settings?tab=failover"
          className="block rounded-lg border border-red-500 bg-red-500/10 p-3 text-red-600 dark:text-red-300">
          <strong>{copy(alert.title)}</strong><span className="block text-sm">{copy(alert.detail)}</span>
        </Link>)}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard icon={<Activity size={18} />} label={t("dashboard.nodes")} value={monitor ? catalog.data?.syncedAt ? catalog.data.nodes.length : "—" : nodes.length} hint={t("dashboard.syncedNodes")} />
        <KpiCard icon={<Users size={18} />} label={t("dashboard.onlineUsers")} value={live && online.reported.length ? format.formatNumber(online.total) : "—"}
          hint={presence.isError ? t("dashboard.onlineFailed") : live ? !online.reported.length ? t("dashboard.onlineMissing") : t(online.shared ? "dashboard.onlineShared" : "dashboard.onlineHint", { time: format.formatDateTime(live.fetchedAt) }) : t("dashboard.onlineWaiting")} />
        <KpiCard icon={<ShieldCheck size={18} />} tone="success" label={t("dashboard.healthy")} value={counts.healthy} />
        <KpiCard icon={<TriangleAlert size={18} />} tone="warning" label={t("dashboard.degraded")} value={counts.degraded} />
        <KpiCard icon={<Unplug size={18} />} tone="destructive" label={t("dashboard.offline")} value={counts.offline} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("dashboard.healthOverlap")} {t("dashboard.unknownNodes", { count: counts.unknown })}</p>
      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <Card><CardHeader><CardTitle>{t("dashboard.iranBandwidth")}</CardTitle><p className="text-xs text-muted-foreground">{t("dashboard.bandwidthHint")}</p></CardHeader><CardContent>
          {monitor ? bandwidth.isLoading ? <ChartSkeleton /> : bandwidth.isError ? <p>{t("dashboard.metricsFailed")}</p>
            : !bandwidth.data?.some((point) => point.bandwidth !== null) ? <p>{t("dashboard.noData")}</p>
              : <TrendChart data={bandwidth.data} observedTime series={[{ key: "bandwidth", name: "Mbps", color: "#14b8a6", stream: "traffic" }]} />
            : <TrendChart data={points} series={[{ key: "bandwidth", name: "Mbps", color: "#14b8a6" }]} />}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t("dashboard.loss")}</CardTitle></CardHeader><CardContent>{metrics.isLoading ? <ChartSkeleton /> : metrics.isError ? <p>{t("dashboard.metricsFailed")}</p> : !points.length ? <p>{t("dashboard.noData")}</p> : <TrendChart data={points} observedTime={monitor} series={[{ key: "loss", name: t("dashboard.percent"), color: "#f59e0b" }]} />}</CardContent></Card>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        {monitor && <Card>
          <CardHeader><CardTitle>{t("dashboard.onlineByNode")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 [&_table]:min-w-0">
            {presence.isFetching && <p role="status">{t("dashboard.onlineWaiting")}</p>}
            {presence.isError && <div role="alert"><p>{t("dashboard.onlineFailed")}</p><Button variant="outline" onClick={() => void presence.refetch()}>{t("common.retry")}</Button></div>}
            {live && <p className="text-xs text-muted-foreground">{t(online.shared ? "dashboard.onlineShared" : "dashboard.onlineHint", { time: format.formatDateTime(live.fetchedAt) })}</p>}
            <DataTable data={onlineRows} pageSize={8} keepPage columns={[
              { accessorKey: "name", header: t("dashboard.nodeName"), cell: ({ row }) => row.original.nodeId
                ? <Link className="text-primary" href={`/nodes/${encodeURIComponent(row.original.nodeId)}`}>{row.original.name}</Link> : row.original.name },
              { accessorKey: "online", header: t("dashboard.onlineUsers"), cell: ({ row }) => <Tech>{typeof row.original.online === "number" ? format.formatNumber(row.original.online) : "—"}</Tech> },
            ]} />
          </CardContent>
        </Card>}
        <Card>
          <CardHeader><CardTitle>{t("dashboard.recentIncidents")}</CardTitle><Link className="inline-flex items-center gap-1 text-xs text-primary" href="/alerts?scope=archived">{t("dashboard.viewArchive")}<ArrowUpRight size={13} aria-hidden="true" /></Link></CardHeader>
          <CardContent className="space-y-3">
            {!recentAlerts.length && <p className="text-sm text-muted-foreground">{t("alerts.emptyCurrent")}</p>}
            {[...recentAlerts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5).map((alert) => (
              <button key={alert.id} type="button" disabled={!can(user.role, "alert.manage") || archiving.includes(alert.id)} onClick={() => void archiveRecent(alert.id)}
                aria-label={`${t("alerts.archive")}: ${copy(alert.title)}`} className="block w-full incident-row rounded-xl border border-border p-4 text-start hover:border-primary/40 disabled:cursor-default disabled:opacity-60">
                <span className="flex items-center justify-between gap-2"><span>{copy(alert.title)}</span><StatusBadge value={alert.severity} /></span>
                <span className="mt-1 block text-xs text-muted-foreground">{copy(alert.detail)} · {format.formatDateTime(alert.createdAt)}</span>
              </button>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("dashboard.leastStable")}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {[...nodes].sort((a, b) => b.packetLoss - a.packetLoss).slice(0, 5).map((node) => (
              <Link key={node.id} href={`/nodes/${node.id}`} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-muted">
                <span>{node.name}</span>
                <span className="flex items-center gap-2 text-xs"><Tech>{format.formatPercent(node.packetLoss, 1)}</Tech><StatusBadge value={node.health} /></span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("dashboard.serversAttention")}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {servers.filter((server) => server.status !== "healthy" || server.cpu >= 80 || server.ram >= 85 || server.disk >= 80 || server.agent.status !== "online").map((server) => (
              <Link key={server.id} href={`/servers/${server.id}`} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-muted">
                <span>{server.name}</span>
                <span className="text-xs text-muted-foreground">{t("dashboard.resources", { cpu: Math.round(server.cpu), ram: Math.round(server.ram) })}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card><CardHeader><CardTitle>{t("dashboard.failoverHistory")}</CardTitle></CardHeader><CardContent><BarTrend data={failoverSeries} yKey="count" name={t("dashboard.operation")} color="#38bdf8" /></CardContent></Card>
        <Card>
          <CardHeader><CardTitle>{t("dashboard.recentFailover")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {events.slice(0, 3).map((event) => (
              <div key={event.id}>
                <div className="flex items-center justify-between"><span>{t("dashboard.nodeRef", { id: event.nodeId })}</span><StatusBadge value={event.result} /></div>
                <p className="text-xs text-muted-foreground">{copy(event.summary)} · {serverName(event.toServerId)} · {format.formatDateTime(event.at)}</p>
              </div>
            ))}
            <div className="border-t border-border pt-3">
              {audit.slice(0, 4).map((item) => (
                <div key={item.id} className="py-1 text-xs text-muted-foreground">{format.formatDateTime(item.at)} · {item.actor} · {copy(item.detail)}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <KpiCard label={t("dashboard.activeTunnels")} value={activeTunnels} />
        <KpiCard label={t("dashboard.downTunnels")} value={failedTunnels} />
        <KpiCard label={t("dashboard.activeAlerts")} value={alerts.filter((alert) => !alert.archived && !alert.resolved).length} />
      </div>
    </div>
  );
}

function bucket(times: string[], range: TimeRange, locale: "en-US" | "fa-IR") {
  const { span, points } = rangeMeta(range);
  const end = Date.now();
  const step = span / points;
  const start = end - span;
  const series = Array.from({ length: points }, (_, index) => ({ label: chartLabel(start + index * step, span, locale), count: 0 }));
  for (const time of times) {
    const at = Date.parse(time);
    if (at >= start && at <= end) series[Math.min(points - 1, Math.floor((at - start) / step))].count += 1;
  }
  return series;
}

function ChartSkeleton() {
  return <div className="h-60 animate-pulse rounded-lg bg-muted" />;
}
