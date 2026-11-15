"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui/kit";
import { ConfirmButton } from "@/components/shared/chrome";
import { useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { useCurrentUser } from "@/stores/infra-store";
import { getVirtualizorSettings, saveVirtualizorSettings, getServerVirtualizor, bindServerVirtualizor, unbindServerVirtualizor, controlServerVirtualizor, useBackend } from "@/services/backend";

export function VirtualizorSettings() {
  const { t, copy } = useI18n(); const client = useQueryClient();
  const query = useQuery({ queryKey: ["virtualizor-settings"], queryFn: getVirtualizorSettings, retry: false });
  const save = useMutation({ mutationFn: saveVirtualizorSettings, onSuccess: (data) => { client.setQueryData(["virtualizor-settings"], data); void client.invalidateQueries({ queryKey: ["virtualizor-server"] }); toast.success(t("settings.virtualizor.saved")); }, onError: (e) => toast.error(copy(e.message)) });
  return <Card><CardHeader><CardTitle>Virtualizor</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">{t("settings.virtualizor.help")}</p>
    {query.isPending && <p>{t("settings.virtualizor.loading")}</p>}
    {query.isError && <p role="alert">{copy(query.error.message)}</p>}
    {query.data && <><p>{t(query.data.configured ? "settings.virtualizor.configured" : "settings.virtualizor.notConfigured")}</p>
      {!query.data.storageEnabled && <p role="alert">{t("settings.virtualizor.storage")}</p>}
      <form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => {
        event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
        save.mutate({ endpoint: String(values.get("endpoint")), apiKey: String(values.get("apiKey")), apiPassword: String(values.get("apiPassword")) }, { onSuccess: () => { (form.elements.namedItem("apiKey") as HTMLInputElement).value = ""; (form.elements.namedItem("apiPassword") as HTMLInputElement).value = ""; } });
      }}>
        <label>{t("settings.virtualizor.endpoint")}<Input name="endpoint" type="url" dir="ltr" placeholder="https://panel.example.com:4083" defaultValue={query.data.endpoint} required /></label>
        <label>API Key<Input name="apiKey" type="password" dir="ltr" autoComplete="new-password" required maxLength={256} /></label>
        <label>API Password<Input name="apiPassword" type="password" dir="ltr" autoComplete="new-password" required maxLength={512} /></label>
        <Button type="submit" disabled={save.isPending || !query.data.storageEnabled}>{t("settings.virtualizor.save")}</Button>
      </form></>}
  </CardContent></Card>;
}
export function ServerVirtualizor({ serverId }: { serverId: string }) {
  const { t, copy } = useI18n(); const user = useCurrentUser(); const client = useQueryClient(); const monitor = useBackend((s) => s.mode === "monitor");
  const key = ["virtualizor-server", serverId];
  const query = useQuery({ queryKey: key, queryFn: () => getServerVirtualizor(serverId), enabled: monitor, retry: false });
  const bind = useMutation({ mutationFn: (id: string) => bindServerVirtualizor(serverId, id), onSuccess: (data) => client.setQueryData(key, data), onError: (e) => toast.error(copy(e.message)) });
  const unbind = useMutation({ mutationFn: () => unbindServerVirtualizor(serverId), onSuccess: (data) => client.setQueryData(key, data), onError: (e) => toast.error(copy(e.message)) });
  const action = useMutation({ mutationFn: (action: string) => controlServerVirtualizor(serverId, action), onSuccess: () => { toast.success(t("settings.virtualizor.accepted")); void client.invalidateQueries({ queryKey: key }); }, onError: (e) => { toast.error(copy(e.message)); void client.invalidateQueries({ queryKey: key }); } });
  if (!monitor) return <p>{t("settings.virtualizor.liveOnly")}</p>;
  const busy = bind.isPending || unbind.isPending || action.isPending;
  const info = query.data?.info;
  return <Card><CardHeader><CardTitle>Virtualizor</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("settings.virtualizor.bindingHelp")}</p>
    {query.isPending && <p>{t("settings.virtualizor.loading")}</p>}
    {query.isError && <p role="alert" className="text-destructive">{copy(query.error.message)}</p>}
    {query.data && !query.data.configured && <p>{t("settings.virtualizor.notConfigured")}</p>}
    {can(user.role, "server.configure") && <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); bind.mutate(String(new FormData(e.currentTarget).get("vpsId"))); }}>
      <label>{t("settings.virtualizor.vpsId")}<Input key={query.data?.vpsId} name="vpsId" dir="ltr" inputMode="numeric" pattern="[1-9][0-9]{0,9}" defaultValue={query.data?.vpsId} required /></label>
      <Button type="submit" disabled={busy || query.data?.configured === false}>{t("settings.virtualizor.bind")}</Button>
      {query.data?.vpsId && <Button type="button" variant="outline" disabled={busy} onClick={() => unbind.mutate()}>{t("settings.virtualizor.unbind")}</Button>}
    </form>}
    <Button variant="outline" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>{t("settings.virtualizor.refresh")}</Button>
    {info && <><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(info).map(([name, value]) => <div className="rounded-lg border p-3" key={name}><dt className="text-sm text-muted-foreground">{t(`settings.virtualizor.fields.${name}`)}</dt><dd className="tech" dir="ltr">{name === "status" ? t(`settings.virtualizor.${value}`) : value ?? "—"}</dd></div>)}</dl>
      <div className="flex flex-wrap gap-2">{["start", "stop", "restart", "poweroff"].map((name) => <ConfirmButton key={name} label={t(`settings.virtualizor.${name}`)} title={t(`settings.virtualizor.${name}`)} confirmLabel={t(`settings.virtualizor.${name}`)} description={t("settings.virtualizor.confirm", { id: info.vpsId })} destructive={name === "poweroff"} disabled={busy || query.isFetching || query.isError || !can(user.role, "server.restart")} onConfirm={() => action.mutate(name)} />)}</div></>}
  </CardContent></Card>;
}
