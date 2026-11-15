"use client";

import { POLLING, pollingInterval, jobActive } from "@/lib/polling";

import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { TrendChart } from "@/components/charts/trend-chart";
import { BatchSpeedtest } from "@/components/views/batch-speedtest";
import { ConfirmButton, DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@/components/ui/kit";
import { Switch } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { runSpeedtest } from "@/services/api";
import { cancelOperationalSpeedtest, enqueueOperationalSpeedtest, listOperationalSpeedtests, useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { IperfConfig, IperfJob, SpeedtestConfig } from "@/types";

export function SpeedtestView() {
  const monitor = useBackend((state) => state.mode === "monitor");
  return monitor ? <IperfLiveView /> : <DemoSpeedtestView />;
}

function DemoSpeedtestView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const params = useSearchParams();
  const user = useCurrentUser();
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const run = useInfraStore((state) => state.speedtestRun);
  const history = useInfraStore((state) => state.speedtests);
  const stop = useInfraAction("stopSpeedtest");
  const [form, setForm] = useState<SpeedtestConfig>({
    mode: "tunnel",
    sourceServerId: params.get("source") || servers[0]?.id || "",
    destServerId: params.get("dest") || servers.find((server) => server.roles.includes("foreign"))?.id,
    tunnelId: params.get("tunnel") || tunnels[0]?.id,
    nodeId: params.get("node") || undefined,
    protocol: "tcp",
    direction: "download",
    reverse: false,
    durationSec: 12,
    streams: 4,
    bandwidthLimitMbps: 0,
  });
  const allowed = can(user.role, "speedtest.run");
  const chart = useMemo(() => (run?.samples ?? []).map((sample) => ({ label: String(sample.t), mbps: sample.mbps })), [run?.samples]);
  const progress = run ? Math.min(100, (run.elapsedSec / run.config.durationSec) * 100) : 0;

  return (
    <div className="space-y-4">
      <PageHeader title={t("speedtest.title")} description={t("speedtest.description")} />
      <BatchSpeedtest live={false} />
      <DemoNote>{t("speedtest.demoNote")}</DemoNote>
      <Card>
        <CardHeader><CardTitle>{t("speedtest.config")}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Field label={t("speedtest.mode")}>
            <Select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value as SpeedtestConfig["mode"] })}>
              <option value="tunnel">{t("speedtest.tunnelTest")}</option>
              <option value="internet">{t("speedtest.internetTest")}</option>
            </Select>
          </Field>
          <Field label={t("speedtest.source")}><Select value={form.sourceServerId} onChange={(event) => setForm({ ...form, sourceServerId: event.target.value })}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select></Field>
          <Field label={t("speedtest.destination")}><Select value={form.destServerId} onChange={(event) => setForm({ ...form, destServerId: event.target.value })}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select></Field>
          <Field label={t("speedtest.tunnel")}><Select value={form.tunnelId} onChange={(event) => setForm({ ...form, tunnelId: event.target.value })}>{tunnels.map((tunnel) => <option key={tunnel.id} value={tunnel.id}>{tunnel.technology} · {tunnel.name}</option>)}</Select></Field>
          <Field label={t("speedtest.protocol")}><Select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as SpeedtestConfig["protocol"] })}><option value="tcp">TCP</option><option value="udp">UDP</option></Select></Field>
          <Field label={t("speedtest.direction")}><Select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as SpeedtestConfig["direction"] })}><option value="download">{t("speedtest.download")}</option><option value="upload">{t("speedtest.upload")}</option><option value="bidirectional">{t("speedtest.bidirectional")}</option></Select></Field>
          <Field label={t("speedtest.duration")}><Input className="tech" value={form.durationSec} onChange={(event) => setForm({ ...form, durationSec: Number(event.target.value) })} /></Field>
          <Field label={t("speedtest.streams")}><Input className="tech" value={form.streams} onChange={(event) => setForm({ ...form, streams: Number(event.target.value) })} /></Field>
          <Field label={t("speedtest.bandwidthCap")}><Input className="tech" value={form.bandwidthLimitMbps ?? 0} onChange={(event) => setForm({ ...form, bandwidthLimitMbps: Number(event.target.value) })} /></Field>
          <label className="flex items-center justify-between text-sm md:col-span-3">{t("speedtest.reverse")} <Switch checked={form.reverse} onCheckedChange={(value) => setForm({ ...form, reverse: value })} /></label>
          <div className="flex gap-2 md:col-span-3">
            <Button disabled={!allowed || run?.running} onClick={() => { const error = runSpeedtest(form); void error.then((message) => message ? toast.error(copy(message)) : toast.success(t("speedtest.started"))); }}>{t("speedtest.start")}</Button>
            <Button variant="outline" disabled={!run?.running} onClick={() => void stop().then((error) => { if (error) toast.error(copy(error)); })}>{t("speedtest.stop")}</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("speedtest.liveTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${progress}%` }} /></div>
          <div className="grid gap-3 md:grid-cols-4 text-sm">
            <Stat label={t("speedtest.current")} value={format.formatMbps(run?.currentMbps ?? 0)} />
            <Stat label={t("speedtest.average")} value={format.formatMbps(average(run?.samples.map((sample) => sample.mbps) ?? []))} />
            <Stat label={t("speedtest.peak")} value={format.formatMbps(Math.max(0, ...(run?.samples.map((sample) => sample.mbps) ?? [0])))} />
            <Stat label={t("speedtest.quality")} value={t("speedtest.qualityValue", {
              rtt: format.formatNumber(run?.rttMs ?? 0, 1),
              loss: format.formatPercent(run?.lossPct ?? 0, 2),
              jitter: format.formatNumber(run?.jitterMs ?? 0, 1),
            })} />
          </div>
          <TrendChart data={chart.length ? chart : [{ label: "0", mbps: 0 }]} series={[{ key: "mbps", name: t("speedtest.series"), color: "#2dd4bf" }]} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("speedtest.history")}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {history.map((item) => (
            <div key={item.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap justify-between gap-2"><span><span className="tech">{format.formatDateTime(item.createdAt)}</span> · {item.mode === "tunnel" ? t("speedtest.tunnelTest") : t("speedtest.internetTest")} · <Tech>{item.protocol}</Tech></span><span>{item.status === "completed" ? t("speedtest.completed") : t("speedtest.stopped")}</span></div>
              <p className="mt-1 text-muted-foreground">{t("speedtest.stats", { avg: format.formatMbps(item.avgMbps), max: format.formatMbps(item.maxMbps), duration: item.durationSec, streams: item.streams })}{item.reverse ? t("speedtest.reverseSuffix") : ""}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><Label>{label}</Label>{children}</label>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-muted p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="tech mt-1">{value}</div></div>;
}

function IperfLiveView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const params = useSearchParams();
  const user = useCurrentUser();
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const client = useQueryClient();
  const [selectedTunnel, setSelectedTunnel] = useState(params.get("tunnel") ?? "");
  const [selectedDestination, setSelectedDestination] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [form, setForm] = useState<Pick<IperfConfig, "protocol" | "direction" | "durationSec" | "streams" | "bandwidthLimitMbps">>({
    protocol: "tcp", direction: "download", durationSec: 10, streams: 1, bandwidthLimitMbps: 10,
  });
  const queryKey = ["iperf-jobs", user.id];
  const listing = useQuery({ queryKey, queryFn: listOperationalSpeedtests, refetchInterval: (query) => pollingInterval(query, query.state.data?.jobs.some(jobActive) ? POLLING.job : POLLING.idle) });
  const jobs = listing.data?.jobs ?? [];
  const targets = (listing.data?.targets ?? []).filter((target) => tunnels.some((tunnel) => tunnel.id === target.tunnelId));
  const tunnelIds = [...new Set(targets.map((item) => item.tunnelId))];
  const available = targets.filter((item) => item.tunnelId === (tunnelIds.includes(selectedTunnel) ? selectedTunnel : tunnelIds[0]));
  const target = available.find((item) => item.receiverServerId === selectedDestination) ?? available[0];
  const tunnel = tunnels.find((item) => item.id === target?.tunnelId);
  const destination = target?.receiverServerId;
  const source = [tunnel?.iranEndpoint.serverId, tunnel?.foreignEndpoint.serverId].find((item) => item && item !== destination);
  const serverName = (id?: string) => servers.find((server) => server.id === id)?.name ?? id ?? "—";
  const picked = jobs.find((job) => job.id === selectedJob) ?? jobs[0];
  const allowed = can(user.role, "speedtest.run");
  const active = picked?.status === "queued" || picked?.status === "running";
  const refresh = () => void client.invalidateQueries({ queryKey });
  const submit = useMutation({
    mutationFn: ({ spec, key }: { spec: IperfConfig; key: string }) => enqueueOperationalSpeedtest(spec, key),
    onSuccess: (job) => { setSelectedJob(job.id); refresh(); toast.success(t("speedtest.live.queued")); },
    onError: (error) => toast.error(copy(error.message)),
  });
  const cancel = useMutation({
    mutationFn: cancelOperationalSpeedtest,
    onSuccess: () => { refresh(); toast.success(t("speedtest.live.cancelQueued")); },
    onError: (error) => toast.error(copy(error.message)),
  });
  const valid = Number.isInteger(form.durationSec) && form.durationSec >= 1 && form.durationSec <= 30 &&
    Number.isInteger(form.streams) && form.streams >= 1 && form.streams <= 4 &&
    Number.isInteger(form.bandwidthLimitMbps) && form.bandwidthLimitMbps >= 1 && form.bandwidthLimitMbps <= 100;
  const result = picked?.result;
  const series = [
    ...(result?.uploadMbps !== undefined ? [{ key: "uploadMbps", name: t("speedtest.live.upload"), color: "#2dd4bf" }] : []),
    ...(result?.downloadMbps !== undefined ? [{ key: "downloadMbps", name: t("speedtest.live.download"), color: "#818cf8" }] : []),
  ];
  const jobStatus = (status: IperfJob["status"]) => t(`speedtest.live.status.${status}`);
  const jobError = (code: string) => {
    const key = `speedtest.live.error.${code}`;
    const label = t(key);
    return label === key ? t("speedtest.live.failed") : label;
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("speedtest.live.title")} description={t("speedtest.live.description")} />
      <BatchSpeedtest live />
      {listing.isPending && <p>{t("speedtest.live.loading")}</p>}
      {listing.isError && <p className="text-destructive">{t("speedtest.live.readFailed")} <Button variant="outline" onClick={() => void listing.refetch()}>{t("common.retry")}</Button></p>}
      {listing.data && !listing.data.enabled && <DemoNote>{t("speedtest.live.disabled")}</DemoNote>}
      {listing.data?.enabled && !targets.length && <DemoNote>{t("speedtest.live.noTargets")}</DemoNote>}
      {listing.data?.enabled && targets.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t("speedtest.live.config")}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <Field label={t("speedtest.tunnel")}><Select value={target?.tunnelId} onChange={(event) => setSelectedTunnel(event.target.value)}>
              {tunnelIds.map((id) => <option key={id} value={id}>{tunnels.find((item) => item.id === id)?.name ?? id}</option>)}
            </Select></Field>
            <Stat label={t("speedtest.source")} value={serverName(source)} />
            <Field label={t("speedtest.destination")}><Select value={destination} onChange={(event) => setSelectedDestination(event.target.value)}>
              {available.map((item) => <option key={item.receiverServerId} value={item.receiverServerId}>{serverName(item.receiverServerId)}</option>)}
            </Select></Field>
            <Field label={t("speedtest.protocol")}><Select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as IperfConfig["protocol"] })}>
              <option value="tcp">TCP</option><option value="udp">UDP</option>
            </Select></Field>
            <Field label={t("speedtest.direction")}><Select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as IperfConfig["direction"] })}>
              <option value="upload">{t("speedtest.live.uploadFromSource")}</option><option value="download">{t("speedtest.live.downloadReverse")}</option><option value="bidirectional">{t("speedtest.bidirectional")}</option>
            </Select></Field>
            <Field label={t("speedtest.live.durationRange")}><Input dir="ltr" type="number" min={1} max={30} value={form.durationSec} onChange={(event) => setForm({ ...form, durationSec: Number(event.target.value) })} /></Field>
            <Field label={t("speedtest.live.streamsRange")}><Input dir="ltr" type="number" min={1} max={4} value={form.streams} onChange={(event) => setForm({ ...form, streams: Number(event.target.value) })} /></Field>
            <Field label={t("speedtest.live.capRange")}><Input dir="ltr" type="number" min={1} max={100} value={form.bandwidthLimitMbps} onChange={(event) => setForm({ ...form, bandwidthLimitMbps: Number(event.target.value) })} /></Field>
            <div className="md:col-span-3">
              <ConfirmButton confirmLabel={t("settings.confirmAction")} label={submit.isPending ? t("speedtest.live.submitting") : t("speedtest.live.run")} title={t("speedtest.live.confirmTitle")}
                description={t("speedtest.live.confirmBody", { seconds: form.durationSec, mbps: form.bandwidthLimitMbps })}
                disabled={!allowed || !valid || submit.isPending || !tunnel || !source || !destination}
                onConfirm={() => {
                  if (tunnel && source && destination) submit.mutate({
                    spec: { ...form, tunnelId: tunnel.id, sourceServerId: source, destServerId: destination }, key: crypto.randomUUID(),
                  });
                }} />
            </div>
          </CardContent>
        </Card>
      )}
      {picked && (
        <Card>
          <CardHeader><CardTitle>{t("speedtest.live.result", { status: jobStatus(picked.status) })}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">{serverName(picked.config.sourceServerId)} / {serverName(picked.config.destServerId)}</p>
            {picked.error && <p className="text-sm text-destructive">{jobError(picked.error)}</p>}
            {active && <Button variant="outline" disabled={!allowed || cancel.isPending} onClick={() => cancel.mutate(picked.id)}>{t("speedtest.live.requestStop")}</Button>}
            {result && (
              <div className="grid gap-3 md:grid-cols-4">
                {result.uploadMbps !== undefined && <Stat label={t("speedtest.live.upload")} value={format.formatMbps(result.uploadMbps)} />}
                {result.downloadMbps !== undefined && <Stat label={t("speedtest.live.download")} value={format.formatMbps(result.downloadMbps)} />}
                {result.lossPct !== undefined && <Stat label={t("speedtest.live.maxLoss")} value={format.formatPercent(result.lossPct, 2)} />}
                {result.jitterMs !== undefined && <Stat label={t("speedtest.live.maxJitter")} value={t("speedtest.live.jitterValue", { value: format.formatNumber(result.jitterMs, 2) })} />}
              </div>
            )}
            {result && result.samples.length > 0 && <TrendChart data={result.samples.map((item) => ({ ...item, label: String(item.t) }))} series={series} />}
          </CardContent>
        </Card>
      )}
      {listing.data && (
        <Card>
          <CardHeader><CardTitle>{t("speedtest.live.history")}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!jobs.length && <p>{t("speedtest.live.empty")}</p>}
            {jobs.map((job) => (
              <Button key={job.id} variant={job.id === picked?.id ? "secondary" : "ghost"} className="flex w-full justify-between"
                onClick={() => setSelectedJob(job.id)}>
                <span><span className="tech">{format.formatDateTime(job.createdAt)}</span> · <Tech>{job.config.protocol}</Tech></span><span>{jobStatus(job.status)}</span>
              </Button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
