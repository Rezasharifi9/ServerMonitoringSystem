"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { LegacyColumnDef } from "@tanstack/react-table/legacy";
import { DataTable } from "@/components/shared/data-table";
import { ConfirmButton, DemoNote, KpiCard, PageHeader, Tech } from "@/components/shared/chrome";
import { Button, Input, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { serverIdentifier } from "@/lib/server-inventory";
import { isIranServer, SERVER_ROLES } from "@/lib/topology";
import { deleteInventoryServer, getPanelSshPublicKey, useBackend } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import { ServerFormButton } from "./server-form";
import { ServerConsoleButton } from "./server-console";
import { ServerPingBadge } from "./server-ping-badge";
import type { Server } from "@/types";
import { countryPresentation } from "@/lib/country";
import { ServerActivity, useServerActivity } from "./server-activity";

function joinList(locale: string, items: string[]) {
  return items.join(locale === "fa-IR" ? "، " : ", ");
}

function ServerTunnels({ id }: { id: string }) {
  const { t } = useI18n();
  const count = useInfraStore((state) => state.tunnels.filter((tunnel) =>
    tunnel.iranEndpoint.serverId === id || tunnel.foreignEndpoint.serverId === id).length);
  return count ? <Link prefetch={false} className="whitespace-nowrap text-primary" href={`/tunnels?server=${encodeURIComponent(id)}`}>{t("servers.tunnelCount", { count })}</Link> : "—";
}

function PanelSshKey() {
  const { t, copy } = useI18n();
  const query = useQuery({ queryKey: ["panel-ssh-public-key"], queryFn: getPanelSshPublicKey, staleTime: Infinity, retry: false });
  const title = t("servers.panelKey.title");
  return <section className="space-y-2 rounded-lg border border-border p-3">
    <h2 className="text-sm font-semibold">{title}</h2>
    {query.data ? <div className="flex items-center gap-2">
      <Input dir="ltr" readOnly value={query.data} aria-label={title} />
      <Button size="icon" variant="outline" aria-label={t("servers.panelKey.copy")} onClick={() => void navigator.clipboard.writeText(query.data).then(
        () => toast.success(t("servers.panelKey.copied")), () => toast.error(t("servers.panelKey.copyFailed")))}><Copy /></Button>
    </div> : <p className="text-sm text-muted-foreground">{query.error ? copy(query.error.message) : t("servers.panelKey.loading")}</p>}
  </section>;
}

function ServerActions({ server }: { server: Server }) {
  const activity = useServerActivity(server);
  const { t, copy, locale } = useI18n();
  const monitor = useBackend((state) => state.mode === "monitor");
  const user = useCurrentUser();
  const tunnels = useInfraStore((state) => state.tunnels);
  const linked = tunnels.filter(({ iranEndpoint, foreignEndpoint }) => [iranEndpoint.serverId, foreignEndpoint.serverId].includes(server.id));
  const [busy, setBusy] = useState(false);
  const view = t("servers.viewDetails");
  return <fieldset disabled={Boolean(activity)} className="flex gap-2 whitespace-nowrap disabled:opacity-50">
    <Button variant="ghost" size="icon" asChild><Link prefetch={false} href={`/servers/${encodeURIComponent(server.id)}`} title={view} aria-label={view}><Search /></Link></Button>
    {monitor && can(user.role, "server.configure") && <ServerFormButton key={server.id} server={server} icon />}
    {monitor && can(user.role, "server.configure") && <ServerConsoleButton serverId={server.id} />}
    {monitor && can(user.role, "server.configure") && can(user.role, "tunnel.delete") && <ConfirmButton destructive icon={<Trash2 />} label={t("servers.delete.label")}
      title={t("servers.delete.title")} confirmLabel={linked.length ? t("servers.delete.confirmWithTunnels") : t("servers.delete.confirm")} disabled={busy}
      description={linked.length ? t("servers.delete.withTunnels", { count: linked.length, names: joinList(locale, linked.map(({ name }) => name)) }) : t("servers.delete.withoutTunnels")}
      onConfirm={async () => {
        setBusy(true);
        try { await deleteInventoryServer(server.id, linked.map(({ id }) => id)); toast.success(t("servers.delete.success")); }
        catch (error) { toast.error(error instanceof Error ? copy(error.message) : t("servers.delete.failed")); }
        finally { setBusy(false); }
      }} />}
  </fieldset>;
}

export function ServersView() {
  const { t, locale } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const user = useCurrentUser();
  const servers = useInfraStore((state) => state.servers);
  const [role, setRole] = useState("all");
  const [provider, setProvider] = useState("");
  const providers = Array.from(new Set(servers.map((server) => server.provider))).sort((a, b) => a.localeCompare(b, locale));
  const [q, setQ] = useState("");
  const search = q.trim().toLowerCase();
  const filtered = servers.filter((server) => {
    if (provider && server.provider !== provider) return false;
    if (role !== "all" && !(role === "iran" ? isIranServer(server.roles) : server.roles.includes("foreign"))) return false;
    return `${serverIdentifier(server)} ${server.publicIpv6 ?? ""} ${server.provider} ${server.os}`.toLowerCase().includes(search);
  });
  const columns = useMemo<LegacyColumnDef<Server>[]>(() => [
    { id: "country", accessorFn: (server) => countryPresentation(server.countryCode, locale)?.name ?? t("servers.unknownCountry"), header: t("servers.columns.country"), cell: ({ row }) => {
      const country = countryPresentation(row.original.countryCode, locale);
      return country ? <span className="whitespace-nowrap"><span aria-hidden="true">{country.flag}</span> {country.name}</span> : t("servers.unknownCountry");
    } },
    { id: "identifier", accessorFn: serverIdentifier, header: t("servers.columns.identifier"), cell: ({ row }) => {
      const identifier = serverIdentifier(row.original);
      return <div className="flex flex-col items-start gap-1">
        <Link prefetch={false} className="whitespace-nowrap text-primary hover:underline" href={`/servers/${encodeURIComponent(row.original.id)}`} title={t("servers.viewDetails")} aria-label={`${t("servers.viewDetails")}: ${identifier}`}><Tech>{identifier}</Tech></Link>
        <ServerActivity server={row.original} />
      </div>;
    } },
    { accessorKey: "publicIpv4", header: t("servers.columns.ipv4"), cell: ({ row }) => <Tech>{row.original.publicIpv4}</Tech> },
    { accessorKey: "provider", header: t("servers.columns.provider"), cell: ({ row }) => <bdi>{row.original.provider}</bdi> },
    { accessorKey: "os", header: t("servers.columns.os"), cell: ({ row }) => <Tech>{row.original.os}</Tech> },
    { id: "cpuCores", accessorFn: (server) => server.hardware?.cpuCores, header: t("servers.columns.cpuCores"), cell: ({ row }) => row.original.hardware?.cpuCores ?? "—" },
    { id: "ramBytes", accessorFn: (server) => server.hardware?.ramBytes, header: t("servers.columns.ram"), cell: ({ row }) => <Tech>{format.formatGiB(row.original.hardware?.ramBytes)}</Tech> },
    { id: "diskBytes", accessorFn: (server) => server.hardware?.diskBytes, header: t("servers.columns.disk"), cell: ({ row }) => <Tech>{format.formatGiB(row.original.hardware?.diskBytes)}</Tech> },
    { id: "tunnels", header: t("servers.columns.tunnels"), cell: ({ row }) => <ServerTunnels id={row.original.id} /> },
    { id: "ping", header: t("servers.columns.ping"), cell: ({ row }) => <ServerPingBadge server={row.original} /> },
    { id: "actions", header: t("servers.columns.actions"), cell: ({ row }) => <ServerActions server={row.original} /> },
  ], [format, t, locale]);

  return (
    <div className="space-y-4">
      {monitor && can(user.role, "server.configure") && <PanelSshKey />}
      <PageHeader title={t("servers.title")} description={t("servers.description")}
        actions={monitor && can(user.role, "server.configure") && <ServerFormButton />} />
      <div className="grid gap-3 sm:grid-cols-2">
        <KpiCard label={t("dashboard.iranServers")} value={servers.filter((server) => isIranServer(server.roles)).length} />
        <KpiCard label={t("dashboard.foreignServers")} value={servers.filter((server) => server.roles.includes("foreign")).length} />
      </div>
      {!monitor && <DemoNote>{t("servers.demoNote")}</DemoNote>}
      <div className="grid gap-2 md:grid-cols-3">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t("servers.search")} />
        <Select value={role} onChange={(event) => setRole(event.target.value)} aria-label={t("servers.roleFilter")}>
          <option value="all">{t("servers.allRoles")}</option>
          {SERVER_ROLES.map((item) => <option key={item} value={item}>{t(`servers.roles.${item}`)}</option>)}
        </Select>
        <Select value={provider} onChange={(event) => setProvider(event.target.value)} aria-label={t("servers.providerFilter")}>
          <option value="">{t("servers.allProviders")}</option>
          {providers.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
      </div>
      <DataTable columns={columns} data={filtered} pageSize={8} keepPage />
    </div>
  );
}
