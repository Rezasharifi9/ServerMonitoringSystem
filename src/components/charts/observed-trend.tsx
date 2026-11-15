"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { observedMetricSeries } from "@/services/backend";
import type { TimeRange } from "@/types";
import { TrendChart } from "./trend-chart";

const chartRanges = ["1h", "6h", "24h", "7d"] satisfies TimeRange[];

export function ObservedTrend({ scope, series, yDomain }: {
  scope: { serverId: string } | { tunnelId: string };
  series: { key: string; name: string; color: string }[];
  yDomain?: [number, number];
}) {
  const { t } = useI18n();
  const [range, setRange] = useState<TimeRange>("1h");
  const query = useQuery({
    queryKey: ["observed-metrics", scope, range],
    queryFn: () => observedMetricSeries(range, scope),
    refetchInterval: (query) => pollingInterval(query, POLLING.metrics),
  });
  const points = query.data ?? [];
  const hasSignal = points.some((point) =>
    series.some(({ key }) => typeof point[key as keyof typeof point] === "number" && Number(point[key as keyof typeof point]) !== 0));
  return <div className="space-y-3">
    <label className="flex flex-wrap items-center gap-2 text-sm">
      {t("monitoring.chartRange")}
      <Select className="w-40" value={range} onChange={(event) => setRange(event.target.value as TimeRange)}>
        {chartRanges.map((item) => <option key={item} value={item}>{t(`common.range.${item}`)}</option>)}
      </Select>
    </label>
    {query.isPending ? <p className="text-sm text-muted-foreground">{t("monitoring.readingMetrics")}</p>
      : query.isError ? <p className="text-sm text-destructive">{t("monitoring.metricsFailed")}</p>
      : !points.length ? <p className="text-sm text-muted-foreground">{t("monitoring.noMetrics")}</p>
      : <TrendChart data={points} series={series} yDomain={yDomain} showDots={hasSignal && points.length <= 200} observedTime />}
  </div>;
}
