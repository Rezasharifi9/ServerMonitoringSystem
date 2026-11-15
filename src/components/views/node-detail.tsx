"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ObservedTrend } from "@/components/charts/observed-trend";
import { TrendChart } from "@/components/charts/trend-chart";
import { DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Textarea } from "@/components/ui/kit";
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { activeServerId, activeTunnelId, assessNode } from "@/lib/health";
import { buildEntitySeries } from "@/lib/metrics";
import { can } from "@/lib/rbac";
import { useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import { NodeLogPreview } from "./node-log-preview";
import { NodeConnectionFacts } from "./node-connection-facts";
import { useV2BoardCatalog } from "./v2board-inventory";
import { NodeRouteSelection } from "./node-route-selection";

const schema = z.object({
  name: z.string().min(3, "nodes.detail.nameMin"),
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "nodes.detail.domainInvalid"),
  port: z.coerce.number().int().min(1, "nodes.detail.portInvalid").max(65535, "nodes.detail.portInvalid"),
  rateLimitMbps: z.coerce.number().min(0, "nodes.detail.rateInvalid").max(10000, "nodes.detail.rateInvalid"),
  remark: z.string().max(240, "nodes.detail.remarkLong"),
  probeEnabled: z.boolean(),
  alertOnLoss: z.boolean(),
});

function isolate(value: string) {
  return `\u2066${value}\u2069`;
}

export function NodeDetailView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const catalog = useV2BoardCatalog(monitor);
  const params = useParams<{ id: string }>();
  const user = useCurrentUser();
  const node = useInfraStore((state) => state.nodes.find((item) => item.id === params.id));
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const dns = useInfraStore((state) => state.dns.find((item) => item.nodeId === params.id));
  const settings = useInfraStore((state) => state.settings);
  const allEvents = useInfraStore((state) => state.failoverEvents);
  const allLogs = useInfraStore((state) => state.logs);
  const events = allEvents.filter((item) => item.nodeId === params.id);
  const logs = allLogs.filter((item) => item.nodeId === params.id).slice(-12);
  const shared = allLogs.filter((item) => !item.nodeId && item.serverId === node?.foreignServerId).slice(-6);
  const policy = useInfraStore((state) => state.settings.failover.trigger === "tunnel-loss" ? state.settings.failover : state.policies.find((item) => item.nodeId === params.id));
  const updateNodeSettings = useInfraAction("updateNodeSettings");
  const allowed = can(user.role, "node.edit");
  const panel = monitor ? catalog.data?.nodes.find((item) => item.nodeId === params.id) : undefined;

  if (!node) return <PageHeader title={t("nodes.detail.notFound")} description={t("nodes.detail.notFoundBody")} />;
  const report = assessNode(node, servers, tunnels, dns ? [dns] : [], settings, monitor);
  const tunnel = tunnels.find((item) => item.id === activeTunnelId(node));
  const series = buildEntitySeries("24h", node.id, { rtt: node.rttMs || 40, loss: node.packetLoss, rx: tunnel?.rxMbps ?? 10, tx: tunnel?.txMbps ?? 10, offline: node.health === "offline" });
  const server = (id: string) => servers.find((item) => item.id === id);

  return (
    <div>
      <PageHeader title={panel?.name || node.name} description={t("nodes.detail.subtitle", { id: isolate(node.id), domain: isolate(node.domain) })} actions={<StatusBadge value={node.health} />} />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t("nodes.detail.overview")}</TabsTrigger>
          <TabsTrigger value="tunnel">{t("nodes.detail.tunnel")}</TabsTrigger>
          <TabsTrigger value="speed">{t("nodes.detail.speed")}</TabsTrigger>
          <TabsTrigger value="logs">{t("nodes.detail.logs")}</TabsTrigger>
          <TabsTrigger value="dns">{t("nodes.detail.dns")}</TabsTrigger>
          <TabsTrigger value="failover">{t("nodes.detail.failover")}</TabsTrigger>
          <TabsTrigger value="settings">{t("nodes.detail.settings")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4 space-y-4">
          {monitor && <NodeConnectionFacts name={panel?.name || node.name} domain={panel?.host || node.domain}
            port={panel?.port ?? node.port} protocol={panel?.protocol ?? node.protocol} tls={panel?.tls} transport={panel?.transport} />}
          <div className="grid gap-3 md:grid-cols-3">
            <Info label={t("nodes.detail.protocol")} value={<Tech>{node.protocol}:{node.port}</Tech>} />
            <Info label={t("nodes.detail.country")} value={`${node.country} · ${node.city}`} />
            <Info label={t("nodes.detail.score")} value={report.score} />
            {monitor && <Info label={t("nodes.detail.online")} value={<Tech>{panel?.online == null ? "—" : format.formatNumber(panel.online)}</Tech>} />}
          </div>
          <Card>
            <CardHeader><CardTitle>{t("nodes.detail.topology")}</CardTitle></CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-4">
              <Hop title={t("nodes.detail.user")} body={<Tech>{node.domain}</Tech>} />
              <Hop title={node.activeSide === "primary" ? t("nodes.detail.activePrimary") : t("nodes.detail.activeBackup")} body={server(activeServerId(node))?.name ?? "—"} />
              <Hop title={t("nodes.detail.tunnelHop")} body={tunnel ? `${tunnel.technology} · ${t(`common.status.${tunnel.status}`)}` : t("nodes.detail.none")} />
              <Hop title={t("nodes.detail.foreign")} body={`${server(node.foreignServerId)?.name ?? "—"} · ${t(`common.status.${node.v2bxStatus}`)}`} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t("nodes.detail.cause")}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm leading-7">{copy(report.rootCause)}</p>
              <p className="mt-2 text-sm text-muted-foreground">{copy(report.recommendation)}</p>
              <div className="mt-4">{monitor ? <ObservedTrend scope={{ tunnelId: activeTunnelId(node) }} series={[{ key: "rtt", name: "RTT", color: "#38bdf8" }, { key: "loss", name: t("nodes.detail.loss"), color: "#f59e0b" }]} /> : <TrendChart data={series} series={[{ key: "rtt", name: "RTT", color: "#38bdf8" }, { key: "loss", name: t("nodes.detail.loss"), color: "#f59e0b" }]} />}</div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="tunnel" className="mt-4">
          {monitor && allowed && <NodeRouteSelection key={`${node.id}:${node.primaryTunnelId}:${node.backupTunnelId}:${node.activeSide}`} node={node} tunnels={tunnels} />}
          {tunnel ? <TunnelFacts tunnelId={tunnel.id} /> : <p>{t("nodes.detail.noActiveTunnel")}</p>}
          <Link className="mt-3 inline-block text-sm text-primary" href={tunnel ? `/tunnels/${tunnel.id}` : "/tunnels"}>{t("nodes.detail.fullTunnel")}</Link>
        </TabsContent>
        <TabsContent value="speed" className="mt-4">
          {!monitor && <DemoNote>{t("nodes.detail.speedDemo")}</DemoNote>}
          <Link href={`/speedtest?node=${node.id}&tunnel=${activeTunnelId(node)}&source=${activeServerId(node)}&dest=${node.foreignServerId}`} className="text-primary">
            {monitor ? t("nodes.detail.iperf") : t("nodes.detail.simulatedTest")}
          </Link>
        </TabsContent>
        <TabsContent value="logs" className="mt-4 space-y-3">
          {monitor ? <NodeLogPreview nodeId={node.id} serverId={node.foreignServerId} /> : <>
            <p className="text-sm text-muted-foreground">{t("nodes.detail.demoLogs")}</p>
            {logs.map((log) => <div key={log.id} className="tech text-xs">{format.formatDateTime(log.ts)} [{log.severity}] {copy(log.message)}</div>)}
            <h3 className="pt-2 font-medium">{t("nodes.detail.sharedV2bx")}</h3>
            {shared.map((log) => <div key={log.id} className="tech text-xs text-muted-foreground">{format.formatDateTime(log.ts)} {copy(log.message)}</div>)}
            <Link className="text-sm text-primary" href={`/servers/${encodeURIComponent(node.foreignServerId)}#v2bx-logs`}>{t("nodes.detail.openLogViewer")}</Link>
          </>}
        </TabsContent>
        <TabsContent value="dns" className="mt-4 space-y-2 text-sm">
          {monitor ? (
            <>
              <p>{t("nodes.detail.dnsLive")}</p>
              <div>{t("nodes.detail.domain")} <Tech>{node.domain}</Tech></div>
              <Link className="text-primary" href="/dns">{t("common.nav.dns")}</Link>
            </>
          ) : dns ? (
            <>
              <div>{t("nodes.detail.domain")} <Tech>{dns.domain}</Tech></div>
              <div>{t("nodes.detail.v2boardHost")} <Tech>{dns.v2boardHost}</Tech></div>
              <div>{t("nodes.detail.panelIp")} <Tech>{dns.v2boardIp ?? "—"}</Tech></div>
              <div>{t("nodes.detail.a")} <Tech>{dns.aRecords.join(", ") || "—"}</Tech></div>
              <div>{t("nodes.detail.status")} <StatusBadge value={node.dnsStatus} /></div>
              <p className="text-muted-foreground">{copy(dns.note)}</p>
              <Link className="text-primary" href={`/dns/${node.id}`}>{t("nodes.detail.fullDns")}</Link>
            </>
          ) : <p>{t("nodes.detail.noRecord")}</p>}
        </TabsContent>
        <TabsContent value="failover" className="mt-4 space-y-3 text-sm">
          <p>{t("nodes.detail.activePath", { side: node.activeSide === "primary" ? t("nodes.detail.primaryIran") : t("nodes.detail.backupIran") })} · {t("nodes.detail.machine")} <StatusBadge value={node.failoverState} /></p>
          {monitor && !node.backupTunnelId && <Link href="/tunnels/new">{t("nodes.detail.registerBackupLink")}</Link>}
          {policy ? <p className="text-muted-foreground">{t("nodes.detail.policy", { seconds: policy.intervalSec, threshold: policy.failureThreshold, auto: policy.autoEnabled ? t("nodes.detail.on") : t("nodes.detail.off"), failback: policy.autoFailback ? t("nodes.detail.on") : t("nodes.detail.off") })}</p> : null}
          {events.slice(0, 4).map((event) => <div key={event.id}>{format.formatDateTime(event.at)} · {copy(event.summary)}</div>)}
          <Link className="text-primary" href={`/failover?node=${node.id}`}>{t("nodes.detail.failoverConsole")}</Link>
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <NodeSettingsForm nodeId={node.id} allowed={allowed} defaults={{ name: node.name, domain: node.domain, port: node.port, rateLimitMbps: node.settings.rateLimitMbps, remark: node.settings.remark, probeEnabled: node.settings.probeEnabled, alertOnLoss: node.settings.alertOnLoss }} onSave={updateNodeSettings} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NodeSettingsForm({ nodeId, defaults, allowed, onSave }: { nodeId: string; allowed: boolean; defaults: z.infer<typeof schema>; onSave: (id: string, patch: z.infer<typeof schema>) => Promise<string | null> }) {
  const { t, copy } = useI18n();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: defaults });
  useEffect(() => {
    form.reset(defaults);
    // defaults identity changes each render; reset only when the node changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, form]);
  const message = (key?: string) => key ? t(key) : undefined;
  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={form.handleSubmit(async (values) => {
        const error = await onSave(nodeId, values);
        if (error) toast.error(copy(error));
        else toast.success(t("nodes.detail.savedSettings"));
      })}
    >
      <Field label={t("nodes.detail.name")} error={message(form.formState.errors.name?.message)}><Input disabled={!allowed} {...form.register("name")} /></Field>
      <Field label={t("nodes.detail.domainField")} error={message(form.formState.errors.domain?.message)}><Input className="tech" disabled={!allowed} {...form.register("domain")} /></Field>
      <Field label={t("nodes.detail.port")} error={message(form.formState.errors.port?.message)}><Input className="tech" disabled={!allowed} {...form.register("port")} /></Field>
      <Field label={t("nodes.detail.rate")} error={message(form.formState.errors.rateLimitMbps?.message)}><Input className="tech" disabled={!allowed} {...form.register("rateLimitMbps")} /></Field>
      <Field label={t("nodes.detail.remark")} error={message(form.formState.errors.remark?.message)}><Textarea disabled={!allowed} {...form.register("remark")} /></Field>
      <label className="flex items-center justify-between text-sm">{t("nodes.detail.probe")} <Switch checked={form.watch("probeEnabled")} disabled={!allowed} onCheckedChange={(value) => form.setValue("probeEnabled", value)} /></label>
      <label className="flex items-center justify-between text-sm">{t("nodes.detail.lossAlert")} <Switch checked={form.watch("alertOnLoss")} disabled={!allowed} onCheckedChange={(value) => form.setValue("alertOnLoss", value)} /></label>
      <Button type="submit" disabled={!allowed}>{t("common.save")}</Button>
      {!allowed ? <p className="text-xs text-muted-foreground">{t("nodes.detail.readOnly")}</p> : null}
    </form>
  );
}

function TunnelFacts({ tunnelId }: { tunnelId: string }) {
  const { t } = useI18n();
  const format = useFormat();
  const tunnel = useInfraStore((state) => state.tunnels.find((item) => item.id === tunnelId));
  if (!tunnel) return null;
  return (
    <div className="grid gap-3 md:grid-cols-3 text-sm">
      <Info label={t("nodes.detail.technology")} value={<Tech>{tunnel.technology}</Tech>} />
      <Info label={t("nodes.detail.kind")} value={tunnel.kind === "interface" ? t("nodes.detail.interface") : t("nodes.detail.forwarder")} />
      <Info label={t("nodes.detail.tunnelStatus")} value={<StatusBadge value={tunnel.status} />} />
      <Info label="RTT" value={<Tech>{format.formatMs(tunnel.rttMs)}</Tech>} />
      <Info label={t("nodes.detail.jitter")} value={<Tech>{format.formatMs(tunnel.jitterMs)}</Tech>} />
      <Info label={t("nodes.detail.loss")} value={<Tech>{format.formatPercent(tunnel.packetLoss, 1)}</Tech>} />
      <Info label={t("nodes.detail.mtu")} value={<Tech>{tunnel.mtu}</Tech>} />
      <Info label={t("nodes.detail.rxtx")} value={<Tech>{format.formatMbps(tunnel.rxMbps)} / {format.formatMbps(tunnel.txMbps)}</Tech>} />
      <Info label={t("nodes.detail.interfaceOrService")} value={<Tech>{tunnel.interfaceName || tunnel.serviceName}</Tech>} />
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1">{value}</div></div>;
}
function Hop({ title, body }: { title: string; body: React.ReactNode }) {
  return <div className="rounded-xl bg-muted p-3"><div className="text-xs text-muted-foreground">{title}</div><div className="mt-1 text-sm">{body}</div></div>;
}
function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><Label>{label}</Label>{children}{error ? <span className="text-xs text-destructive">{error}</span> : null}</label>;
}
