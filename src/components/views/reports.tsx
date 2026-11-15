"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui/kit";
import { toCsv } from "@/lib/csv";
import { addAvailability, availabilityCount, availabilityPct } from "@/lib/availability";
import { useFormat, useI18n } from "@/i18n/provider";
import { downloadText } from "@/lib/utils";
import { can } from "@/lib/rbac";
import { observedSamples, useBackend, useObservedAvailability } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { TunnelTech } from "@/types";

const SAMPLE_STREAMS = ["cpu", "ram", "disk", "traffic", "serverPing", "tunnelProbe", "tunnelTraffic", "forwarder"] as const;

export function ReportsView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const monitor = useBackend((state) => state.mode === "monitor");
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const incidents = useInfraStore((state) => state.incidents);
  const events = useInfraStore((state) => state.failoverEvents);
  const settings = useInfraStore((state) => state.settings);
  const [nodeId, setNodeId] = useState("all");
  const [serverId, setServerId] = useState("all");
  const [tech, setTech] = useState("all");
  const [days, setDays] = useState(settings.dataRetentionDays >= 30 ? 30 : settings.dataRetentionDays >= 7 ? 7 : 1);
  const [mountedAt] = useState(Date.now);
  const [sampleStream, setSampleStream] = useState("cpu");
  const [sampleTarget, setSampleTarget] = useState("");
  const [sampleBusy, setSampleBusy] = useState(false);
  const sampleTargets = ["tunnelProbe", "tunnelTraffic", "forwarder"].includes(sampleStream) ? tunnels : servers;
  const availability = useObservedAvailability(days === 1 ? "24h" : days === 7 ? "7d" : "30d", monitor);
  const anchor = monitor ? availability.data?.through ?? mountedAt : Math.max(
    0,
    ...incidents.map((incident) => Date.parse(incident.openedAt)),
    ...events.map((event) => Date.parse(event.at)),
  );
  const since = anchor - days * 86400000;
  const techTunnels = new Set(tunnels.filter((tunnel) => tech === "all" || tunnel.technology === tech).map((tunnel) => tunnel.id));
  const scopedNodes = nodes.filter((node) =>
    (nodeId === "all" || node.id === nodeId) &&
    (serverId === "all" || [node.primaryServerId, node.backupServerId, node.foreignServerId].includes(serverId)) &&
    (tech === "all" || [node.primaryTunnelId, node.backupTunnelId].some((id) => id !== undefined && techTunnels.has(id))),
  );
  const nodeIds = new Set(scopedNodes.map((node) => node.id));
  const nodeTunnels = new Set(scopedNodes.flatMap((node) => [node.primaryTunnelId, node.backupTunnelId]));
  const scopedTunnels = tunnels.filter((tunnel) => techTunnels.has(tunnel.id) &&
    (nodeId === "all" || nodeTunnels.has(tunnel.id)) &&
    (serverId === "all" || [tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId].includes(serverId)));
  const tunnelIds = new Set(scopedTunnels.map((tunnel) => tunnel.id));
  const unfiltered = nodeId === "all" && serverId === "all" && tech === "all";
  const recentIncidents = incidents.filter((incident) => Date.parse(incident.openedAt) >= since &&
    (unfiltered || (incident.nodeId ? nodeIds.has(incident.nodeId) : incident.tunnelId ? tunnelIds.has(incident.tunnelId) : serverId === incident.serverId)));
  const recentEvents = events.filter((event) => Date.parse(event.at) >= since && (unfiltered || nodeIds.has(event.nodeId)));
  const success = recentEvents.filter((event) => event.result === "success" || (!monitor && event.result === "rolled-back")).length;
  const resolved = recentIncidents.filter((incident) => incident.resolvedAt);
  const mttr = resolved.length ? resolved.reduce((sum, incident) => sum + (new Date(incident.resolvedAt!).getTime() - new Date(incident.openedAt).getTime()), 0) / resolved.length / 60000 : 0;
  const none = { samples: 0, successful: 0 };
  const nodeCount = (id: string) => availabilityCount(availability.data?.nodes, id) ?? none;
  const proxyTotal = scopedNodes.reduce((total, node) => addAvailability(total, nodeCount(node.id)), none);
  const tunnelTotal = scopedTunnels.reduce((total, tunnel) => addAvailability(total, availabilityCount(availability.data?.tunnels, tunnel.id) ?? none), none);
  const ranked = scopedNodes.flatMap((node) => {
    const pct = monitor ? availabilityPct(nodeCount(node.id)) : node.uptimePct;
    return pct === null ? [] : [{ node, pct }];
  }).sort((a, b) => a.pct - b.pct);
  const rows = scopedNodes.map((node) => {
    const count = nodeCount(node.id);
    const pct = monitor ? availabilityPct(count) : node.uptimePct;
    return [node.id, node.name, pct?.toFixed(2) ?? "",
      ...(monitor ? [count.successful, count.samples] : []),
      node.rttMs.toFixed(0), node.packetLoss.toFixed(2), node.health];
  });
  const columns = monitor
    ? ["id", "name", "proxy_success_pct", "successful_probes", "probe_samples", "latest_rtt_ms", "latest_loss_pct", "health"]
    : ["id", "name", "uptime", "rtt", "loss", "health"];
  const rate = (value: number | null) => value === null ? "—" : format.formatPercent(value, 2);
  const ready = scopedNodes.filter((node) => servers.find((server) => server.id === node.backupServerId)?.status === "healthy").length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("reports.title")}
        description={monitor ? t("reports.descriptionMonitor") : t("reports.descriptionDemo")}
        actions={<Button disabled={!can(user.role, "report.export") || (monitor && !availability.data)} onClick={() => {
          downloadText("nodeguard-report.csv", toCsv([columns, ...rows]), "text/csv");
          toast.success(t("reports.exported"));
        }}>{t("reports.exportCsv")}</Button>}
      />
      <div className="grid gap-2 md:grid-cols-4">
        <Select value={String(days)} onChange={(event) => setDays(Number(event.target.value))}><option value="1">{t("reports.day1")}</option><option value="7">{t("reports.day7")}</option><option value="30">{t("reports.day30")}</option></Select>
        <Select value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="all">{t("reports.allNodes")}</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</Select>
        <Select value={serverId} onChange={(event) => setServerId(event.target.value)}><option value="all">{t("reports.allServers")}</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select>
        <Select value={tech} onChange={(event) => setTech(event.target.value)}><option value="all">{t("reports.allTunnels")}</option>{Array.from(new Set(tunnels.map((tunnel) => tunnel.technology))).map((item) => <option key={item}>{item as TunnelTech}</option>)}</Select>
      </div>
      {monitor && availability.isLoading && <p role="status" className="text-sm text-muted-foreground">{t("reports.loading")}</p>}
      {monitor && availability.isError && <p role="alert" className="text-sm text-muted-foreground">{t("reports.readFailed")}</p>}
      {monitor && <Card>
        <CardHeader><CardTitle>{t("reports.samplesTitle")}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-3">
          <p className="text-sm text-muted-foreground md:col-span-3">{t("reports.historyPolicy")}</p>
          <Select aria-label={t("reports.metric")} value={sampleStream} onChange={(event) => { setSampleStream(event.target.value); setSampleTarget(""); }}>
            {SAMPLE_STREAMS.map((stream) => <option key={stream} value={stream}>{t(`reports.streams.${stream}`)}</option>)}
          </Select>
          <Select aria-label={t("reports.target")} value={sampleTarget} onChange={(event) => setSampleTarget(event.target.value)}>
            <option value="">{t("reports.chooseTarget")}</option>{sampleTargets.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </Select>
          <Button disabled={!sampleTarget || sampleBusy || !can(user.role, "report.export")} onClick={async () => {
            setSampleBusy(true);
            try {
              const report = await observedSamples(sampleStream, sampleTarget, days);
              const fields = ["sampledAt", ...report.fields];
              downloadText(`nodeguard-${sampleStream}.csv`, toCsv([fields, ...report.samples.map((row) => fields.map((field) => row[field] ?? ""))]), "text/csv");
              toast.success(report.limited ? t("reports.samplesLimited", { count: format.formatNumber(10000) }) : t("reports.samplesDownloaded", { count: format.formatNumber(report.samples.length) }));
            } catch (error) { toast.error(error instanceof Error ? copy(error.message) : t("reports.samplesFailed")); }
            finally { setSampleBusy(false); }
          }}>{t("reports.downloadRange")}</Button>
        </CardContent>
      </Card>}
      <div className="grid gap-3 md:grid-cols-3">
        <Stat title={monitor ? t("reports.proxySuccess") : t("reports.avgUptime")}
          value={monitor ? rate(availabilityPct(proxyTotal)) : format.formatPercent(avg(scopedNodes.map((node) => node.uptimePct)), 2)}
          hint={monitor ? t("reports.probeHint", { successful: proxyTotal.successful, samples: proxyTotal.samples }) : undefined} />
        <Stat title={monitor ? t("reports.currentRtt") : t("reports.avgRtt")} value={t("reports.milliseconds", { value: format.formatNumber(avg(scopedNodes.map((node) => node.rttMs)), 0) })} />
        <Stat title={monitor ? t("reports.currentLoss") : t("reports.avgLoss")} value={format.formatPercent(avg(scopedNodes.map((node) => node.packetLoss)), 2)} />
        <Stat title={monitor ? t("reports.tunnelSuccess") : t("reports.tunnelReliability")}
          value={monitor ? rate(availabilityPct(tunnelTotal)) : format.formatPercent(avg(scopedTunnels.map((tunnel) => tunnel.uptimePct)), 2)}
          hint={monitor ? t("reports.probeHint", { successful: tunnelTotal.successful, samples: tunnelTotal.samples }) : undefined} />
        <Stat title={t("reports.incidents")} value={String(recentIncidents.length)} />
        <Stat title={t("reports.mttr")} value={t("reports.minutes", { count: format.formatNumber(mttr, 0) })} />
        <Stat title={t("reports.failoverSuccess")} value={recentEvents.length ? format.formatPercent((success / recentEvents.length) * 100, 0) : "—"} />
        <Stat title={monitor ? t("reports.lowestSuccess") : t("reports.unstableNode")} value={ranked[0]?.node.name ?? "—"} technical={false} />
        <Stat title={t("reports.standbyReady")} value={t("reports.standbyValue", { ready, total: scopedNodes.length })} />
      </div>
      <Card>
        <CardHeader><CardTitle>{t("reports.ranking")}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {ranked.slice(0, 8).map(({ node, pct }) => (
            <div key={node.id} className="flex justify-between"><span>{node.name}</span><span dir="ltr">{format.formatPercent(pct, 2)}</span></div>
          ))}
          {!ranked.length && <p className="text-muted-foreground">{monitor ? t("reports.noProbes") : t("reports.noNodes")}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function Stat({ title, value, hint, technical = true }: { title: string; value: string; hint?: string; technical?: boolean }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>
    <div className="text-2xl font-semibold" dir={technical ? "ltr" : undefined}>{value}</div>
    {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
  </CardContent></Card>;
}
