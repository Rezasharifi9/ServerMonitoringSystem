"use client";

import { TrendChart } from "./trend-chart";
import { useI18n } from "@/i18n/provider";
import type { ObservedAvailability } from "@/types";

export function AvailabilityTrend({ data, loading, failed }: { data?: ObservedAvailability; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  if (loading) return <div role="status" aria-label={t("monitoring.readingProbes")} className="h-60 animate-pulse rounded-lg bg-muted" />;
  if (failed) return <p role="alert" className="text-sm text-muted-foreground">{t("monitoring.probeHistoryFailed")}</p>;
  if (!data?.proxy.samples) return <p className="text-sm text-muted-foreground">{t("monitoring.noActiveProbes")}</p>;
  return <TrendChart data={data.series} yDomain={[0, 100]} showDots={data.series.length <= 200} observedTime
    series={[{ key: "availability", name: t("monitoring.successfulProbes"), color: "#14b8a6" }]} />;
}
