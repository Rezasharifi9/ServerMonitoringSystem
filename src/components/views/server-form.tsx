"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Input, Label, Select } from "@/components/ui/kit";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { useI18n } from "@/i18n/provider";
import { asciiDigits, LINUX_DISTRIBUTIONS } from "@/lib/server-inventory";
import { SERVER_ROLES } from "@/lib/topology";
import { BackendError, listV2BoardAdminNodes, getSshSettings, lookupServerAddress, registerInventory, revealServerSshPassword, sshHostConfirmation, syncBackend, updateInventoryServer } from "@/services/backend";
import type { Server } from "@/types";

export function ServerFormButton({ server, icon = false }: { server?: Server; icon?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = server ? t("servers.form.edit") : t("servers.form.add");
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
    <DialogTrigger asChild><Button variant="outline" size={icon ? "icon" : server ? "sm" : "default"}
      aria-label={icon ? title : undefined} title={icon ? title : undefined}>{icon ? <Pencil /> : title}</Button></DialogTrigger>
    {open && <DialogContent title={title}>
      <ServerForm server={server} busy={busy} setBusy={setBusy} close={() => setOpen(false)} />
    </DialogContent>}
  </Dialog>;
}

function ServerForm({ server, busy, setBusy, close }: {
  server?: Server; busy: boolean; setBusy: (value: boolean) => void; close: () => void;
}) {
  const { t, copy } = useI18n();
  const router = useRouter();
  const cache = useQueryClient();
  const [roleSelection, setRoleSelection] = useState<{ key: string; value: string }>();
  const [nodeRefs, setNodeRefs] = useState(server?.panelNodeRefs ?? []);
  const [ipv4, setIpv4] = useState(server?.publicIpv4 ?? "");
  const [lookupIp, setLookupIp] = useState("");
  const [hostKey, setHostKey] = useState<{ fingerprint: string; ip: string; port: number }>();
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<"password" | "panel-key">("password");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState<string>();
  const address = asciiDigits(ipv4.trim());
  const lookup = useQuery({
    queryKey: ["server-address", lookupIp], queryFn: () => lookupServerAddress(lookupIp),
    enabled: Boolean(lookupIp && lookupIp === address && lookupIp !== server?.publicIpv4), retry: false, staleTime: 3600000,
  });
  const ssh = useQuery({
    queryKey: ["server-ssh", server?.id], queryFn: () => getSshSettings(server!.id), enabled: Boolean(server), retry: false,
  });
  const saved = ssh.data?.connection;
  const savedPassword = useQuery({
    queryKey: ["server-ssh-password", server?.id], queryFn: () => revealServerSshPassword(server!.id),
    enabled: Boolean(server && saved?.method === "password"), retry: false, gcTime: 0,
  });
  const passwordValue = passwordDraft ?? savedPassword.data ?? "";
  const savedIp = address === server?.publicIpv4;
  const metadata = savedIp ? server : lookupIp === address ? lookup.data : undefined;
  const roleKey = `${address}:${metadata?.countryCode ?? ""}`;
  const role = roleSelection?.key === roleKey ? roleSelection.value
    : server ? (server.roles.includes("foreign") ? "foreign" : "iran")
      : metadata?.countryCode && metadata.countryCode.toUpperCase() !== "IR" ? "foreign" : "iran";
  const catalog = useQuery({ queryKey: ["v2board-admin-nodes"], queryFn: listV2BoardAdminNodes, enabled: role === "foreign", retry: false });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await save(event.currentTarget);
  }

  async function save(form: HTMLFormElement, confirmHost = false) {
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    const read = (key: string) => String(fields.get(key) ?? "").trim();
    const sshPort = Number(asciiDigits(read("sshPort")));
    const fingerprint = confirmHost && hostKey?.ip === address && hostKey.port === sshPort ? hostKey.fingerprint : undefined;
    const payload = {
      publicIpv4: address, publicIpv6: read("publicIpv6") || undefined,
      panelNodeRefs: role === "foreign" ? nodeRefs : [], os: read("os"), roles: fields.getAll("roles"), sshUsername: read("sshUsername"), sshPort,
      password: auth === "password" && passwordDraft !== undefined && passwordDraft !== savedPassword.data ? passwordDraft || undefined : undefined,
      sshAuth: auth === "panel-key" ? auth : undefined, fingerprint,
    };
    if (!payload.roles.length) { setError(t("servers.form.roleRequired")); return; }
    setBusy(true);
    setError("");
    try {
      const item = server ? await updateInventoryServer(server.id, payload) : await registerInventory("servers", payload);
      await syncBackend();
      if (server) void cache.invalidateQueries({ queryKey: ["server-ssh", server.id] });
      close();
      toast.success(server ? t("servers.form.saved") : t("servers.form.created"));
      if (!server) router.push(`/servers/${encodeURIComponent(item.id)}`);
    } catch (cause) {
      const observed = sshHostConfirmation(cause);
      if (observed) {
        setHostKey({ fingerprint: observed, ip: address, port: sshPort });
      } else {
        if (cause instanceof BackendError && cause.code === "SSH_HOST_KEY") setHostKey(undefined);
        setError(cause instanceof Error ? cause.message : t("servers.form.saveFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  if (server && ssh.isPending) return <p className="text-sm text-muted-foreground">{t("servers.form.readingLogin")}</p>;
  if (server && ssh.isError) return <p role="alert" className="text-sm text-destructive">{copy(ssh.error.message)}</p>;
  const distribution = LINUX_DISTRIBUTIONS.find((item) => server?.os === item || server?.os.startsWith(`${item} `));
  return <form className="space-y-4" onSubmit={submit}>
    <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy}>
      <Label className="grid gap-1.5">{t("servers.form.publicIpv4")}<Input name="publicIpv4" dir="ltr" required maxLength={15}
        value={ipv4} onChange={(event) => { setIpv4(event.target.value); setHostKey(undefined); }} onBlur={() => setLookupIp(address)} /></Label>
      <Label className="grid gap-1.5">{t("servers.form.publicIpv6")}<Input name="publicIpv6" dir="ltr" maxLength={45} defaultValue={server?.publicIpv6} /></Label>
      <Label className="grid gap-1.5">{t("servers.form.provider")}<Input readOnly value={metadata?.provider ?? ""} placeholder={t("servers.form.detected")} dir="auto" /></Label>
      <Label className="grid gap-1.5">{t("servers.form.country")}<Input readOnly value={metadata?.countryCode ?? ""} placeholder={t("servers.form.detected")} dir="ltr" /></Label>
      {!savedIp && lookupIp === address && lookup.isFetching && <p className="text-xs text-muted-foreground sm:col-span-2">{t("servers.form.detecting")}</p>}
      {!savedIp && lookupIp === address && lookup.isError && <div className="flex items-center gap-2 sm:col-span-2">
        <p role="status" className="text-xs text-destructive">{copy(lookup.error.message)}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => void lookup.refetch()}>{t("common.retry")}</Button>
      </div>}
      <Label className="grid gap-1.5 sm:col-span-2">{t("servers.form.os")}<Select name="os" dir="ltr" required defaultValue={distribution ?? ""}>
        <option value="" disabled>{t("servers.form.chooseOs")}</option>
        {LINUX_DISTRIBUTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
      </Select></Label>
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="text-sm font-medium">{t("servers.form.roles")}</legend>
        <div className="flex flex-wrap gap-3">{SERVER_ROLES.map((roleValue) => <Label key={roleValue} className="flex items-center gap-1.5">
          <input type="radio" name="roles" value={roleValue} checked={role === roleValue} onChange={() => setRoleSelection({ key: roleKey, value: roleValue })} />
          {t(`servers.roles.${roleValue}`)}
        </Label>)}</div>
      </fieldset>
    </fieldset>
    {role === "foreign" && <fieldset disabled={busy} className="space-y-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{t("servers.form.connectedNodes")}</legend>
      {catalog.isPending && <p>{t("nodes.list.loadingAdmin")}</p>}
      {catalog.isError && <p role="alert">{copy(catalog.error.message)} <Button type="button" onClick={() => void catalog.refetch()}>{t("common.retry")}</Button></p>}
      <Select multiple aria-label={t("servers.form.connectedNodes")} value={nodeRefs}
        onChange={(event) => setNodeRefs(Array.from(event.target.selectedOptions, (option) => option.value))}>
        {(catalog.data?.nodes ?? []).filter((node) => !node.fields.parent_id).map((node) => {
          const ref = `${node.type}:${node.id}`;
          return <option key={ref} value={ref}>{String(node.fields.name || ref)} ({ref})</option>;
        })}
      </Select>
    </fieldset>}
    <fieldset disabled={busy} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
      <legend className="px-1 text-sm font-semibold">{t("servers.form.login")}</legend>
      <Label className="grid gap-1.5">{t("servers.form.username")}<Input name="sshUsername" dir="ltr" autoComplete="off" required maxLength={128}
        defaultValue={saved?.username ?? server?.sshUsername ?? "root"} /></Label>
      <Label className="grid gap-1.5">{t("servers.form.sshPort")}<Input name="sshPort" dir="ltr" inputMode="numeric" pattern="[0-9۰-۹٠-٩]{1,5}" required
        defaultValue={saved?.port ?? server?.sshPort ?? 22} onChange={() => setHostKey(undefined)} /></Label>
      <Label className="grid gap-1.5 sm:col-span-2">{t("servers.form.sshMethod")}
        <Select value={auth} onChange={(event) => {
          setAuth(event.target.value === "panel-key" ? "panel-key" : "password");
          setHostKey(undefined);
          setShowPassword(false);
        }}>
          <option value="password">{server ? t("servers.form.keepOrNewPassword") : t("servers.form.password")}</option>
          <option value="panel-key">{t("servers.form.panelKey")}</option>
        </Select>
      </Label>
      {auth === "panel-key" ? <p className="sm:col-span-2 text-sm">{t("servers.form.panelKeyHint")}</p> :
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="server-ssh-password">{t("servers.form.password")}</Label>
        <div className="flex items-center gap-2">
          <Input id="server-ssh-password" name="password" dir="ltr" type={showPassword ? "text" : "password"}
            autoComplete="new-password" maxLength={1024} value={passwordValue}
            disabled={Boolean(server && saved?.method === "password" && savedPassword.isPending)}
            onChange={(event) => { setPasswordDraft(event.target.value); setHostKey(undefined); }}
            placeholder={saved ? t("servers.form.keepPassword") : undefined} />
          <Button type="button" variant="outline" size="icon" aria-label={t(showPassword ? "servers.form.hidePassword" : "servers.form.showPassword")}
            onClick={() => setShowPassword((shown) => !shown)}>{showPassword ? <EyeOff /> : <Eye />}</Button>
        </div>
        {savedPassword.isError && <p role="alert" className="text-xs text-destructive">{copy(savedPassword.error.message)}</p>}
      </div>}
    </fieldset>
    {hostKey && <div role="status" className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <p>{t("servers.form.hostKeyHint")}</p>
      <code dir="ltr" className="block break-all">{hostKey.fingerprint}</code>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{copy(error)}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={close}>{t("common.cancel")}</Button>
      {hostKey ? <Button type="button" disabled={busy} onClick={(event) => {
        if (event.currentTarget.form) void save(event.currentTarget.form, true);
      }}>{busy ? t("servers.form.saving") : t("servers.form.confirmKey")}</Button> :
        <Button type="submit" disabled={busy}>{busy ? t("servers.form.saving") : t("common.save")}</Button>}
    </div>
  </form>;
}
