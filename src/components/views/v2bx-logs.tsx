"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Tech } from "@/components/shared/chrome";
import { Button, Input, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { downloadText } from "@/lib/utils";
import { getObservedLogs } from "@/services/backend";
import type { LogSeverity, LogSnapshot } from "@/types";

const levels: Array<LogSeverity | "all"> = ["all", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
const ranges = [10, 30, 60, 180, 1440, 10080] as const;
const pageSize = 80;

export function ServerV2bxLogs({ serverId }: { serverId: string }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const [q, setQ] = useState("");
  const [severity, setSeverity] = useState<LogSeverity | "all">("all");
  const [minutes, setMinutes] = useState(10);
  const [page, setPage] = useState(1);
  const [snapshot, setSnapshot] = useState<LogSnapshot>();
  const [stick, setStick] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const filters = {
    serverId, source: "v2bx", minutes, page, limit: pageSize, snapshot,
    q: q.trim() || undefined,
    severity: severity === "all" ? undefined : severity,
  };
  const observed = useQuery({
    queryKey: ["server-v2bx-logs", filters],
    queryFn: () => getObservedLogs(filters),
    refetchInterval: (query) => pollingInterval(query, snapshot || page !== 1 ? false : POLLING.logs),
  });
  const shown = useMemo(() => observed.data?.data.slice().reverse() ?? [], [observed.data]);
  const text = shown.map((entry) => `${entry.ts} ${entry.severity} ${entry.source} ${entry.nodeId ?? "-"} ${entry.message}${entry.repeatCount ? ` [×${entry.repeatCount}; ${entry.lastTs}]` : ""}`).join("\n");
  const pages = Math.max(1, Math.ceil((observed.data?.total ?? 0) / pageSize));
  useEffect(() => {
    if (stick && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, stick]);

  function rangeLabel(value: number) {
    if (value === 10) return t("logs.v2bx.minutes10");
    if (value === 30) return t("logs.v2bx.minutes30");
    if (value === 60) return t("logs.v2bx.hour1");
    if (value === 180) return t("logs.v2bx.hours3");
    if (value === 1440) return t("logs.v2bx.hours24");
    return t("logs.v2bx.days7");
  }

  function move(to: number) {
    if (!snapshot) setSnapshot(observed.data?.snapshot);
    setPage(to);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground" role="status">{snapshot ? t("logs.v2bx.paused") : t("logs.v2bx.live")}</p>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Input aria-label={t("logs.v2bx.search")} value={q} onChange={(event) => { setQ(event.target.value); setPage(1); setSnapshot(undefined); }} placeholder={t("logs.v2bx.search")} />
        <Select aria-label={t("logs.v2bx.level")} value={severity} onChange={(event) => { setSeverity(event.target.value as LogSeverity | "all"); setPage(1); setSnapshot(undefined); }}>
          {levels.map((level) => <option key={level} value={level}>{level === "all" ? t("logs.v2bx.allLevels") : t("logs.v2bx.levelOption", { level, label: t(`common.status.${level}`) })}</option>)}
        </Select>
        <Select aria-label={t("logs.v2bx.range")} value={String(minutes)} onChange={(event) => { setMinutes(Number(event.target.value)); setPage(1); setSnapshot(undefined); }}>
          {ranges.map((value) => <option key={value} value={value}>{rangeLabel(value)}</option>)}
        </Select>
        <Button variant="outline" disabled={!observed.data} onClick={() => {
          if (snapshot) { setSnapshot(undefined); setPage(1); }
          else setSnapshot(observed.data?.snapshot);
        }}>{snapshot ? t("logs.v2bx.resume") : t("logs.v2bx.pause")}</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!text} onClick={async () => {
          try { await navigator.clipboard.writeText(text); toast.success(t("logs.v2bx.copied")); }
          catch { toast.error(t("logs.v2bx.copyFailed")); }
        }}>{t("logs.v2bx.copy")}</Button>
        <Button variant="outline" disabled={!text} onClick={() => downloadText(`v2bx-${serverId}.log`, text)}>{t("logs.v2bx.download")}</Button>
        <Button variant="ghost" onClick={() => setStick((value) => !value)}>{stick ? t("logs.v2bx.stickOn") : t("logs.v2bx.stickOff")}</Button>
      </div>
      <div className="max-h-[520px] space-y-1 overflow-auto rounded-lg border border-border p-3" ref={scroller}>
        {observed.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("logs.v2bx.loading")}</p>
          : observed.isError ? <p role="alert" className="text-sm text-destructive">{t("logs.v2bx.readFailed")} <Button variant="ghost" onClick={() => void observed.refetch()}>{t("common.retry")}</Button></p>
            : shown.length === 0 ? <p className="text-sm text-muted-foreground">{t("logs.v2bx.empty")}</p> : shown.map((entry) => (
              <p key={entry.id} className="break-all text-xs">
                <Tech>{format.formatDateTime(entry.ts)} [{entry.severity}]</Tech>
                {entry.nodeId ? <Tech> {entry.nodeId}</Tech> : null} {copy(entry.message)}
                {entry.repeatCount ? <Tech> ×{format.formatNumber(entry.repeatCount)} · {format.formatDateTime(entry.lastTs ?? entry.ts)}</Tech> : null}
              </p>
            ))}
      </div>
      {observed.data && <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{t("logs.v2bx.pageStatus", { page, pages, total: observed.data.total })}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page === 1} onClick={() => move(page - 1)}>{t("logs.v2bx.prevPage")}</Button>
          <Button size="sm" variant="outline" disabled={page * pageSize >= observed.data.total} onClick={() => move(page + 1)}>{t("logs.v2bx.nextPage")}</Button>
        </div>
      </div>}
    </div>
  );
}
