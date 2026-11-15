"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { Button, Input, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { activityCategories, activityFromAudit, isActivityCategory } from "@/lib/activity";
import { toCsv } from "@/lib/csv";
import { downloadText } from "@/lib/utils";
import { getActivity, useBackend } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";
import type { ActivityCategory, ActivityEntry } from "@/types";

const pageSize = 50;
const presets = [1440, 10080, 43200, 129600, 5256000] as const;

function dayStart(value: string) {
  return new Date(`${value}T00:00:00`).getTime();
}

function dayEnd(value: string) {
  return new Date(`${value}T23:59:59.999`).getTime();
}

function inScope(entry: ActivityEntry, filters: { q: string; serverId: string; nodeId: string; start: number; end: number }) {
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at) || at < filters.start || at > filters.end) return false;
  if (filters.serverId !== "all" && entry.serverId !== filters.serverId && entry.target !== filters.serverId) return false;
  if (filters.nodeId !== "all" && entry.nodeId !== filters.nodeId && entry.target !== filters.nodeId) return false;
  const haystack = `${entry.action} ${entry.actor} ${entry.target} ${entry.detail}`.toLowerCase();
  return !filters.q || haystack.includes(filters.q.toLowerCase());
}

export function LogsView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const params = useSearchParams();
  const requested = params.get("category") ?? "";
  const audit = useInfraStore((state) => state.audit);
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const connected = useBackend((state) => state.status === "connected");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [category, setCategory] = useState<ActivityCategory | "all">(isActivityCategory(requested) ? requested : "all");
  const [minutes, setMinutes] = useState(10080);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [nodeId, setNodeId] = useState(params.get("node") ?? "all");
  const [serverId, setServerId] = useState(params.get("server") ?? "all");
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const custom = Boolean(from && to);
  const start = custom ? dayStart(from) : undefined;
  const end = custom ? dayEnd(to) : undefined;
  const rangeInvalid = custom && (!Number.isFinite(start) || !Number.isFinite(end) || end! < start!);
  const filters = {
    q: q.trim() || undefined,
    minutes: custom ? undefined : minutes,
    from: custom && !rangeInvalid ? start : undefined,
    to: custom && !rangeInvalid ? end : undefined,
    page,
    limit: pageSize,
    category: category === "all" ? undefined : category,
    nodeId: nodeId === "all" ? undefined : nodeId,
    serverId: serverId === "all" ? undefined : serverId,
  };
  const observed = useQuery({
    queryKey: ["activity", filters],
    queryFn: () => getActivity(filters),
    enabled: connected && !rangeInvalid,
    refetchInterval: (query) => pollingInterval(query, connected && !rangeInvalid && !custom && page === 1 ? POLLING.logs : false),
  });
  const local = useMemo(() => {
    if (connected) return [];
    const endAt = custom && !rangeInvalid && end !== undefined ? end : Date.now();
    const startAt = custom && !rangeInvalid && start !== undefined ? start : endAt - minutes * 60000;
    return audit.map(activityFromAudit).filter((entry) => inScope(entry, { q, serverId, nodeId, start: startAt, end: endAt }));
  }, [audit, connected, custom, end, minutes, nodeId, q, rangeInvalid, serverId, start]);
  const localSummary = useMemo(() => {
    const summary = Object.fromEntries(activityCategories.map((item) => [item, 0])) as Record<ActivityCategory, number>;
    for (const entry of local) summary[entry.category] += 1;
    return summary;
  }, [local]);
  const localFiltered = category === "all" ? local : local.filter((entry) => entry.category === category);
  const summary = connected ? observed.data?.summary ?? localSummary : localSummary;
  const total = connected ? observed.data?.total ?? 0 : localFiltered.length;
  const shown = connected ? observed.data?.data ?? [] : localFiltered.slice((page - 1) * pageSize, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rangeTotal = activityCategories.reduce((sum, item) => sum + summary[item], 0);
  const text = shown.map((entry) => `${entry.at} ${entry.category} ${entry.outcome} ${entry.actor} ${entry.action} ${entry.detail}`).join("\n");

  function presetLabel(value: number) {
    if (value === 1440) return t("logs.hours24");
    if (value === 10080) return t("logs.days7");
    if (value === 43200) return t("logs.days30");
    if (value === 129600) return t("logs.days90");
    return t("logs.allTime");
  }

  async function downloadReport() {
    const header = ["time", "category", "outcome", "actor", "action", "target", "detail"];
    try {
      setDownloading(true);
      const rows: ActivityEntry[] = [];
      if (!connected) rows.push(...localFiltered);
      else {
        const endAt = custom ? end! : Date.now();
        const startAt = custom ? start! : endAt - minutes * 60000;
        let next = 1;
        let count = 1;
        while ((next - 1) * 200 < count && next <= 25) {
          const result = await getActivity({
            ...filters, page: next, limit: 200, from: startAt, to: endAt, minutes: undefined,
          });
          rows.push(...result.data);
          count = result.total;
          next += 1;
        }
      }
      downloadText("nodeguard-activity.csv", toCsv([
        header,
        ...rows.map((entry) => [entry.at, entry.category, entry.outcome, entry.actor, entry.action, entry.target, entry.detail]),
      ]));
    } catch {
      toast.error(t("logs.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("logs.title")} description={t("logs.description")} />
      {!connected && <DemoNote>{t("logs.demoNote")}</DemoNote>}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{t("logs.reportTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("logs.reportCount", { total: rangeTotal })}</p>
        </div>
        <Button variant="outline" disabled={!total || downloading || rangeInvalid} onClick={() => void downloadReport()}>{t("logs.downloadReport")}</Button>
      </div>
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        {activityCategories.map((item) => (
          <button key={item} type="button" onClick={() => { setCategory((current) => current === item ? "all" : item); setPage(1); }}
            className={`rounded-xl border p-3 text-start ${category === item ? "border-primary bg-primary/5" : "border-border bg-card"}`}>
            <div className="text-xs text-muted-foreground">{t(`logs.categories.${item}`)}</div>
            <div className="mt-1 text-2xl font-semibold">{summary[item]}</div>
          </button>
        ))}
      </div>
      <div className="mb-4 grid gap-2 md:grid-cols-3 xl:grid-cols-4">
        <Input aria-label={t("logs.search")} value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder={t("logs.search")} />
        <Select aria-label={t("logs.category")} value={category} onChange={(event) => { setCategory(event.target.value as ActivityCategory | "all"); setPage(1); }}>
          <option value="all">{t("logs.allCategories")}</option>
          {activityCategories.map((item) => <option key={item} value={item}>{t(`logs.categories.${item}`)}</option>)}
        </Select>
        <Select aria-label={t("logs.range")} value={custom ? "custom" : String(minutes)} onChange={(event) => {
          if (event.target.value === "custom") return;
          setMinutes(Number(event.target.value));
          setFrom("");
          setTo("");
          setPage(1);
        }}>
          {presets.map((value) => <option key={value} value={value}>{presetLabel(value)}</option>)}
          {custom && <option value="custom">{t("logs.customRange")}</option>}
        </Select>
        <Input aria-label={t("logs.from")} type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} />
        <Input aria-label={t("logs.to")} type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} />
        <Select aria-label={t("logs.node")} value={nodeId} onChange={(event) => { setNodeId(event.target.value); setPage(1); }}>
          <option value="all">{t("logs.allNodes")}</option>
          {nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
        </Select>
        <Select aria-label={t("logs.server")} value={serverId} onChange={(event) => { setServerId(event.target.value); setPage(1); }}>
          <option value="all">{t("logs.allServers")}</option>
          {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
        </Select>
        <Button variant="outline" disabled={!text} onClick={async () => {
          try { await navigator.clipboard.writeText(text); toast.success(t("logs.copied")); }
          catch { toast.error(t("logs.copyFailed")); }
        }}>{t("logs.copyPage")}</Button>
      </div>
      {rangeInvalid && <p role="alert" className="mb-3 text-sm text-destructive">{t("logs.invalidRange")}</p>}
      <div className="overflow-auto rounded-xl border border-border bg-card">
        {connected && observed.isPending ? <p role="status" className="p-3 text-sm text-muted-foreground">{t("logs.loading")}</p>
          : connected && observed.isError ? <p role="alert" className="p-3 text-sm text-destructive">{t("logs.readFailed")} <Button variant="ghost" onClick={() => void observed.refetch()}>{t("common.retry")}</Button></p>
            : shown.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t("logs.empty")}</p> : shown.map((entry) => (
              <div key={entry.id} className="grid gap-2 border-b border-border/60 px-3 py-3 text-sm md:grid-cols-[170px_140px_140px_1fr]">
                <Tech>{format.formatDateTime(entry.at)}</Tech>
                <span>
                  <span className="block">{t(`logs.categories.${entry.category}`)}</span>
                  <span className={entry.outcome === "failed" ? "text-xs text-rose-500" : entry.outcome === "info" ? "text-xs text-amber-500" : "text-xs text-muted-foreground"}>{t(`logs.outcomes.${entry.outcome}`)}</span>
                </span>
                <span className="truncate" title={`${t("logs.actor")}: ${entry.actor}`}>{entry.actor}</span>
                <span>
                  <span className="block break-words">{copy(entry.detail)}</span>
                  <span className="mt-1 block text-xs text-muted-foreground"><Tech>{entry.action}</Tech>{entry.target ? ` · ${entry.target}` : ""}</span>
                </span>
              </div>
            ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{t("logs.pageStatus", { page, pages, total })}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t("logs.prevPage")}</Button>
          <Button size="sm" variant="outline" disabled={page * pageSize >= total} onClick={() => setPage((value) => value + 1)}>{t("logs.nextPage")}</Button>
        </div>
      </div>
    </div>
  );
}
