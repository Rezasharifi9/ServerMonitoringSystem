"use client";

import { POLLING, pollingInterval, jobActive } from "@/lib/polling";

import Link from "next/link";
import { Download, FileText, Gauge, PackagePlus, Power, RefreshCw, RotateCw } from "lucide-react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ObservedTrend } from "@/components/charts/observed-trend";
import { TrendChart } from "@/components/charts/trend-chart";
import { ConfirmButton, DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { ServerVirtualizor } from "./virtualizor";
import { Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { AgentProvisionForm } from "./ssh-provision-form";
import { Button, Card, CardContent, CardHeader, CardTitle, Textarea } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { buildEntitySeries } from "@/lib/metrics";
import { can } from "@/lib/rbac";
import { serverIdentifier } from "@/lib/server-inventory";
import { enableBbr, getBbrStatus, getRebootStatus, getV2bxRestart, listProvisionJobs, rebootServer, restartV2bx, syncBackend, useBackend, useInfraAction, useServerOperations } from "@/services/backend";
import { ServerSshPanel } from "./server-ssh-panel";
import { ServerConsoleButton } from "./server-console";
import { ServerFormButton } from "./server-form";
import { ServerPingBadge } from "./server-ping-badge";
import { ServerActivity } from "./server-activity";
import { ServerV2bxLogs } from "./v2bx-logs";
import { RemoveV2bxButton } from "./v2bx-remove-button";
import { V2bxFilesEditor } from "./v2bx-files";
import { CheckHostPing } from "./manual-ping";
import { useV2BoardCatalog } from "./v2board-inventory";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
const resourceCharts: { id: "cpu" | "ram" | "disk" | "net"; series: { key: string; name: "cpu" | "ram" | "read" | "write" | "rx" | "tx"; color: string }[]; yDomain?: [number, number] }[] = [
  { id: "cpu", series: [{ key: "cpu", name: "cpu", color: "#818cf8" }], yDomain: [0, 100] },
  { id: "ram", series: [{ key: "ram", name: "ram", color: "#818cf8" }], yDomain: [0, 100] },
  { id: "disk", series: [
    { key: "diskReadMiBps", name: "read", color: "#2dd4bf" }, { key: "diskWriteMiBps", name: "write", color: "#f97316" },
  ] },
  { id: "net", series: [
    { key: "rx", name: "rx", color: "#2dd4bf" }, { key: "tx", name: "tx", color: "#818cf8" },
  ] },
];

function joinList(locale: string, items: string[]) {
  return items.join(locale === "fa-IR" ? "، " : ", ");
}

function ServerProvisionButton({ serverId, allowed, action }: { serverId: string; allowed: boolean; action: "v2bx-restart" | "v2bx-reinstall" | "bbr" | "reboot" }) {
  const { t, copy } = useI18n();
  const bbr = action === "bbr";
  const reinstall = action === "v2bx-reinstall";
  const reboot = action === "reboot";
  const client = useQueryClient();
  const key = [action, serverId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => reboot ? getRebootStatus(serverId) : bbr ? getBbrStatus(serverId) : getV2bxRestart(serverId, reinstall),
    refetchInterval: (query) => pollingInterval(query, query.state.data?.job && jobActive(query.state.data.job) ? POLLING.job : POLLING.idle),
  });
  const mutation = useMutation({
    mutationFn: () => reboot ? rebootServer(serverId) : bbr ? enableBbr(serverId) : restartV2bx(serverId, reinstall),
    onSuccess: (job) => {
      client.setQueryData(key, { ready: true, job });
      void client.invalidateQueries({ queryKey: key });
      void syncBackend();
      toast.success(t(reboot ? "servers.detail.queuedReboot" : bbr ? "servers.detail.queuedBbr" : reinstall ? "servers.detail.queuedReinstall" : "servers.detail.queuedRestart"));
    },
    onError: (error) => toast.error(copy(error.message)),
  });
  const job = query.data?.job;
  const busy = job && (job.status === "queued" || job.status === "running" || job.status === "review");
  const label = reboot ? t("servers.detail.rebootServer") : bbr ? t("servers.detail.enableBbr") : reinstall ? t("servers.detail.reinstallV2bx") : t("servers.detail.restartV2bx");
  const icon = reboot ? <Power /> : bbr ? <Gauge /> : reinstall ? <PackagePlus /> : <RefreshCw />;
  return <ConfirmButton icon={icon} label={label} title={label} confirmLabel={label}
    description={reboot ? t("servers.detail.rebootDescription") : bbr ? t("servers.detail.bbrDescription") : reinstall ? t("servers.detail.reinstallDescription") : t("servers.detail.restartDescription")}
    disabled={!allowed || !query.data?.ready || busy || mutation.isPending} onConfirm={() => mutation.mutate()} />;
}

export function ServerDetailView() {
  const { t, copy, locale } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const catalog = useV2BoardCatalog(monitor);
  const params = useParams<{ id: string }>();
  const user = useCurrentUser();
  const server = useInfraStore((state) => state.servers.find((item) => item.id === params.id));
  const localActivity = useServerOperations((state) => state.active[params.id]);
  const allNodes = useInfraStore((state) => state.nodes);
  const allTunnels = useInfraStore((state) => state.tunnels);
  const allAudit = useInfraStore((state) => state.audit);
  const nodes = allNodes.filter((node) => node.primaryServerId === params.id || node.backupServerId === params.id || node.foreignServerId === params.id);
  const tunnels = allTunnels.filter((tunnel) => tunnel.iranEndpoint.serverId === params.id || tunnel.foreignEndpoint.serverId === params.id);
  const audit = allAudit.filter((item) => item.target.includes(params.id)).slice(0, 12);
  const refreshMetrics = useInfraAction("refreshMetrics");
  const restartService = useInfraAction("restartService");
  const updateServerNotes = useInfraAction("updateServerNotes");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [installOpen, setInstallOpen] = useState(false);
  const provision = useQuery({ queryKey: ["provision-availability"], queryFn: listProvisionJobs, enabled: installOpen });
  const [logOpen, setLogOpen] = useState(false);
  const drafted = Boolean(server && Object.prototype.hasOwnProperty.call(drafts, server.id));
  const notes = !server ? "" : drafted ? drafts[server.id] : copy(server.notes);
  const persistNotes = !server ? "" : drafted ? drafts[server.id] : server.notes;
  const setNotes = (value: string) => {
    if (!server) return;
    setDrafts((current) => ({ ...current, [server.id]: value }));
  };
  const serverId = server?.id;
  useEffect(() => {
    if (!serverId || window.location.hash !== "#v2bx-logs") return;
    document.getElementById("v2bx-logs")?.scrollIntoView({ block: "start" });
  }, [serverId]);
  if (!server) return <PageHeader title={t("servers.detail.notFound")} />;
  const foreign = server.roles.includes("foreign");
  const canRemoveV2bx = monitor && foreign && catalog.data?.enabled && can(user.role, "deploy.run") &&
    can(user.role, "server.configure") && can(user.role, "server.restart") && can(user.role, "node.edit") && can(user.role, "integration.edit");
  const series = buildEntitySeries("6h", server.id, { rtt: 20, loss: 0.1, rx: server.rxMbps, tx: server.txMbps, offline: server.status === "offline" });
  const demoSeries = monitor ? [] : series.map((point) => ({
    ...point, diskReadMiBps: Number((point.cpu / 3).toFixed(1)), diskWriteMiBps: Number((point.ram / 6).toFixed(1)),
  }));
  const logsLabel = t("servers.detail.viewLogs");
  const refreshLabel = t("servers.detail.refreshMetrics");
  const v2bx = server.services.find((service) => service.name === "v2bx");

  return (
    <fieldset disabled={Boolean(localActivity || server.activity)} className="min-w-0 space-y-4">
      <ServerActivity server={server} />
      <PageHeader title={serverIdentifier(server)} description={`${server.provider} · ${server.country}`} actions={<div className="flex flex-wrap items-center gap-2">
        <ServerPingBadge server={server} />
        {monitor && can(user.role, "server.configure") && <ServerFormButton server={server} />}
        {monitor && can(user.role, "server.configure") && <ServerConsoleButton serverId={server.id} labeled />}
      </div>} />
      <Tabs defaultValue="overview" key={server.id}>
        <TabsList><TabsTrigger value="overview">{t("settings.virtualizor.overview")}</TabsTrigger>
          {(server.countryCode.toUpperCase() === "IR" || server.roles.some((r) => r === "iran" || r.startsWith("iran-"))) && <TabsTrigger value="virtualizor">Virtualizor</TabsTrigger>}
        </TabsList>
        {(server.countryCode.toUpperCase() === "IR" || server.roles.some((r) => r === "iran" || r.startsWith("iran-"))) && <TabsContent value="virtualizor" className="mt-4"><ServerVirtualizor key={server.id} serverId={server.id} /></TabsContent>}
        <TabsContent value="overview" className="mt-4 space-y-4">
      <Dialog open={installOpen} onOpenChange={setInstallOpen}><DialogContent title={t("servers.detail.installV2bx")}>
        <AgentProvisionForm hostId={server.id} enabled={Boolean(provision.data?.enabled)} onDone={() => { setInstallOpen(false); void syncBackend(); }} />
      </DialogContent></Dialog>
      {!monitor && <DemoNote>{t("servers.detail.demoNote")}</DemoNote>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="icon" title={refreshLabel} aria-label={refreshLabel} onClick={async () => {
          if (monitor) {
            await syncBackend();
            if (useBackend.getState().status !== "connected") toast.error(t("servers.detail.hostRefreshFailed"));
            else toast.success(t("servers.detail.hostRefreshed"));
            return;
          }
          const error = await refreshMetrics();
          if (typeof error === "string" && error) toast.error(copy(error));
          else toast.success(t("servers.detail.metricsRefreshed"));
        }}><RotateCw /></Button>
        {!monitor && <ConfirmButton
          label={t("servers.detail.restartAgent")}
          title={t("servers.detail.restartService")}
          description={t("servers.detail.restartAgentDescription")}
          disabled={!can(user.role, "server.restart")}
          onConfirm={() => void restartService(server.id, "nodeguard-agent").then((error) => error ? toast.error(copy(error)) : toast.success(t("servers.detail.restartSimulated")))}
        />}
        {monitor && <ServerProvisionButton key={`reboot-${server.id}`} action="reboot" serverId={server.id} allowed={can(user.role, "server.restart")} />}
        {monitor && <ServerProvisionButton key={`bbr-${server.id}`} action="bbr" serverId={server.id} allowed={can(user.role, "deploy.run") && can(user.role, "server.configure")} />}
        {monitor && foreign && can(user.role, "deploy.run") && can(user.role, "server.configure") && can(user.role, "tunnel.mutate") &&
          <Button variant="outline" size="icon" onClick={() => setInstallOpen(true)} title={t("servers.detail.installV2bx")} aria-label={t("servers.detail.installV2bx")}><Download /></Button>}
        {monitor && foreign && <ServerProvisionButton key={`v2bx-${server.id}`} action="v2bx-restart" serverId={server.id} allowed={can(user.role, "server.restart")} />}
        {monitor && foreign && <ServerProvisionButton serverId={server.id} action="v2bx-reinstall" allowed={can(user.role, "server.restart") && can(user.role, "server.configure") && can(user.role, "deploy.run")} />}
        {canRemoveV2bx && <RemoveV2bxButton key={server.id} serverId={server.id} serverName={serverIdentifier(server)} />}
        {!monitor && foreign && server.services.some((service) => service.name === "v2bx") ? (
          <ConfirmButton
            label={t("servers.detail.restartV2bxDemo")}
            title={t("servers.detail.restartV2bxDemo")}
            description={t("servers.detail.restartV2bxDemoDescription")}
            disabled={!can(user.role, "server.restart")}
            onConfirm={() => void restartService(server.id, "v2bx").then((error) => error ? toast.error(copy(error)) : toast.success(t("servers.detail.v2bxDemoUp")))}
          />
        ) : null}
        {foreign ? <Button variant="outline" size="icon" title={logsLabel} aria-label={logsLabel} onClick={() => document.getElementById("v2bx-logs")?.scrollIntoView({ behavior: "smooth", block: "start" })}><FileText /></Button>
          : monitor ? <Button variant="outline" size="icon" asChild><Link href={`/logs?server=${encodeURIComponent(server.id)}`} title={t("servers.detail.fullHistory")} aria-label={t("servers.detail.fullHistory")}><FileText /></Link></Button>
            : <Button variant="outline" size="icon" title={logsLabel} aria-label={logsLabel} onClick={() => setLogOpen((value) => !value)}><FileText /></Button>}
      </div>
      {monitor && can(user.role, "server.configure") && <ServerSshPanel key={`ssh-${server.id}`} serverId={server.id}
        agentInstalled={server.agent.status === "online"}
        username={server.sshUsername} port={server.sshPort}
        canInstall={can(user.role, "agent.enroll") && can(user.role, "deploy.run")}
        addresses={server.publicIpv6 ? [server.publicIpv4, server.publicIpv6] : [server.publicIpv4]} />}
      <div className="grid gap-3 md:grid-cols-4 text-sm">
        <Info label={t("servers.detail.ipv4")} value={<Tech>{server.publicIpv4}</Tech>} />
        <Info label={t("servers.detail.ipv6")} value={<Tech>{server.publicIpv6 ?? "—"}</Tech>} />
        <Info label={t("servers.detail.os")} value={<Tech>{server.os}</Tech>} />
        <Info label={t("servers.detail.uptime")} value={monitor && !server.agent.lastHeartbeat ? "—" : format.formatUptime(server.uptimeSec)} />
        <Info label={t("servers.detail.role")} value={joinList(locale, [...new Set(server.roles.map((role) => t(`servers.roles.${role}`)))])} />
        <Info label={t("servers.detail.cpuCores")} value={<Tech>{server.hardware?.cpuCores ?? "—"}</Tech>} />
        <Info label={t("servers.detail.ram")} value={<Tech>{format.formatGiB(server.hardware?.ramBytes)}</Tech>} />
        <Info label={t("servers.detail.disk")} value={<Tech>{format.formatGiB(server.hardware?.diskBytes)}</Tech>} />
        <Info label={t("servers.detail.agent")} value={<Tech>{server.agent.id} · {server.agent.version}</Tech>} />
        <Info label={t("servers.detail.heartbeat")} value={format.formatDateTime(server.agent.lastHeartbeat)} />
        <Info label={t("servers.detail.agentStatus")} value={<StatusBadge value={server.agent.status} />} />
        {monitor && foreign && <Info label={t("servers.detail.v2bxStatus")} value={v2bx ? <StatusBadge value={v2bx.status} /> : t("servers.detail.notReported")} />}
        {!monitor && <Info label={t("servers.detail.capabilities")} value={<Tech>{joinList(locale, server.agent.capabilities)}</Tech>} />}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {monitor && <Card><CardHeader><CardTitle>{t("servers.detail.pingToPanel")}</CardTitle></CardHeader><CardContent>
          <ObservedTrend scope={{ serverId: server.id }} series={[{ key: "serverRtt", name: t("servers.detail.series.rtt"), color: "#38bdf8" }, { key: "serverLoss", name: t("servers.detail.series.loss"), color: "#f59e0b" }]} />
        </CardContent></Card>}
        {resourceCharts.map((chart) => <Card key={chart.id}>
          <CardHeader><CardTitle>{t(`servers.detail.charts.${chart.id}`)}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">{chart.series.map((item) =>
              <span className="inline-flex items-center gap-1.5" key={item.key}>
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />{t(`servers.detail.series.${item.name}`)}
              </span>)}</div>
            {monitor ? <ObservedTrend scope={{ serverId: server.id }} series={chart.series.map((item) => ({ ...item, name: t(`servers.detail.series.${item.name}`) }))} yDomain={chart.yDomain} /> :
              <TrendChart data={demoSeries} series={chart.series.map((item) => ({ ...item, name: t(`servers.detail.series.${item.name}`) }))} yDomain={chart.yDomain} />}
          </CardContent>
        </Card>)}
      </div>
      {foreign && <Card id="v2bx-logs" className="scroll-mt-24"><CardHeader><CardTitle>{t("servers.detail.liveLogs")}</CardTitle></CardHeader>
        <CardContent>{monitor ? <ServerV2bxLogs serverId={server.id} /> : <pre className="tech overflow-auto rounded-lg bg-muted p-3 text-xs">{`[${server.agent.id}] heartbeat demo\nstatus=${server.status}\nservices=${server.services.map((service) => service.name).join(",")}`}</pre>}</CardContent></Card>}
      {monitor && foreign && can(user.role, "server.configure") && can(user.role, "deploy.run") && <V2bxFilesEditor key={server.id} serverId={server.id} />}
      {monitor && <CheckHostPing key={`check-host-${server.id}`} serverId={server.id} />}
      {monitor && server.agent.workers && <Card>
        <CardHeader><CardTitle>{t("servers.detail.workers")}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          {server.agent.workers.map((worker) => <div key={worker.kind} className="space-y-1 rounded-lg border border-border p-3">
            <strong>{t(`servers.detail.workerKind.${worker.kind}`)}</strong>
            <p>{t(`servers.detail.workerStatus.${worker.status}`)}</p>
            <p className="text-muted-foreground">{t("servers.detail.lastContact", { time: worker.lastSeen ? format.formatDateTime(worker.lastSeen) : "—" })}</p>
          </div>)}
        </CardContent>
      </Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("servers.detail.interfaces")}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {server.interfaces.map((item) => <div key={item.name} className="flex justify-between"><Tech>{item.name}</Tech><span>{item.up ? t("servers.detail.up") : t("servers.detail.down")} · <span dir="ltr" className="tech">MTU {item.mtu}</span></span></div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("servers.detail.services")}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {server.services.map((service) => <div key={service.id} className="flex items-center justify-between"><span>{service.name} <Tech>{service.version}</Tech></span><StatusBadge value={service.status} /></div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("servers.detail.tunnels")}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!tunnels.length && <p className="text-muted-foreground">{t("servers.detail.noTunnels")}</p>}
            {tunnels.slice(0, 8).map((tunnel) => <div key={tunnel.id} className="flex justify-between">
              <Link className="text-primary" href={`/tunnels/${encodeURIComponent(tunnel.id)}`}>{tunnel.name}</Link><StatusBadge value={tunnel.status} />
            </div>)}
            {tunnels.length > 8 && <Link className="text-primary" href={`/tunnels?server=${encodeURIComponent(server.id)}`}>{t("servers.detail.allTunnels")}</Link>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("servers.detail.v2boardNodes")}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {server.panelNodeRefs?.map((ref) => <div key={ref} className="flex items-center justify-between gap-3">
              <span>{catalog.data?.nodes.find((entry) => entry.key === ref)?.name ?? ref}</span><Tech>{ref}</Tech>
            </div>)}
            {nodes.map((node) => {
              const online = catalog.data?.nodes.find((entry) => entry.nodeId === node.id)?.online;
              return <div key={node.id} className="flex items-center justify-between gap-3">
                <span>{node.name}</span>
                <span className="flex items-center gap-2">
                  {monitor && <span title={t("nodes.detail.online")}><Tech>{online == null ? "—" : format.formatNumber(online)}</Tech></span>}
                  <StatusBadge value={node.health} />
                </span>
              </div>;
            })}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>{t("servers.detail.configuration")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          <Button disabled={!can(user.role, "server.configure")} onClick={async () => { const error = await updateServerNotes(server.id, persistNotes); if (error) toast.error(copy(error)); else toast.success(t("servers.detail.notesSaved")); }}>{monitor ? t("servers.detail.saveNotes") : t("servers.detail.saveDemo")}</Button>
          <p className="text-sm font-medium">{t("servers.detail.operationHistory")}</p>
          {!audit.length && <p className="text-xs text-muted-foreground">{t("servers.detail.operationHistoryEmpty")}</p>}
          {audit.map((item) => <div key={item.id} className="text-xs text-muted-foreground">{format.formatDateTime(item.at)} · {copy(item.detail)}</div>)}
          <Link className="text-sm text-primary" href={`/logs?server=${encodeURIComponent(server.id)}`}>{t("servers.detail.fullHistory")}</Link>
          {!monitor && !foreign && logOpen ? <pre className="tech overflow-auto rounded-lg bg-muted p-3 text-xs">{`[${server.agent.id}] heartbeat demo\nstatus=${server.status}\nservices=${server.services.map((service) => service.name).join(",")}`}</pre> : null}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>
    </fieldset>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1">{value}</div></div>;
}
