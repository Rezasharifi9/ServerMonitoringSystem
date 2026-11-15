"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select, Textarea } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { arvanTtls, dnsProviderNames, editableDnsTypes, proxyDnsTypes, type DnsProvider, type EditableDnsType, type ManagedDnsRecord, type ManagedDnsZone } from "@/lib/managed-dns";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { listManagedDnsRecords, listManagedDomains, saveManagedDnsRecord, syncManagedDomains } from "@/services/backend";
import { useCurrentUser } from "@/stores/infra-store";

export function ManagedDomains() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const client = useQueryClient();
  const key = ["managed-domains", user.id];
  const query = useQuery({ queryKey: key, queryFn: listManagedDomains, enabled: can(user.role, "dns.check"), retry: false });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const providers = query.data ?? [];
  const zones = providers.flatMap((provider) => provider.zones ?? []);
  const identifier = (zone: ManagedDnsZone) => `${zone.provider}:${zone.id}`;
  const zone = zones.find((zone) => identifier(zone) === selected);
  const providerLabel = (provider: DnsProvider) => provider === "arvan" ? t("dns.provider.arvan") : dnsProviderNames[provider];
  const visible = zones.filter(({ name, provider }) => `${name} ${dnsProviderNames[provider]} ${providerLabel(provider)}`.toLowerCase().includes(search.trim().toLowerCase()));
  const sync = useMutation({ mutationFn: syncManagedDomains, onSuccess: (result) => {
    client.setQueryData(key, result.providers);
    if (!Object.keys(result.errors).length) toast.success(t("dns.domains.synced"));
  }, onError: (error) => toast.error(copy(error.message)) });

  if (!can(user.role, "dns.check")) return null;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        {providers.map(({ provider, connected, syncedAt }) => <div key={provider} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <p className="font-medium">{providerLabel(provider)}</p>
          <p className="text-muted-foreground">{connected ? syncedAt ? t("dns.domains.lastSync", { time: format.formatDateTime(syncedAt) }) : t("dns.domains.waitingSync") : t("dns.domains.waitingApi")}</p>
          {sync.data?.errors[provider] && <p className="text-destructive">{copy(sync.data.errors[provider])}</p>}
        </div>)}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/settings?tab=integrations" className="text-sm text-primary">{t("dns.domains.configureKeys")}</Link>
        <Button type="button" variant="outline" disabled={sync.isPending || !providers.some((item) => item.connected)} onClick={() => sync.mutate()}>
          {sync.isPending ? t("dns.domains.syncing") : t("dns.domains.sync")}
        </Button>
      </div>
    </div>
    {query.isPending && <p className="text-sm">{t("dns.domains.loading")}</p>}
    {query.isError && <p role="alert" className="text-sm text-destructive">{copy(query.error.message)}</p>}
    {zones.length > 0 ? <div className="grid items-start gap-4 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
      <Card>
        <CardHeader><CardTitle>{t("dns.domains.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Input aria-label={t("dns.domains.searchDomain")} placeholder={t("dns.domains.searchDomain")} value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="max-h-[32rem] space-y-1 overflow-auto">{visible.map((item) => <Button key={identifier(item)} type="button"
            variant={selected === identifier(item) ? "default" : "ghost"} className="w-full justify-between gap-2" onClick={() => setSelected(identifier(item))}>
            <bdi className="truncate">{item.name}</bdi><span className="shrink-0 text-xs">{providerLabel(item.provider)}</span>
          </Button>)}{!visible.length && <p className="text-sm text-muted-foreground">{t("dns.domains.none")}</p>}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-5">
          {zone ? <ZoneRecords key={identifier(zone)} zone={zone} writable={can(user.role, "dns.switch")} /> : <p className="text-sm text-muted-foreground">{t("dns.domains.choose")}</p>}
        </CardContent>
      </Card>
    </div> : !query.isPending && <p className="text-sm text-muted-foreground">{t("dns.domains.choose")}</p>}
  </div>;
}

function ZoneRecords({ zone, writable }: { zone: ManagedDnsZone; writable: boolean }) {
  const { t, copy } = useI18n();
  const user = useCurrentUser();
  const query = useQuery({ queryKey: ["managed-dns-records", user.id, zone.provider, zone.id], queryFn: () => listManagedDnsRecords(zone), retry: false });
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<ManagedDnsRecord | null>();
  const records = query.data?.filter((record) => `${record.type} ${record.name} ${record.content}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium"><bdi>{zone.name}</bdi></h3>
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("dns.domains.refresh")}</Button>
        {writable && <Button type="button" onClick={() => setEdit(null)}>{t("dns.domains.add")}</Button>}
      </div>
    </div>
    {query.isPending && <p>{t("dns.domains.loadingRecords")}</p>}
    {query.isError && <p role="alert" className="text-destructive">{copy(query.error.message)}</p>}
    {query.data && <>
      <Input aria-label={t("dns.domains.searchRecord")} placeholder={t("dns.domains.searchRecordPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/70 text-muted-foreground"><tr>{[t("dns.domains.type"), t("dns.domains.name"), t("dns.domains.value"), "TTL", t("dns.domains.proxy"), t("dns.domains.actions")].map((label) => <th key={label} className="px-3 py-3 text-start font-medium">{label}</th>)}</tr></thead>
          <tbody>{records.map((record) => <tr key={record.id} className="border-t border-border">
            <td className="px-3 py-3 font-medium">{record.type}</td>
            <td className="px-3 py-3"><bdi>{record.name}</bdi></td>
            <td className="max-w-[360px] whitespace-pre-line break-all px-3 py-3" dir="ltr">{record.priority !== undefined && `${record.priority} · `}{record.content}</td>
            <td className="px-3 py-3">{record.ttl === 1 ? t("dns.auto") : record.ttl}</td>
            <td className="px-3 py-3">{proxyDnsTypes.includes(record.type) ? record.proxied ? t("dns.domains.on") : t("dns.domains.off") : "—"}</td>
            <td className="px-3 py-3">{writable && record.editable && <Button variant="outline" size="sm" onClick={() => setEdit(record)}>{t("dns.domains.edit")}</Button>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!records.length && <p className="text-muted-foreground">{t("dns.domains.noRecords")}</p>}
    </>}
    <Dialog open={edit !== undefined} onOpenChange={(open) => { if (!open) setEdit(undefined); }}>
      {edit !== undefined && <DialogContent title={edit ? t("dns.domains.editTitle") : t("dns.domains.addTitle")}>
        <RecordEditor zone={zone} record={edit} onSaved={() => { setEdit(undefined); void query.refetch(); }} />
      </DialogContent>}
    </Dialog>
  </div>;
}

function RecordEditor({ zone, record, onSaved }: { zone: ManagedDnsZone; record: ManagedDnsRecord | null; onSaved: () => void }) {
  const { t, copy } = useI18n();
  const [type, setType] = useState<EditableDnsType>(record?.type as EditableDnsType ?? "A");
  const [proxied, setProxied] = useState(record?.proxied ?? false);
  const [error, setError] = useState("");
  const save = useMutation({ mutationFn: (input: Parameters<typeof saveManagedDnsRecord>[1]) => saveManagedDnsRecord(zone, input),
    onSuccess: () => { toast.success(t("dns.domains.saved")); onSaved(); }, onError: (cause) => setError(cause.message) });
  const proxy = proxyDnsTypes.includes(type) && proxied;
  const autoTtl = zone.provider === "cloudflare" && proxy;
  const providerLabel = zone.provider === "arvan" ? t("dns.provider.arvan") : dnsProviderNames[zone.provider];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError("");
    save.mutate({ type, id: record?.id, revision: record?.revision, proxied: proxy,
      name: String(data.get("name") ?? ""), content: String(data.get("content") ?? ""),
      ttl: autoTtl ? 1 : Number(data.get("ttl")), priority: type === "MX" ? Number(data.get("priority")) : undefined });
  }

  return <form onSubmit={submit} className="space-y-3 text-sm">
    <p><bdi>{zone.name}</bdi> · {providerLabel}</p>
    <fieldset disabled={save.isPending} className="grid gap-3 sm:grid-cols-2">
      <label>{t("dns.domains.type")}<Select value={type} disabled={Boolean(record)} onChange={(event) => { setType(event.target.value as EditableDnsType); setProxied(false); }}>
        {editableDnsTypes.map((item) => <option key={item}>{item}</option>)}
      </Select></label>
      <label>{t("dns.domains.name")}<Input name="name" dir="ltr" defaultValue={record?.name ?? "@"} required maxLength={253} /></label>
      <label className="sm:col-span-2">{t("dns.domains.value")}<Textarea key={type} name="content" dir="ltr" defaultValue={record?.content} required maxLength={4096}
        placeholder={type === "A" ? "192.0.2.10" : type === "AAAA" ? "2001:db8::10" : type === "TXT" ? t("dns.domains.txtPlaceholder") : "target.example.com"} /></label>
      {type === "MX" && <label>{t("dns.domains.priority")}<Input name="priority" type="number" min={0} max={zone.provider === "arvan" ? 9999 : 65535} defaultValue={record?.priority ?? 10} required /></label>}
      {zone.provider === "arvan" ? <label>{t("dns.domains.ttlSeconds")}<Select name="ttl" defaultValue={record?.ttl ?? 300}>
        {arvanTtls.map((item) => <option key={item}>{item}</option>)}
      </Select></label> : <label>{t("dns.domains.ttlAuto")}<Input name="ttl" type="number" min={1} max={86400} defaultValue={record?.ttl ?? 1} disabled={autoTtl} required /></label>}
      {proxyDnsTypes.includes(type) && <label className="flex items-center gap-2"><input type="checkbox" checked={proxied} onChange={(event) => setProxied(event.target.checked)} /> {t("dns.domains.enableProxy")}</label>}
    </fieldset>
    {error && <p role="alert" className="text-destructive">{copy(error)}</p>}
    <Button type="submit" disabled={save.isPending}>{save.isPending ? t("dns.domains.saving") : t("dns.domains.save")}</Button>
  </form>;
}
