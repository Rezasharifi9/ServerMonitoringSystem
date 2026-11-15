"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { asciiDigits } from "@/lib/server-inventory";
import { BackendError, sshHostConfirmation, sshRegisterAndInstallAgent, syncBackend } from "@/services/backend";

export function AgentSshInstallForm({ enabled, address, username = "root", port = 22, onDone }: {
  enabled: boolean; address?: string; username?: string; port?: number; onDone?: (reporting: boolean) => void;
}) {
  const { t, copy } = useI18n();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  const [hostKey, setHostKey] = useState<{ fingerprint: string; ip: string; port: number }>();

  async function install(form: HTMLFormElement, confirmHost = false) {
    if (!enabled || pending || !form.reportValidity()) return;
    const fields = new FormData(form);
    const publicIpv4 = asciiDigits(address ?? String(fields.get("ip") ?? "").trim());
    const sshPort = Number(asciiDigits(String(fields.get("port") ?? "")));
    const fingerprint = confirmHost && hostKey?.ip === publicIpv4 && hostKey.port === sshPort ? hostKey.fingerprint : undefined;
    setPending(true);
    setResult("");
    try {
      const installed = await sshRegisterAndInstallAgent({ publicIpv4, sshPort, fingerprint,
        sshUsername: String(fields.get("username") ?? "").trim(), password: String(fields.get("password") ?? "") });
      form.reset();
      setHostKey(undefined);
      await syncBackend();
      setResult(installed.reporting ? t("nodes.ssh.reporting") : t("nodes.ssh.installed"));
      onDone?.(installed.reporting);
    } catch (error) {
      const observed = sshHostConfirmation(error);
      if (observed) setHostKey({ fingerprint: observed, ip: publicIpv4, port: sshPort });
      else {
        if (error instanceof BackendError && error.code === "SSH_HOST_KEY") setHostKey(undefined);
        setResult(error instanceof Error ? copy(error.message) : t("nodes.ssh.failed"));
      }
    } finally { setPending(false); }
  }

  return <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void install(event.currentTarget); }}>
    {!enabled && <p className="text-muted-foreground">{t("nodes.ssh.disabled")}</p>}
    <fieldset disabled={pending || !enabled} className="grid gap-3 sm:grid-cols-2">
      <label>{t("nodes.ssh.ipv4")}<Input name="ip" dir="ltr" className="tech" required defaultValue={address} readOnly={Boolean(address)} maxLength={15}
        onChange={() => setHostKey(undefined)} /></label>
      <label>{t("nodes.ssh.port")}<Input name="port" dir="ltr" className="tech" inputMode="numeric" pattern="[0-9۰-۹٠-٩]{1,5}" required defaultValue={port}
        onChange={() => setHostKey(undefined)} /></label>
      <label>{t("nodes.ssh.username")}<Input name="username" dir="ltr" className="tech" defaultValue={username} required maxLength={128} /></label>
      <label>{t("nodes.ssh.password")}<Input name="password" dir="ltr" type="password" autoComplete="new-password" required maxLength={1024} /></label>
    </fieldset>
    {hostKey && <div className="rounded-lg border border-border p-3" role="status">
      <p>{t("nodes.ssh.fingerprint")}</p>
      <code dir="ltr" className="tech block break-all">{hostKey.fingerprint}</code>
    </div>}
    {hostKey ? <Button type="button" disabled={pending || !enabled} onClick={(event) => {
      if (event.currentTarget.form) void install(event.currentTarget.form, true);
    }}>{pending ? t("nodes.ssh.installing") : t("nodes.ssh.confirmInstall")}</Button> :
      <Button type="submit" disabled={pending || !enabled}>{pending ? t("nodes.ssh.connecting") : t("nodes.ssh.install")}</Button>}
    {result && <p role="status">{result}</p>}
  </form>;
}
