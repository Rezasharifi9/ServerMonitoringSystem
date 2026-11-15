"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useTheme } from "next-themes";
import { useI18n } from "@/i18n/provider";
import { useInfraStore } from "@/stores/infra-store";
import { observedChartSeries } from "@/lib/chart-series";
import type { TelemetryStream } from "@/lib/telemetry-policy";

export function TrendChart<T extends object>({
  data,
  xKey = "label",
  series,
  height = 240,
  yDomain,
  showDots = false,
  observedTime = false,
}: {
  data: T[];
  xKey?: string;
  series: { key: string; name: string; color: string; stream?: TelemetryStream }[];
  height?: number;
  yDomain?: [number, number];
  showDots?: boolean;
  observedTime?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const { locale, t } = useI18n();
  const intervals = useInfraStore((state) => state.settings.telemetryIntervals);
  const prepared = series.map((item) => observedChartSeries(data, item.key, intervals, item.stream));
  const axis = resolvedTheme === "light" ? "#64748b" : "#93a4c3";
  const grid = resolvedTheme === "light" ? "#e2e8f0" : "#24344d";
  const timestamps = observedTime ? [...new Set(prepared.flatMap((item) => item.samples.map((point) => Number(point.ts))))].sort((a, b) => a - b) : [];
  const start = timestamps[0];
  const end = timestamps.at(-1);
  const spansDays = timestamps.length > 1 && end! - start! > 86400000;
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Tehran",
    numberingSystem: "latn",
    calendar: locale === "fa-IR" ? "persian" : "gregory",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(spansDays ? { day: "numeric", month: "short" } : {}),
  });
  const timeLabel = (value: number) => Number.isFinite(value) ? formatter.format(value) : "—";
  const tickStep = Math.max(1, Math.ceil(timestamps.length / 8));
  const ticks = observedTime ? timestamps.filter((_, index) => index % tickStep === 0 || index === timestamps.length - 1) : undefined;
  const chartData: object[] = observedTime ? timestamps.map((ts) => ({ ts })) : data;
  if (observedTime && !timestamps.length) return <p className="text-sm text-muted-foreground">{t("monitoring.noMetrics")}</p>;
  return (
    <div>
    {observedTime && end !== undefined && <p className="mb-2 text-xs text-muted-foreground">{t("monitoring.lastSample")}: {timeLabel(end)}</p>}
    <div dir="ltr" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" />
          <XAxis dataKey={observedTime ? "ts" : xKey} type={observedTime ? "number" : "category"}
            domain={observedTime && start !== undefined && end !== undefined ? [start, end] : undefined}
            ticks={ticks}
            tickFormatter={observedTime ? timeLabel : undefined} tick={{ fill: axis, fontSize: 11 }} />
          <YAxis tick={{ fill: axis, fontSize: 11 }} width={42} domain={yDomain} />
          <Tooltip content={observedTime ? ({ active, label }) => {
            if (!active) return null;
            const values = series.flatMap((item, index) => {
              const sample = prepared[index].samples.find((point) => point.ts === Number(label));
              return sample ? [{ ...item, value: Number(sample[item.key]) }] : [];
            });
            if (!values.length) return null;
            return <div className="rounded-xl border border-border bg-card p-3 text-sm text-card-foreground">
              <p>{timeLabel(Number(label))}</p>
              {values.map((item) => <p key={item.key} style={{ color: item.color }}>{item.name}: {new Intl.NumberFormat(locale).format(item.value)}</p>)}
            </div>;
          } : undefined}
            labelFormatter={observedTime ? (label) => timeLabel(Number(label)) : undefined}
            contentStyle={{ background: resolvedTheme === "light" ? "#fff" : "#10192b", borderColor: grid, borderRadius: 12 }} />
          {series.map((item, index) => (
            <Area key={item.key} data={observedTime ? prepared[index].points : undefined} type={observedTime ? "linear" : "monotone"} connectNulls={false} dataKey={item.key} name={item.name} stroke={item.color} fill={item.color} fillOpacity={0.16} strokeWidth={2} dot={showDots || (observedTime && prepared[index].samples.length <= 200) ? { r: 2 } : false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
    </div>
  );
}

export function BarTrend<T extends object>({ data, xKey = "label", yKey, color = "#2dd4bf", name }: { data: T[]; xKey?: string; yKey: string; color?: string; name: string }) {
  const { resolvedTheme } = useTheme();
  const axis = resolvedTheme === "light" ? "#64748b" : "#93a4c3";
  const grid = resolvedTheme === "light" ? "#e2e8f0" : "#24344d";
  return (
    <div dir="ltr" className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" />
          <XAxis dataKey={xKey} tick={{ fill: axis, fontSize: 11 }} />
          <YAxis tick={{ fill: axis, fontSize: 11 }} width={32} allowDecimals={false} />
          <Tooltip contentStyle={{ background: resolvedTheme === "light" ? "#fff" : "#10192b", borderColor: grid, borderRadius: 12 }} />
          <Bar dataKey={yKey} name={name} fill={color} radius={4} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
