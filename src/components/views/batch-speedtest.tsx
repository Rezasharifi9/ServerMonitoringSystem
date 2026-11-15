"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton, DemoNote } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { averageThroughput, previewPings, summarizePings } from "@/lib/speed-report";
import { can } from "@/lib/rbac";
import { readSpeedBatch, startSpeedBatch } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { SpeedBatch, SpeedBatchTarget } from "@/types";

const maxTargets = 8;

type Choice = { id: string; label: string; detail?: string; baseRtt: number; mbps: number };

function saltOf(value: string) {
  return [...value].reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
}

export function BatchSpeedtest({ live }: { live: boolean }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const client = useQueryClient();
  const allowed = can(user.role, "speedtest.run");
  const [mode, setMode] = useState<"gre" | "internet">("gre");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SpeedBatch | null>(null);
  const [previewRunning, setPreviewRunning] = useState(false);
  const runToken = useRef(0);
  const queryKey = ["speed-batch", user.id];
  const listing = useQuery({
    queryKey,
    queryFn: () => readSpeedBatch(),
    enabled: live,
    refetchInterval: (query) => pollingInterval(query, query.state.data?.status === "running" ? POLLING.job : false),
  });
  const choices = useMemo<Choice[]>(() => {
    if (mode === "gre") {
      return tunnels.filter((tunnel) =>
        (tunnel.technology === "GRE" || tunnel.technology === "GRE6") && tunnel.kind === "interface"
        && tunnel.iranEndpoint.interfaceName && tunnel.foreignEndpoint.tunnelIp,
      ).map((tunnel) => ({
        id: tunnel.id,
        label: tunnel.name,
        detail: tunnel.technology,
        baseRtt: tunnel.rttMs,
        mbps: averageThroughput(tunnel.rxMbps, tunnel.txMbps),
      }));
    }
    return servers.map((server) => ({
      id: server.id,
      label: server.name,
      detail: live && server.agent.status !== "online" ? t("speedtest.batch.agentOffline") : server.region,
      baseRtt: 20 + (saltOf(server.id) % 25),
      mbps: averageThroughput(server.rxMbps, server.txMbps),
    }));
  }, [live, mode, servers, t, tunnels]);
  const report = live ? listing.data ?? null : preview;
  const busy = (live && report?.status === "running") || previewRunning;
  const start = useMutation({
    mutationFn: (ids: string[]) => startSpeedBatch({ mode, ids }),
    onSuccess: (batch) => {
      client.setQueryData(queryKey, batch);
      toast.success(t("speedtest.batch.started"));
    },
    onError: (error) => toast.error(copy(error.message)),
  });

  function switchMode(next: "gre" | "internet") {
    runToken.current += 1;
    setMode(next);
    setSelected(new Set());
    setPreview(null);
    setPreviewRunning(false);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxTargets) next.add(id);
      else toast.error(t("speedtest.batch.limit", { max: maxTargets }));
      return next;
    });
  }

  function selectAll() {
    setSelected(selected.size ? new Set() : new Set(choices.slice(0, maxTargets).map((choice) => choice.id)));
  }

  async function runPreview(ids: string[]) {
    const token = ++runToken.current;
    const chosen = ids.flatMap((id) => {
      const choice = choices.find((item) => item.id === id);
      return choice ? [choice] : [];
    });
    const targets: SpeedBatchTarget[] = chosen.map((choice) => ({
      id: choice.id, targetId: choice.id, label: choice.label, status: "queued",
    }));
    setPreviewRunning(true);
    setPreview({ id: "preview", mode, status: "running", createdAt: new Date().toISOString(), targets });
    for (let index = 0; index < chosen.length; index += 1) {
      if (runToken.current !== token) return;
      targets[index] = { ...targets[index], status: "running" };
      setPreview({ id: "preview", mode, status: "running", createdAt: new Date().toISOString(), targets: [...targets] });
      await new Promise((resolve) => setTimeout(resolve, 280));
      if (runToken.current !== token) return;
      const samples = previewPings(chosen[index].baseRtt, saltOf(chosen[index].id));
      targets[index] = {
        ...targets[index], status: "completed", samples, ping: summarizePings(samples) ?? undefined, avgMbps: chosen[index].mbps,
      };
      const done = index === chosen.length - 1;
      setPreview({
        id: "preview", mode, status: done ? "completed" : "running", createdAt: new Date().toISOString(), targets: [...targets],
      });
    }
    if (runToken.current === token) setPreviewRunning(false);
  }

  function begin() {
    const ids = [...selected];
    if (live) start.mutate(ids);
    else void runPreview(ids);
  }

  const doneCount = report?.targets.filter((target) => target.status === "completed" || target.status === "failed").length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("speedtest.batch.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("speedtest.batch.description")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <DemoNote>{live ? t("speedtest.batch.liveNote") : t("speedtest.batch.previewNote")}</DemoNote>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={mode === "gre" ? "default" : "outline"} onClick={() => switchMode("gre")}>{t("speedtest.batch.gre")}</Button>
          <Button type="button" variant={mode === "internet" ? "default" : "outline"} onClick={() => switchMode("internet")}>{t("speedtest.batch.internet")}</Button>
        </div>
        {!choices.length && <p className="text-sm text-muted-foreground">{mode === "gre" ? t("speedtest.batch.emptyGre") : t("speedtest.batch.emptyServers")}</p>}
        {choices.length > 0 && (
          <div className="max-h-56 space-y-2 overflow-auto rounded-lg border border-border p-3">
            {choices.map((choice) => (
              <label key={choice.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.has(choice.id)} onChange={() => toggle(choice.id)} disabled={busy} />
                <span>{choice.label}</span>
                {choice.detail && <span className="text-xs text-muted-foreground">{choice.detail}</span>}
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={!choices.length || busy} onClick={selectAll}>
            {selected.size ? t("speedtest.batch.clear") : t("speedtest.batch.selectAll")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("speedtest.batch.selected", { count: selected.size, max: maxTargets })}</span>
          {live ? (
            <ConfirmButton label={start.isPending || busy ? t("speedtest.batch.running") : t("speedtest.batch.start")}
              title={t("speedtest.batch.confirmTitle")} description={t("speedtest.batch.confirmBody", { count: selected.size })}
              confirmLabel={t("speedtest.batch.start")} disabled={!allowed || !selected.size || busy || start.isPending} onConfirm={begin} />
          ) : (
            <Button type="button" disabled={!allowed || !selected.size || busy} onClick={begin}>
              {busy ? t("speedtest.batch.running") : t("speedtest.batch.start")}
            </Button>
          )}
        </div>
        {live && listing.isError && <p className="text-sm text-destructive">{t("speedtest.batch.readFailed")}</p>}
        {report && report.targets.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("speedtest.batch.progress", { done: doneCount, total: report.targets.length })}</p>
            {report.targets.map((target) => <ReportRow key={target.id} target={target} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReportRow({ target }: { target: SpeedBatchTarget }) {
  const { t } = useI18n();
  const format = useFormat();
  const status = target.status === "queued" ? t("speedtest.batch.queued")
    : target.status === "running" ? t("speedtest.batch.measuring")
    : target.status === "failed" ? t("speedtest.batch.failed")
    : t("speedtest.batch.done");
  const bandwidth = target.avgMbps === undefined ? t("speedtest.batch.noBandwidth") : format.formatMbps(target.avgMbps);
  const errorKey = target.error ? `speedtest.batch.error.${target.error}` : "";
  const errorText = errorKey && t(errorKey) !== errorKey ? t(errorKey) : "";
  return (
    <article className="rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium">{target.label}</h3>
        <span className="text-xs text-muted-foreground">{status}</span>
      </div>
      {target.ping && (
        <>
          <p className="mt-3 text-sm leading-7">
            {t("speedtest.batch.line", {
              name: target.label,
              max: format.formatMs(target.ping.maxMs),
              avg: format.formatMs(target.ping.avgMs),
              min: format.formatMs(target.ping.minMs),
              mbps: bandwidth,
            })}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label={t("speedtest.batch.max")} value={format.formatMs(target.ping.maxMs)} />
            <Metric label={t("speedtest.batch.avg")} value={format.formatMs(target.ping.avgMs)} />
            <Metric label={t("speedtest.batch.min")} value={format.formatMs(target.ping.minMs)} />
            <Metric label={t("speedtest.batch.bandwidth")} value={bandwidth} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("speedtest.batch.attempts", { replies: target.ping.replies, attempts: target.ping.attempts })}
          </p>
          {target.samples && target.samples.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
              {t("speedtest.batch.samples", { values: target.samples.map((sample) => format.formatMs(sample)).join(" · ") })}
            </p>
          )}
        </>
      )}
      {errorText && <p className="mt-2 text-sm text-destructive">{errorText}</p>}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tech mt-1 text-sm">{value}</div>
    </div>
  );
}
