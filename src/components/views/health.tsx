"use client";

import Link from "next/link";
import { useState } from "react";
import { PageHeader, Tech } from "@/components/shared/chrome";
import { HealthDot, StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui/kit";
import { TrendChart } from "@/components/charts/trend-chart";
import { AvailabilityTrend } from "@/components/charts/availability-trend";
import { assessNode } from "@/lib/health";
import { buildMetrics } from "@/lib/metrics";
import { useI18n } from "@/i18n/provider";
import { useBackend, useObservedAvailability } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";

export function HealthView() {
  const { t, copy } = useI18n();
  const monitor = useBackend((state) => state.mode === "monitor");
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const dns = useInfraStore((state) => state.dns);
  const settings = useInfraStore((state) => state.settings);
  const [q, setQ] = useState("");
  const reports = nodes.map((node) => assessNode(node, servers, tunnels, dns, settings, monitor)).filter((report) => {
    const node = nodes.find((item) => item.id === report.nodeId);
    return !q || `${node?.name} ${report.nodeId}`.includes(q);
  });
  const avg = Math.round(reports.reduce((sum, report) => sum + report.score, 0) / Math.max(reports.length, 1));
  const availability = useObservedAvailability("24h", monitor);
  const series = monitor ? [] : buildMetrics("24h", "health", nodes.filter((node) => node.health === "offline").length / 10);

  return (
    <div className="space-y-4">
      <PageHeader title={t("monitoring.healthTitle")} description={t("monitoring.healthDescription")} />
      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardHeader><CardTitle>{t("monitoring.overallScore")}</CardTitle></CardHeader><CardContent className="text-3xl font-semibold">{avg}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t("monitoring.withoutStandby")}</CardTitle></CardHeader><CardContent className="text-3xl font-semibold">{reports.filter((report) => !report.backupReady).length}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t("monitoring.dependencyTitle")}</CardTitle></CardHeader><CardContent className="text-sm leading-7">{t("monitoring.dependencyBody")}</CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>{monitor ? t("monitoring.activeProbes24h") : t("monitoring.availabilityTrend")}</CardTitle></CardHeader>
        <CardContent>{monitor ? <AvailabilityTrend data={availability.data} loading={availability.isLoading} failed={availability.isError} />
          : <TrendChart data={series} series={[{ key: "availability", name: t("monitoring.availability"), color: "#14b8a6" }]} />}</CardContent>
      </Card>
      <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t("monitoring.searchNodes")} />
      <div className="space-y-3">
        {reports.map((report) => {
          const node = nodes.find((item) => item.id === report.nodeId);
          return (
            <Card key={report.nodeId}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle><Link className="text-primary" href={`/nodes/${report.nodeId}`}>{node?.name}</Link></CardTitle>
                <StatusBadge value={report.status} />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {report.dimensions.map((dimension) => (
                    <span key={dimension.key} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs" title={copy(dimension.summary)}>
                      <HealthDot status={dimension.status} />
                      {t(`common.dimensions.${dimension.key}`)}
                      <Tech>{dimension.score}</Tech>
                    </span>
                  ))}
                </div>
                <p className="text-sm">{copy(report.rootCause)}</p>
                <p className="text-sm text-muted-foreground">{copy(report.recommendation)}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
