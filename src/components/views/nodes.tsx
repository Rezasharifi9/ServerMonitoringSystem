"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import Link from "next/link";
import { Eye, EyeOff, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { LegacyColumnDef } from "@tanstack/react-table/legacy";
import { toast } from "sonner";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmButton, PageHeader, Tech } from "@/components/shared/chrome";
import { Badge, Button, Input, Select } from "@/components/ui/kit";
import { Checkbox, Dialog, DialogContent } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { toCsv } from "@/lib/csv";
import { nodeInventoryRows, nodeRouteLabels } from "@/lib/node-inventory";
import { can } from "@/lib/rbac";
import { downloadText } from "@/lib/utils";
import type { PanelAdminNode } from "@/lib/v2board-node-fields";
import { getPanelOnlineSnapshot, changeV2BoardNode, listV2BoardAdminNodes, refreshProvider, syncBackend, useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import { NodeConnectionFacts } from "./node-connection-facts";
import { ImportPanelNode, useV2BoardCatalog, V2BoardInventory } from "./v2board-inventory";
import { V2BoardNodeEditorDialog } from "./v2board-node-admin";

type Row = ReturnType<typeof nodeInventoryRows>[number];

export function NodesView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const user = useCurrentUser();
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const dns = useInfraStore((state) => state.dns);
  const interval = useInfraStore((state) => Math.max(state.settings.monitoringIntervalSec, state.settings.telemetryIntervals?.tunnelProbe ?? 120));
  const refreshMetrics = useInfraAction("refreshMetrics");
  const catalog = useV2BoardCatalog(monitor);
  const presence = useQuery({ queryKey: ["nodes-online", user.id], queryFn: getPanelOnlineSnapshot,
    enabled: monitor, refetchInterval: (query) => pollingInterval(query, POLLING.inventory), staleTime: 0, retry: false });
  const onlineByKey = new Map((presence.isError ? [] : presence.data?.nodes ?? []).map((item) => [item.key, item.online]));
  const entries = (catalog.data?.nodes ?? []).map((entry) => ({ ...entry, online: onlineByKey.get(entry.key) }));
  const canManagePanel = monitor && catalog.data?.enabled === true && can(user.role, "node.edit") && can(user.role, "integration.edit");
  const admin = useQuery({ queryKey: ["v2board-admin-nodes"], queryFn: listV2BoardAdminNodes, enabled: canManagePanel, retry: false });
  const adminNodes = canManagePanel ? admin.data?.nodes ?? [] : [];
  const adminByKey = new Map(adminNodes.map((node) => [`${node.type}:${node.id}`, node]));
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [country, setCountry] = useState("all");
  const [tech, setTech] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editNode, setEditNode] = useState<PanelAdminNode | null>();
  const [busy, setBusy] = useState(false);
  const rows = nodeInventoryRows(nodes, monitor ? entries : [], tunnels, servers, dns, interval, monitor, adminNodes);
  const countries = Array.from(new Set(nodes.map((node) => node.country)));
  const techs = Array.from(new Set(tunnels.map((tunnel) => tunnel.technology)));
  const term = q.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    const blob = [row.name, row.domain, row.protocol, row.node?.id, row.panelKey].join(" ").toLowerCase();
    if (term && !blob.includes(term)) return false;
    if (status !== "all" && row.routeStatus !== status) return false;
    if (country !== "all" && row.node?.country !== country) return false;
    if (tech !== "all" && (row.technology ?? "unknown") !== tech) return false;
    return true;
  });
  const detail = rows.find((row) => row.id === detailId);
  const changeNode = useMutation({ mutationFn: changeV2BoardNode, onSuccess: async () => {
    await Promise.all([admin.refetch(), refreshProvider("v2board/sync")]);
    await catalog.refetch();
    toast.success(t("nodes.list.nodeChanged"));
  }, onError: (error) => toast.error(copy(error.message)) });
  const columns: LegacyColumnDef<Row>[] = [
    { id: "select", header: "", enableSorting: false, cell: ({ row: { original } }) => <Checkbox
      aria-label={t("nodes.list.select", { name: original.name })} checked={selected.includes(original.id)}
      onCheckedChange={(checked) => setSelected((current) => checked ? [...current, original.id] : current.filter((id) => id !== original.id))}
    /> },
    { accessorKey: "name", header: t("nodes.list.nodeName"), cell: ({ row: { original } }) => original.node
      ? <Link className="font-medium text-primary" href={`/nodes/${encodeURIComponent(original.node.id)}`}>{original.name}</Link>
      : <span className="font-medium">{original.name}</span> },
    { accessorKey: "domain", header: t("nodes.list.domain"), cell: ({ row }) => row.original.domain ? <Tech>{row.original.domain}</Tech> : t("nodes.unknown") },
    { accessorKey: "port", header: t("nodes.list.port"), cell: ({ row }) => <Tech>{row.original.port || "—"}</Tech> },
    { accessorKey: "protocol", header: t("nodes.list.protocol"), cell: ({ row }) => <Tech>{row.original.protocol || "—"}</Tech> },
    { accessorKey: "transport", header: t("nodes.list.transport"), cell: ({ row }) => <Tech>{row.original.transport || "—"}</Tech> },
    ...(monitor ? [{ id: "online", accessorFn: (row: Row) => row.online ?? -1, header: t("nodes.list.online"),
      cell: ({ row }: { row: { original: Row } }) => row.original.online == null ? "—" : <Tech>{format.formatNumber(row.original.online)}</Tech> } satisfies LegacyColumnDef<Row>] : []),
    ...(["source", "destination"] as const).map((side): LegacyColumnDef<Row> => ({
      id: side,
      header: t(`speedtest.${side}`),
      accessorFn: (row) => row[`${side}Endpoint`]?.publicIp,
      cell: ({ row }) => {
        const endpoint = row.original[`${side}Endpoint`];
        if (!endpoint?.publicIp) return "—";
        return servers.some((server) => server.id === endpoint.serverId)
          ? <Link className="whitespace-nowrap text-primary hover:underline" href={`/servers/${encodeURIComponent(endpoint.serverId)}`} title={t("servers.viewDetails")}><Tech>{endpoint.publicIp}</Tech></Link>
          : <Tech>{endpoint.publicIp}</Tech>;
      },
    })),
    { accessorKey: "routeStatus", header: t("nodes.list.health"), cell: ({ row }) => {
      const route = row.original.routeStatus;
      return <Badge className={route === "healthy" || route === "backup" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : route === "unknown" ? "bg-muted text-muted-foreground ring-border" : "bg-red-500/10 text-red-700 dark:text-red-300"}>{t(`nodes.route.${route}`)}</Badge>;
    } },
    { id: "actions", header: t("nodes.list.actions"), enableSorting: false, cell: ({ row: { original } }) => {
      const adminNode = original.panelKey ? adminByKey.get(original.panelKey) : undefined;
      return <div className="flex flex-wrap gap-2 whitespace-nowrap">
        <Button size="icon" variant="ghost" aria-label={t("nodes.list.showDetails")} title={t("nodes.list.showDetails")} onClick={() => setDetailId(original.id)}><Search /></Button>
        {adminNode && <>
          <Button size="icon" variant="ghost" aria-label={t("nodes.list.edit")} title={t("nodes.list.edit")} onClick={() => setEditNode(adminNode)}><Pencil /></Button>
          <ConfirmButton icon={Number(adminNode.fields.show) === 1 ? <EyeOff /> : <Eye />}
            label={Number(adminNode.fields.show) === 1 ? t("nodes.list.hide") : t("nodes.list.show")} title={t("nodes.list.visibilityTitle")}
            description={t("nodes.list.visibilityBody")} confirmLabel={t("common.confirm")}
            disabled={changeNode.isPending} onConfirm={() => changeNode.mutate({ type: adminNode.type, id: adminNode.id, revision: adminNode.revision, show: Number(adminNode.fields.show) !== 1 })} />
          <ConfirmButton icon={<Trash2 />} label={t("nodes.list.delete")} title={t("nodes.list.deleteTitle")} description={t("nodes.list.deleteBody", { name: original.name })}
            confirmLabel={t("nodes.list.delete")} destructive disabled={changeNode.isPending}
            onConfirm={() => changeNode.mutate({ type: adminNode.type, id: adminNode.id, revision: adminNode.revision })} />
        </>}
        {adminNode && !adminNode.fields.parent_id && can(user.role, "deploy.run") &&
          <Button asChild size="sm" variant="ghost"><Link href={`/deployments?panelNode=${adminNode.type}:${adminNode.id}${original.node ? `&serverId=${encodeURIComponent(original.node.foreignServerId)}` : ""}`}>{t("nodes.list.installV2bx")}</Link></Button>}
      </div>;
    } },
  ];

  return (
    <div>
      <PageHeader title={t("nodes.list.title")} description={t("nodes.list.description")}
        actions={<>
          {canManagePanel && <Button size="icon" title={t("nodes.list.add")} aria-label={t("nodes.list.add")} disabled={!admin.data} onClick={() => setEditNode(null)}><Plus /></Button>}
          <Button variant="outline" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              if (monitor) await Promise.all([syncBackend(), catalog.refetch(), presence.refetch(), canManagePanel && admin.refetch()]);
              else await refreshMetrics();
            } finally {
              setBusy(false);
            }
          }}>{busy ? t("nodes.list.refreshing") : t("nodes.list.refresh")}</Button>
        </>}
      />
      {monitor && <V2BoardInventory catalog={catalog} />}
      <div className="mb-4 grid gap-2 md:grid-cols-4">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t("nodes.list.search")} />
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label={t("nodes.list.health")}>
          <option value="all">{t("nodes.list.allStatuses")}</option>
          {Object.keys(nodeRouteLabels).map((key) => <option key={key} value={key}>{t(`nodes.route.${key}`)}</option>)}
        </Select>
        <Select value={country} onChange={(event) => setCountry(event.target.value)} aria-label={t("nodes.list.country")}>
          <option value="all">{t("nodes.list.allCountries")}</option>
          {countries.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <Select value={tech} onChange={(event) => setTech(event.target.value)} aria-label={t("nodes.list.tunnelType")}>
          <option value="all">{t("nodes.list.allTunnels")}</option>
          <option value="unknown">{t("nodes.list.noTunnel")}</option>
          {techs.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
      </div>
      {selected.length > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-sm">
          <span>{t("nodes.list.selected", { count: selected.length })}</span>
          <Button size="sm" variant="outline" onClick={() => {
            const chosen = rows.filter((row) => selected.includes(row.id));
            const csv = toCsv([["id", "name", "domain", "health", "online"], ...chosen.map((row) => [row.node?.id ?? row.panel?.key ?? row.panelKey ?? "", row.name, row.domain, row.node?.health ?? "", row.online ?? ""])]);
            downloadText("nodes.csv", csv, "text/csv");
            toast.success(t("nodes.list.exported"));
          }}>{t("nodes.list.exportSelected")}</Button>
        </div>
      )}
      {canManagePanel && admin.isPending && <p className="mb-3 text-sm text-muted-foreground">{t("nodes.list.loadingAdmin")}</p>}
      {canManagePanel && admin.isError && <p role="alert" className="mb-3 text-sm text-destructive">
        {copy(admin.error.message)} <Button size="sm" variant="outline" onClick={() => void admin.refetch()}>{t("common.retry")}</Button>
      </p>}
      <DataTable columns={columns} data={filtered} pageSize={8} keepPage />
      {canManagePanel && admin.data && <V2BoardNodeEditorDialog node={editNode} catalog={admin.data}
        onClose={() => setEditNode(undefined)} onSaved={async () => {
          setEditNode(undefined);
          await admin.refetch();
          await refreshProvider("v2board/sync");
          await catalog.refetch();
        }} />}
      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        {detail && <DialogContent title={t("nodes.list.detailTitle")}>
          <NodeInventoryDetail key={detail.id} row={detail} catalog={catalog} monitor={monitor} />
        </DialogContent>}
      </Dialog>
    </div>
  );
}

function NodeInventoryDetail({ row, catalog, monitor }: { row: Row; catalog: ReturnType<typeof useV2BoardCatalog>; monitor: boolean }) {
  const { t } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const [assigning, setAssigning] = useState(false);
  const node = row.node;
  const panel = row.panel;
  const matchesMonitoredDomain = node && node.domain.toLowerCase().replace(/\.$/, "") === row.domain.toLowerCase().replace(/\.$/, "");
  const canAssign = !node && panel?.protocol && typeof panel.port === "number" && catalog.data?.enabled && !catalog.data.stale &&
    can(user.role, "integration.edit") && can(user.role, "node.edit");
  return <div className="space-y-4">
    <NodeConnectionFacts name={row.name} domain={row.domain} port={row.port} protocol={row.protocol} tls={panel?.tls} transport={panel?.transport} />
    {monitor && <p className="text-sm">{t("nodes.detail.online")} <Tech>{row.online == null ? "—" : format.formatNumber(row.online)}</Tech></p>}
    {node && <div className="space-y-2 text-sm">
      {monitor && row.expectedIp && <p>{t("nodes.list.activeIranIp")} <Tech>{row.expectedIp}</Tech></p>}
      {monitor && !matchesMonitoredDomain && <p className="text-muted-foreground">{t("nodes.list.monitoredDomain")} <Tech>{node.domain}</Tech></p>}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline"><Link href={`/nodes/${encodeURIComponent(node.id)}`}>{t("nodes.list.openNode")}</Link></Button>
      </div>
    </div>}
    {!node && row.panelKey && <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("nodes.list.noTunnelYet")}</p>
      {canAssign && !assigning && <Button variant="outline" onClick={() => setAssigning(true)}>{t("nodes.list.assignTunnel")}</Button>}
      {canAssign && assigning && <ImportPanelNode entry={panel} onCancel={() => setAssigning(false)} onDone={() => {
        setAssigning(false);
        void catalog.refetch();
      }} />}
    </div>}
  </div>;
}
