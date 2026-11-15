"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { LegacyColumnDef } from "@tanstack/react-table/legacy";
import { ObservedTrend } from "@/components/charts/observed-trend";
import { TrendChart } from "@/components/charts/trend-chart";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmButton, DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { buildEntitySeries } from "@/lib/metrics";
import { TUNNEL_TECHS } from "@/lib/topology";
import { availabilityCount, availabilityPct } from "@/lib/availability";
import { can } from "@/lib/rbac";
import { serverIdentifier } from "@/lib/server-inventory";
import { setTunnelDns, useBackend, useInfraAction, useObservedAvailability } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import { OperationalTunnelDeployment } from "./operational-tunnel-deployment";
import { TunnelPing } from "./manual-ping";
import { TunnelActivity } from "./tunnel-activity";
import { RegisterTunnelButton } from "./topology-registration";
import { useV2BoardCatalog } from "./v2board-inventory";
import type { Tunnel, TunnelTech } from "@/types";

const TECHS = TUNNEL_TECHS;

export function TunnelsView({ serverId }: { serverId?: string }) {
  const { t } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const user = useCurrentUser();
  const tunnels = useInfraStore((state) => state.tunnels);
  const servers = useInfraStore((state) => state.servers);
  const nodes = useInfraStore((state) => state.nodes);
  const catalog = useV2BoardCatalog(monitor);
  const [q, setQ] = useState("");
  const [tech, setTech] = useState("all");
  const availability = useObservedAvailability("24h", monitor);
  const name = (id: string) => {
    const server = servers.find((item) => item.id === id);
    return server ? (monitor ? serverIdentifier(server) : server.name) : id;
  };
  const nodeName = (tunnel: Tunnel) => {
    const ref = tunnel.nodeRef;
    const panel = ref?.kind === "v2board" ? catalog.data?.nodes.find((node) => node.key === ref.key) : undefined;
    const linked = ref?.kind === "inventory" ? nodes.filter((node) => node.id === ref.id)
      : panel?.nodeId ? nodes.filter((node) => node.id === panel.nodeId)
      : nodes.filter((node) => tunnel.nodeIds.includes(node.id) || node.primaryTunnelId === tunnel.id || node.backupTunnelId === tunnel.id);
    return panel?.name || linked.map((node) => node.name).join("، ") || "—";
  };
  const host = servers.find((server) => server.id === serverId);
  const filtered = tunnels.filter((tunnel) =>
    (!serverId || tunnel.iranEndpoint.serverId === serverId || tunnel.foreignEndpoint.serverId === serverId) &&
    (tech === "all" || tunnel.technology === tech) && `${nodeName(tunnel)} ${tunnel.name} ${tunnel.id} ${tunnel.technology}`.toLowerCase().includes(q.trim().toLowerCase()));
  const side = (value: Tunnel["side"]) => t(value === "backup" ? "tunnels.side.backup" : "tunnels.side.primary");
  const columns: LegacyColumnDef<Tunnel>[] = [
    { id: "nodeName", accessorFn: nodeName, header: t("nodes.facts.name"), cell: ({ row, getValue }) => <div className="space-y-1"><Link className="text-primary" href={`/tunnels/${encodeURIComponent(row.original.id)}`}><bdi>{getValue<string>()}</bdi></Link><TunnelActivity tunnel={row.original} /></div> },
    { accessorKey: "technology", header: t("tunnels.columns.technology"), cell: ({ row }) => <Tech>{row.original.technology}</Tech> },
    { id: "iran", header: t("tunnels.columns.iran"), cell: ({ row }) => name(row.original.iranEndpoint.serverId) },
    { id: "foreign", header: t("tunnels.columns.foreign"), cell: ({ row }) => name(row.original.foreignEndpoint.serverId) },
    { accessorKey: "side", header: t("tunnels.columns.side"), cell: ({ row }) => side(row.original.side) },
    { id: "iface", header: t("tunnels.columns.interface"), cell: ({ row }) => <Tech>{row.original.interfaceName || row.original.serviceName}</Tech> },
    { id: "sourceIp", header: t("tunnels.columns.sourceIp"), cell: ({ row }) => <Tech>{row.original.iranEndpoint.tunnelIp ?? "—"}</Tech> },
    { id: "destinationIp", header: t("tunnels.columns.destinationIp"), cell: ({ row }) => <Tech>{row.original.foreignEndpoint.tunnelIp ?? "—"}</Tech> },
    { accessorKey: "status", header: t("tunnels.columns.status"), cell: ({ row }) => <StatusBadge value={row.original.status} /> },
    { accessorKey: "rttMs", header: t("tunnels.columns.rtt"), cell: ({ row }) => <Tech>{monitor && row.original.kind === "forwarder"
      ? row.original.forwarderProbe?.ok ? format.formatMs(row.original.forwarderProbe.elapsedMs) : "—"
      : format.formatMs(row.original.rttMs)}</Tech> },
    { accessorKey: "jitterMs", header: t("tunnels.columns.jitter"), cell: ({ row }) => <Tech>{monitor && row.original.kind === "forwarder" ? "—" : format.formatMs(row.original.jitterMs)}</Tech> },
    { accessorKey: "packetLoss", header: t("tunnels.columns.loss"), cell: ({ row }) => <Tech>{monitor && row.original.kind === "forwarder" ? "—" : format.formatPercent(row.original.packetLoss, 1)}</Tech> },
    { accessorKey: "mtu", header: "MTU", cell: ({ row }) => <Tech>{monitor && row.original.kind === "forwarder" ? "—" : row.original.mtu}</Tech> },
    { id: "traffic", header: "RX/TX", cell: ({ row }) => <Tech>{monitor && row.original.kind === "forwarder" ? "—" : `${Math.round(row.original.rxMbps)}/${Math.round(row.original.txMbps)}`}</Tech> },
    { id: "check", header: t("tunnels.columns.lastCheck"), cell: ({ row }) => format.formatDateTime(row.original.lastCheck) },
    { id: "up", header: monitor ? t("tunnels.columns.probes") : t("tunnels.columns.uptime"), cell: ({ row }) => {
      const rate = monitor ? availabilityPct(availabilityCount(availability.data?.tunnels, row.original.id)) : row.original.uptimePct;
      return rate === null ? "—" : format.formatPercent(rate, 2);
    } },
  ];
  return (
    <div>
      <PageHeader title={t("tunnels.title")} description={t("tunnels.description")} actions={<div className="flex flex-wrap gap-2">
          {monitor && can(user.role, "tunnel.create") && <RegisterTunnelButton servers={servers} />}
          {!monitor && <Button asChild><Link href="/tunnels/new">{t("tunnels.new")}</Link></Button>}
        </div>} />
      {serverId && <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span>{t("tunnels.serverTunnels")} <Tech>{host ? serverIdentifier(host) : serverId}</Tech></span>
        <Link href="/tunnels" className="text-primary">{t("tunnels.showAll")}</Link>
      </div>}
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t("tunnels.search")} />
        <Select value={tech} onChange={(event) => setTech(event.target.value)}>
          <option value="all">{t("tunnels.allTechnologies")}</option>
          {TECHS.map((item) => <option key={item}>{item}</option>)}
        </Select>
      </div>
      <DataTable columns={columns} data={filtered} pageSize={10} />
    </div>
  );
}

export function TunnelDetailView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const params = useParams<{ id: string }>();
  // Client navigation can leave the allowed colon in an ID percent encoded.
  const tunnelId = params.id.replace(/%3a/gi, ":");
  const user = useCurrentUser();
  const tunnel = useInfraStore((state) => state.tunnels.find((item) => item.id === tunnelId));
  const servers = useInfraStore((state) => state.servers);
  const linkedNode = useInfraStore((state) => {
    const ref = tunnel?.nodeRef;
    return state.nodes.find((node) => ref?.kind === "inventory" && node.id === ref.id)
      ?? state.nodes.find((node) => tunnel?.nodeIds.includes(node.id));
  });
  const tunnelAction = useInfraAction("tunnelAction");
  const deleteTunnel = useInfraAction("deleteTunnel");
  const reconfigureTunnel = useInfraAction("reconfigureTunnel");
  const [mtu, setMtu] = useState(tunnel?.mtu ?? 1400);
  const [settingDns, setSettingDns] = useState(false);
  const [diag, setDiag] = useState<string[] | null>(null);
  if (!tunnel) return <PageHeader title={t("tunnels.notFound")} />;
  const iran = servers.find((server) => server.id === tunnel.iranEndpoint.serverId);
  const foreign = servers.find((server) => server.id === tunnel.foreignEndpoint.serverId);
  const series = buildEntitySeries("6h", tunnel.id, { rtt: tunnel.rttMs || 30, loss: tunnel.packetLoss, rx: tunnel.rxMbps, tx: tunnel.txMbps, offline: tunnel.status === "offline" });
  const run = async (action: "start" | "stop" | "restart") => {
    const error = await tunnelAction(tunnel.id, action);
    if (error) toast.error(copy(error));
    else toast.success(t("tunnels.actionSimulated"));
  };
  const details = <>
      {!monitor && <DemoNote>{t("tunnels.demoActions")}</DemoNote>}
      <div className="grid gap-3 md:grid-cols-3">
        <Topo title={t("tunnels.iranServer")} body={`${iran?.name ?? "—"} · ${tunnel.iranEndpoint.publicIp}`} />
        <Topo title={tunnel.kind === "interface" ? t("tunnels.tunnelOf", { technology: tunnel.technology }) : t("tunnels.serviceOf", { technology: tunnel.technology })} body={tunnel.interfaceName || tunnel.serviceName || "—"} />
        <Topo title={t("tunnels.foreignServer")} body={`${foreign?.name ?? "—"} · ${tunnel.foreignEndpoint.publicIp}`} />
      </div>
      {monitor && <div className="grid gap-3 md:grid-cols-4">
        <Topo title={t("tunnels.columns.side")} body={t(tunnel.side === "backup" ? "tunnels.side.backup" : "tunnels.side.primary")} />
        {tunnel.kind === "interface" && <>
          <Info label={t("tunnels.columns.sourceIp")} value={tunnel.iranEndpoint.tunnelIp ?? "—"} />
          <Info label={t("tunnels.columns.destinationIp")} value={tunnel.foreignEndpoint.tunnelIp ?? "—"} />
          <Info label="MTU" value={String(tunnel.configuredMtu ?? tunnel.mtu)} />
        </>}
      </div>}
      {monitor && tunnel.nodeRef && <p className="text-sm text-muted-foreground">
        {t("tunnels.linkedNode")}{" "}{linkedNode
          ? <Link className="text-primary" href={`/nodes/${encodeURIComponent(linkedNode.id)}`}>{linkedNode.name}</Link>
          : <Link className="text-primary" href="/nodes"><bdi>{tunnel.nodeRef.kind === "v2board" ? tunnel.nodeRef.key : tunnel.nodeRef.id}</bdi></Link>}
      </p>}
      {monitor && <Card>
        <CardHeader><CardTitle>{t("tunnels.dns.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{t("tunnels.dns.description")}</p>
          <p><Tech>{linkedNode?.domain ?? "—"}</Tech> → <Tech>{iran?.publicIpv4 ?? "—"}</Tech></p>
          <Button disabled={settingDns || !can(user.role, "dns.switch") || tunnel.status !== "healthy" || !tunnel.nodeRef && !linkedNode || !iran}
            onClick={async () => {
              setSettingDns(true);
              try {
                await setTunnelDns(tunnel.id);
                toast.success(t("tunnels.dns.success"));
              } catch (error) {
                toast.error(copy(error instanceof Error ? error.message : t("tunnels.dns.failed")));
              } finally { setSettingDns(false); }
            }}>{t(settingDns ? "tunnels.dns.setting" : "tunnels.dns.set")}</Button>
          {tunnel.status !== "healthy" && <p className="text-muted-foreground">{t("tunnels.dns.needsHealthy")}</p>}
        </CardContent>
      </Card>}
      {monitor && tunnel.kind === "interface" && tunnel.iranEndpoint.interfaceName && tunnel.foreignEndpoint.tunnelIp &&
        <TunnelPing tunnelId={tunnel.id} editable={can(user.role, "dns.check")} />}
      {!monitor && <>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!can(user.role, "tunnel.mutate")} onClick={() => void run("start")}>{t("tunnels.start")}</Button>
        <Button variant="outline" disabled={!can(user.role, "tunnel.mutate")} onClick={() => void run("stop")}>{t("tunnels.stop")}</Button>
        <Button variant="outline" disabled={!can(user.role, "tunnel.mutate")} onClick={() => void run("restart")}>{t("tunnels.restart")}</Button>
        <Button variant="secondary" onClick={() => setDiag([
          tunnel.status === "offline" ? t("tunnels.pathDown") : t("tunnels.pathUp"),
          tunnel.kind === "interface" ? t("tunnels.interfaceState", { name: tunnel.interfaceName, state: tunnel.status === "offline" ? t("tunnels.down") : t("tunnels.up") }) : t("tunnels.forwarderKind"),
          t("tunnels.currentMtu", { mtu: tunnel.mtu }),
          iran?.agent.status === "online" ? t("tunnels.agentOnline") : t("tunnels.agentOffline"),
        ])}>{t("tunnels.diagnose")}</Button>
        <ConfirmButton label={t("tunnels.delete")} destructive title={t("tunnels.deleteTitle")} description={t("tunnels.deleteBody")} disabled={!can(user.role, "tunnel.delete")} onConfirm={async () => { const error = await deleteTunnel(tunnel.id); if (error) toast.error(copy(error)); else toast.success(t("tunnels.deleted")); }} />
      </div>
      <Card>
        <CardHeader><CardTitle>{t("tunnels.reconfigure")}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">MTU <Input className="tech w-32" value={mtu} onChange={(event) => setMtu(Number(event.target.value))} /></label>
          <Button variant="outline" disabled={!can(user.role, "tunnel.mutate")} onClick={async () => { const error = await reconfigureTunnel(tunnel.id, mtu); if (error) toast.error(copy(error)); else toast.success(t("tunnels.mtuSaved")); }}>{t("tunnels.apply")}</Button>
        </CardContent>
      </Card>
      {diag ? <Card><CardHeader><CardTitle>{t("tunnels.diagnosis")}</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">{diag.map((line) => <p key={line}>{line}</p>)}</CardContent></Card> : null}
      </>}
      {monitor && tunnel.kind === "forwarder" ? <div className="grid gap-3 md:grid-cols-2 text-sm">
        <Info label={t("tunnels.httpsTime")} value={tunnel.forwarderProbe?.ok ? format.formatMs(tunnel.forwarderProbe.elapsedMs) : "—"} />
        <Info label={t("tunnels.lastProbe")} value={format.formatDateTime(tunnel.lastCheck)} />
      </div> : <div className="grid gap-3 md:grid-cols-4 text-sm">
        <Info label={t("tunnels.rtt")} value={format.formatMs(tunnel.rttMs)} />
        <Info label={t("tunnels.jitter")} value={format.formatMs(tunnel.jitterMs)} />
        <Info label={t("tunnels.loss")} value={format.formatPercent(tunnel.packetLoss, 1)} />
        <Info label={t("tunnels.traffic")} value={`${format.formatMbps(tunnel.rxMbps)} / ${format.formatMbps(tunnel.txMbps)}`} />
      </div>}
      <Card><CardHeader><CardTitle>{t("tunnels.quality")}</CardTitle></CardHeader><CardContent>{monitor ? <ObservedTrend scope={{ tunnelId: tunnel.id }} series={tunnel.kind === "forwarder"
        ? [{ key: "forwardLatency", name: t("tunnels.forwardLatency"), color: "#38bdf8" }]
        : [{ key: "rtt", name: t("tunnels.rttMs"), color: "#38bdf8" }, { key: "loss", name: t("tunnels.lossPercent"), color: "#f59e0b" }, { key: "jitter", name: t("tunnels.jitterMs"), color: "#a78bfa" }]} /> : <TrendChart data={series} series={[{ key: "rtt", name: t("tunnels.rtt"), color: "#38bdf8" }, { key: "loss", name: t("tunnels.loss"), color: "#f59e0b" }]} />}</CardContent></Card>
      {monitor && <Card><CardHeader><CardTitle>{t("tunnels.bandwidthTitle")}</CardTitle></CardHeader>
        <CardContent><ObservedTrend scope={{ tunnelId: tunnel.id }} series={[{ key: "bandwidth", name: t("tunnels.bandwidth"), color: "#2dd4bf" }]} /></CardContent></Card>}
      {!monitor && <Card><CardHeader><CardTitle>{t("tunnels.configPreview")}</CardTitle></CardHeader><CardContent><pre className="tech overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(tunnel.config, null, 2)}</pre></CardContent></Card>}
  </>;
  return (
    <div className="space-y-4">
      <PageHeader title={tunnel.name} description={monitor ? t("tunnels.monitorDescription") : t("tunnels.demoDescription")} actions={<StatusBadge value={tunnel.status} />} />
      <TunnelActivity tunnel={tunnel} />
      {monitor ? <OperationalTunnelDeployment key={tunnel.id} tunnelId={tunnel.id}>{details}</OperationalTunnelDeployment> : details}
    </div>
  );
}

export function TunnelWizardView() {
  const { t } = useI18n();
  const monitor = useBackend((state) => state.mode === "monitor");
  return monitor ? <div>
    <PageHeader title={t("tunnels.operationalTitle")} description={t("tunnels.operationalDescription")} />
    <OperationalTunnelDeployment />
  </div> : <SimulatedTunnelWizardView />;
}

function SimulatedTunnelWizardView() {
  const { t, copy } = useI18n();
  const router = useRouter();
  const user = useCurrentUser();
  const servers = useInfraStore((state) => state.servers);
  const createTunnel = useInfraAction("createTunnel");
  const [step, setStep] = useState(0);
  const [technology, setTechnology] = useState<TunnelTech>("WireGuard");
  const [iranServerId, setIranServerId] = useState(servers.find((server) => server.roles.some((role) => role.startsWith("iran")))?.id ?? "");
  const [foreignServerId, setForeignServerId] = useState(servers.find((server) => server.roles.includes("foreign"))?.id ?? "");
  const [port, setPort] = useState(4430);
  const [mtu, setMtu] = useState(1420);
  const [outcome, setOutcome] = useState<"success" | "fail">("success");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const iran = servers.filter((server) => server.roles.some((role) => role.startsWith("iran")));
  const foreign = servers.filter((server) => server.roles.includes("foreign"));
  const kind = ["GOST", "Backhaul", "Rathole"].includes(technology) ? "forwarder" : "interface";
  const stepKeys = ["technology", "iran", "foreign", "address", "mtu", "preflight", "preview", "deploy", "result"] as const;
  const steps = stepKeys.map((key) => t(`tunnels.wizard.step.${key}`));
  const checks = [
    { ok: Boolean(iranServerId), text: iranServerId ? t("tunnels.wizard.check.iranReady") : t("tunnels.wizard.check.iranRequired") },
    { ok: Boolean(foreignServerId), text: foreignServerId ? t("tunnels.wizard.check.foreignReady") : t("tunnels.wizard.check.foreignRequired") },
    { ok: iranServerId !== foreignServerId, text: iranServerId !== foreignServerId ? t("tunnels.wizard.check.distinct") : t("tunnels.wizard.check.same") },
    { ok: mtu >= 1280 && mtu <= 1500, text: mtu >= 1280 && mtu <= 1500 ? t("tunnels.wizard.check.mtuReady") : t("tunnels.wizard.check.mtuInvalid") },
  ];
  const ready = checks.every((item) => item.ok);

  return (
    <div>
      <PageHeader title={t("tunnels.wizard.title")} description={t("tunnels.wizard.description")} />
      <DemoNote>{t("tunnels.wizard.note")}</DemoNote>
      <div className="mb-4 flex flex-wrap gap-2 text-xs">{steps.map((item, index) => <span key={stepKeys[index]} className={index === step ? "rounded-full bg-primary px-2 py-1 text-primary-foreground" : "rounded-full bg-muted px-2 py-1"}>{index + 1}. {item}</span>)}</div>
      <Card>
        <CardHeader><CardTitle>{steps[step]}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {step === 0 ? <Select value={technology} onChange={(event) => setTechnology(event.target.value as TunnelTech)}>{TECHS.map((item) => <option key={item}>{item}</option>)}</Select> : null}
          {step === 1 ? <Select value={iranServerId} onChange={(event) => setIranServerId(event.target.value)}>{iran.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select> : null}
          {step === 2 ? <Select value={foreignServerId} onChange={(event) => setForeignServerId(event.target.value)}>{foreign.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select> : null}
          {step === 3 ? <label className="grid gap-1 text-sm"><Label>{t("tunnels.wizard.samplePort")}</Label><Input className="tech" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label> : null}
          {step === 4 ? <label className="grid gap-1 text-sm"><Label>MTU</Label><Input className="tech" value={mtu} onChange={(event) => setMtu(Number(event.target.value))} /></label> : null}
          {step === 5 ? <ul className="space-y-1 text-sm">{checks.map((item) => <li key={item.text}>{item.text}</li>)}<p className="text-muted-foreground">{t("tunnels.wizard.carrier", { kind: kind === "interface" ? t("tunnels.wizard.interface") : t("tunnels.wizard.forwarder") })}</p></ul> : null}
          {step === 6 ? <pre className="tech rounded-lg bg-muted p-3 text-xs">{`tech: ${technology}\niran: ${iranServerId}\nforeign: ${foreignServerId}\nport: ${port}\nmtu: ${mtu}\nmode: demo`}</pre> : null}
          {step === 7 ? (
            <div className="space-y-2">
              <Select value={outcome} onChange={(event) => setOutcome(event.target.value as "success" | "fail")}>
                <option value="success">{t("tunnels.wizard.success")}</option>
                <option value="fail">{t("tunnels.wizard.fail")}</option>
              </Select>
              <Button
                disabled={!can(user.role, "tunnel.create") || busy || !ready}
                onClick={() => {
                  setBusy(true);
                  void createTunnel({ technology, iranServerId, foreignServerId, mtu, port, outcome }).then((error) => {
                    setBusy(false);
                    setLog(error ? [copy(error)] : [t("tunnels.wizard.accepted"), t("tunnels.wizard.written"), t("tunnels.wizard.registered")]);
                    setStep(8);
                    if (error) toast.error(copy(error));
                    else toast.success(t("tunnels.wizard.created"));
                  });
                }}
              >
                {busy ? t("tunnels.wizard.deploying") : t("tunnels.wizard.startDemo")}
              </Button>
            </div>
          ) : null}
          {step === 8 ? <div className="space-y-2 text-sm">{log.map((line) => <p key={line}>{line}</p>)}<Button onClick={() => router.push("/tunnels")}>{t("tunnels.wizard.backToList")}</Button></div> : null}
          <div className="flex justify-between pt-2">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>{t("common.previous")}</Button>
            <Button variant="outline" disabled={step >= 7} onClick={() => setStep((value) => value + 1)}>{t("common.next")}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Topo({ title, body }: { title: string; body: string }) {
  return <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs text-muted-foreground">{title}</div><div className="mt-2 text-sm">{body}</div></div>;
}
function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="tech mt-1">{value}</div></div>;
}
