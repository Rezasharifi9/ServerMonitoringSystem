"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { refreshProvider, useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { DNSRecord, DnsStatus } from "@/types";
import { ManagedDomains } from "./managed-domains";

const statuses: DnsStatus[] = ["matched", "mismatched", "propagation", "stale", "proxied", "cname", "error"];

function recordTtl(record: DNSRecord, auto: string) {
  return record.ttl === 1 ? auto : record.ttl ? `${record.ttl} s` : "—";
}

export function DnsView() {
  const { t } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const records = useInfraStore((state) => state.dns);
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const rows = records.filter((record) => {
    const node = nodes.find((item) => item.id === record.nodeId);
    if (q && !`${record.domain} ${node?.name ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (status !== "all" && node?.dnsStatus !== status) return false;
    return true;
  });
  const headers = ["A", "AAAA", "CNAME", "Authoritative", "Resolver", "TTL"];
  if (monitor) {
    return (
      <div>
        <PageHeader title={t("dns.title")} description={t("dns.monitorDescription")} />
        <ManagedDomains />
      </div>
    );
  }
  return (
    <div>
      <PageHeader title={t("dns.title")} description={t("dns.demoDescription")} />
      <DemoNote>{t("dns.demoNote")}</DemoNote>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t("dns.search")} />
        <Select aria-label={t("dns.status")} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">{t("dns.allStatuses")}</option>
          {statuses.map((item) => <option key={item} value={item}>{t(`common.status.${item}`)}</option>)}
        </Select>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/70 text-muted-foreground"><tr>{[t("dns.columns.domain"), t("dns.columns.panelHost"), t("dns.columns.panelIp"), ...headers.slice(0, 3), t("dns.columns.activeIp"), t("dns.columns.backupIp"), ...headers.slice(3), t("dns.columns.lastCheck"), t("dns.columns.alert")].map((title) => <th key={title} className="px-3 py-3 text-start">{title}</th>)}</tr></thead>
          <tbody>
            {rows.map((record) => {
              const node = nodes.find((item) => item.id === record.nodeId);
              const active = servers.find((server) => server.id === (node?.activeSide === "backup" ? node.backupServerId : node?.primaryServerId));
              const backup = servers.find((server) => server.id === node?.backupServerId);
              return (
                <tr key={record.id} className="border-t border-border">
                  <td className="px-3 py-3"><Link className="text-primary" href={`/dns/${record.nodeId}`}><Tech>{record.domain}</Tech></Link></td>
                  <td className="px-3 py-3"><Tech>{record.v2boardHost}</Tech></td>
                  <td className="px-3 py-3"><Tech>{record.v2boardIp ?? "—"}</Tech></td>
                  <td className="px-3 py-3"><Tech>{record.aRecords.join(" ") || "—"}</Tech></td>
                  <td className="px-3 py-3"><Tech>{record.aaaaRecords.join(" ") || "—"}</Tech></td>
                  <td className="px-3 py-3"><Tech>{record.cname ?? "—"}</Tech></td>
                  <td className="px-3 py-3"><Tech>{active?.publicIpv4}</Tech></td>
                  <td className="px-3 py-3"><Tech>{backup?.publicIpv4}</Tech></td>
                  <td className="px-3 py-3">{record.resolverOnly ? t("dns.unknown") : <StatusBadge value={record.authoritativeStatus} />}</td>
                  <td className="px-3 py-3"><StatusBadge value={record.resolverStatus} /></td>
                  <td className="px-3 py-3"><Tech>{recordTtl(record, t("dns.auto"))}</Tech></td>
                  <td className="px-3 py-3">{record.lastCheck ? format.formatDateTime(record.lastCheck) : "—"}</td>
                  <td className="px-3 py-3">{node?.dnsStatus === "matched" ? "—" : t("dns.needsReview")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DnsDetailView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const params = useParams<{ nodeId: string }>();
  const router = useRouter();
  const user = useCurrentUser();
  const monitor = useBackend((state) => state.mode === "monitor");
  const record = useInfraStore((state) => state.dns.find((item) => item.nodeId === params.nodeId));
  const node = useInfraStore((state) => state.nodes.find((item) => item.id === params.nodeId));
  const servers = useInfraStore((state) => state.servers);
  const checkDns = useInfraAction("checkDns");
  const dnsRead = useInfraStore((state) => state.integrations.some((item) => item.type === "cloudflare" && item.config.readEnabled === "true"));
  const simulateDnsSwitch = useInfraAction("simulateDnsSwitch");
  const [preview, setPreview] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (monitor) router.replace("/dns");
  }, [monitor, router]);
  if (monitor) return null;
  if (!record || !node) return <PageHeader title={t("dns.notFound")} />;
  const active = servers.find((server) => server.id === (node.activeSide === "backup" ? node.backupServerId : node.primaryServerId));
  const primary = servers.find((server) => server.id === node.primaryServerId);
  const backup = servers.find((server) => server.id === node.backupServerId);
  const mismatch = record.authoritativeStatus === "mismatched";
  const resolver = record.resolverObservation;
  const recordTitle = monitor
    ? record.provider === "arvan" ? t("dns.arvanRecord") : record.provider === "cloudflare" ? t("dns.cloudflareRecord") : t("dns.dnsRecord")
    : t("dns.sampleRecord");
  async function observeDns() {
    setRefreshing(true);
    try {
      const error = await refreshProvider(`dns/${encodeURIComponent(params.nodeId)}`);
      if (error) toast.error(copy(error));
      else toast.success(dnsRead ? t("dns.checkedWithProvider") : t("dns.checkedPublic"));
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="space-y-4">
      <PageHeader title={record.domain} description={monitor ? t("dns.monitorDetail") : t("dns.demoDetail")} actions={<StatusBadge value={node.dnsStatus} />} />
      {!monitor && <DemoNote>{t("dns.demoTtl", { ttl: record.ttl })}</DemoNote>}
      <Card>
        <CardHeader><CardTitle>{t("dns.expected")}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm leading-7">
          <p>{copy(record.note)}</p>
          {record.stale && <p className="text-muted-foreground">{t("dns.stale")}</p>}
          <p>{t("dns.v2boardHost")} <Tech>{record.v2boardHost}</Tech></p>
          {monitor && record.v2boardMissing && <p className="text-destructive">{t("dns.v2boardMissing")}</p>}
          {monitor && record.v2boardObservedAt && <p className="text-muted-foreground">{t("dns.v2boardChecked", { time: format.formatDateTime(record.v2boardObservedAt) })}</p>}
          <p>{t("dns.panelIp")} <Tech>{record.v2boardIp ?? "—"}</Tech></p>
          <p>{t("dns.activeServerIp")} <Tech>{[active?.publicIpv4, active?.publicIpv6].filter(Boolean).join(", ") || "—"}</Tech> {active?.name}</p>
          <p>{t("dns.backupServerIp")} <Tech>{[backup?.publicIpv4, backup?.publicIpv6].filter(Boolean).join(", ") || "—"}</Tech> {backup?.name}</p>
          {!monitor && mismatch && <p>{t("dns.reviewChange")}</p>}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{recordTitle} {record.resolverOnly ? t("dns.unknown") : <StatusBadge value={record.authoritativeStatus} />}</CardTitle></CardHeader>
          <CardContent className="space-y-2 break-all text-sm">
            <p>A <Tech>{record.aRecords.join(", ") || "—"}</Tech></p>
            <p>AAAA <Tech>{record.aaaaRecords.join(", ") || "—"}</Tech></p>
            <p>CNAME <Tech>{record.cname || "—"}</Tech></p>
            <p>TTL <Tech>{recordTtl(record, t("dns.auto"))}</Tech></p>
            {record.lastCheck && <p>{format.formatDateTime(record.lastCheck)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("dns.resolver")} <StatusBadge value={record.resolverStatus} /></CardTitle></CardHeader>
          <CardContent className="space-y-2 break-all text-sm">
            {resolver ? <>
              <p>A <Tech>{resolver.aRecords.join(", ") || "—"}</Tech></p>
              <p>AAAA <Tech>{resolver.aaaaRecords.join(", ") || "—"}</Tech></p>
              <p>CNAME <Tech>{resolver.cnameRecords.join(", ") || "—"}</Tech></p>
              <p>{t("dns.answerTtl")} <Tech>{resolver.ttl === undefined ? "—" : `${resolver.ttl} s`}</Tech></p>
              <p>{format.formatDateTime(resolver.checkedAt)}</p>
              {!resolver.complete && <p className="text-muted-foreground">{t("dns.partialQueries")}</p>}
            </> : <p className="text-muted-foreground">{monitor ? t("dns.noResolverYet") : t("dns.resolverSimulated")}</p>}
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {monitor ? <>
          <Button disabled={refreshing || !can(user.role, "dns.check")} onClick={() => void observeDns()}>
            {refreshing ? t("dns.checking") : dnsRead ? t("dns.checkProvider") : t("dns.checkPublic")}
          </Button>
          {!dnsRead && <Link className="text-sm text-primary" href="/settings?tab=integrations">{t("dns.configure")}</Link>}
          <Link className="text-sm text-primary" href={`/failover?node=${node.id}`}>{t("dns.failoverConsole")}</Link>
        </> : <>
          <Button disabled={!can(user.role, "dns.check")} onClick={() => void checkDns(node.id).then((error) => error ? toast.error(copy(error)) : toast.success(t("dns.checkSimulated")))}>{t("dns.checkDemo")}</Button>
          <Button variant="outline" onClick={() => setPreview(true)}>{t("dns.previewChange")}</Button>
          <Button disabled={!can(user.role, "dns.switch")} onClick={async () => { const error = await simulateDnsSwitch(node.id, node.activeSide === "primary" ? "backup" : "primary"); if (error) toast.error(copy(error)); else toast.success(t("dns.switchSimulated")); }}>{t("dns.switchDemo")}</Button>
        </>}
      </div>
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent title={t("dns.previewTitle")}>
          <pre className="tech whitespace-pre-wrap text-xs">{`${record.domain}. ${record.ttl} IN A ${node.activeSide === "primary" ? backup?.publicIpv4 : primary?.publicIpv4}\n; ${t("dns.previewComment")}`}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
