"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select, Textarea } from "@/components/ui/kit";
import { ConfirmButton } from "@/components/shared/chrome";
import { useI18n } from "@/i18n/provider";
import { getSshSettings, removeSshSettings, saveSshSettings, sshInstallAgent, syncBackend, testSshConnection } from "@/services/backend";
import { AgentSshInstallForm } from "./agent-ssh-install-form";

export function ServerSshPanel({ serverId, addresses, canInstall, agentInstalled, username = "root", port = 22 }: {
  serverId: string; addresses: string[]; canInstall: boolean; agentInstalled: boolean; username?: string; port?: number;
}) {
  const { t, copy } = useI18n();
  const [method, setMethod] = useState<"password" | "key">("password");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  const settings = useQuery({ queryKey: ["server-ssh", serverId], queryFn: () => getSshSettings(serverId) });
  const saved = settings.data?.connection;
  const [installedHere, setInstalledHere] = useState(false);
  const reinstall = agentInstalled || installedHere;
  const installLabel = reinstall ? t("servers.ssh.reinstall") : t("servers.ssh.install");

  async function installAgent() {
    setPending(true);
    setResult("");
    try {
      const result = await sshInstallAgent(serverId);
      setInstalledHere(result.installed);
      await syncBackend();
      setResult(result.reporting ? t("servers.ssh.verifiedReport") : t("servers.ssh.waitingReport"));
    } catch (error) {
      setResult(error instanceof Error ? error.message : t("servers.ssh.installFailed"));
    } finally { setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    for (const name of ["password", "privateKey", "passphrase"]) {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
      if (field) field.value = "";
    }
    const field = (name: string) => String(fields.get(name) ?? "");
    const common = { ip: field("ip"), username: field("username"), port: Number(field("port")), fingerprint: field("fingerprint") };
    setPending(true);
    setResult("");
    try {
      const input = method === "password" ? { ...common, method, password: field("password") } as const :
        { ...common, method, privateKey: field("privateKey"), passphrase: field("passphrase") || undefined } as const;
      if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "save") {
        await saveSshSettings(serverId, input);
        await settings.refetch();
        setResult(t("servers.ssh.savedConnection"));
      } else {
        await testSshConnection(serverId, input);
        setResult(t("servers.ssh.testedConnection"));
      }
      toast.success(t("servers.ssh.connected"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("servers.ssh.testFailed");
      setResult(message);
      toast.error(copy(message));
    } finally {
      setPending(false);
    }
  }

  return <Card>
    <CardHeader><CardTitle>{t("servers.ssh.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      {saved && <p>{t("servers.ssh.savedPrefix")}<span dir="ltr">{saved.username}@{saved.ip}:{saved.port}</span>{t("servers.ssh.savedSuffix")}</p>}
      {settings.isError && <p className="text-destructive">{copy(settings.error.message)}</p>}
      {canInstall && settings.isSuccess && (saved ? <ConfirmButton
        label={pending ? t("servers.ssh.installing") : installLabel} title={installLabel} confirmLabel={installLabel}
        description={reinstall ? t("servers.ssh.reinstallDescription") : t("servers.ssh.installDescription")}
        disabled={!settings.data.installEnabled || pending} onConfirm={installAgent} /> :
        <AgentSshInstallForm enabled={settings.data.installEnabled} address={addresses[0]} username={username} port={port}
          onDone={(reporting) => {
            setInstalledHere(true);
            setResult(reporting ? t("servers.ssh.installedReporting") : t("servers.ssh.installedWaiting"));
            void settings.refetch();
          }} />)}
      <details className="space-y-3">
        <summary className="cursor-pointer">{t("servers.ssh.settings")}</summary>
      <p className="text-muted-foreground">{t("servers.ssh.fingerprintHint")}</p>
      <form onSubmit={submit} key={saved ? JSON.stringify(saved) : `${username}:${port}`}>
        <fieldset className="grid gap-2 md:grid-cols-3" disabled={pending}>
          <label>{t("servers.ssh.serverIp")}<Select name="ip" dir="ltr" defaultValue={saved?.ip}>{addresses.map((ip) => <option key={ip} value={ip}>{ip}</option>)}</Select></label>
          <label>{t("servers.ssh.username")}<Input name="username" dir="ltr" defaultValue={saved?.username ?? username} required /></label>
          <label>{t("servers.ssh.port")}<Input name="port" dir="ltr" type="number" min={1} max={65535} defaultValue={saved?.port ?? port} required /></label>
          <label>{t("servers.ssh.fingerprint")}<Input name="fingerprint" dir="ltr" placeholder={t("servers.ssh.fingerprintPlaceholder")} defaultValue={saved?.fingerprint} required /></label>
          <label>{t("servers.ssh.authMethod")}<Select value={method} onChange={(event) => setMethod(event.target.value === "key" ? "key" : "password")}>
            <option value="password">{t("servers.ssh.password")}</option><option value="key">{t("servers.ssh.privateKey")}</option>
          </Select></label>
          {method === "password" ? <label>{t("servers.ssh.sshPassword")}<Input name="password" dir="ltr" type="password" autoComplete="off" required /></label> :
            <>
              <label>{t("servers.ssh.passphrase")}<Input name="passphrase" dir="ltr" type="password" autoComplete="off" /></label>
              <label className="md:col-span-3">{t("servers.ssh.privateKey")}<Textarea name="privateKey" dir="ltr" autoComplete="off" spellCheck={false} required /></label>
            </>}
          <div className="flex flex-wrap gap-2 md:col-span-3">
            <Button type="submit" variant="outline">{pending ? t("servers.ssh.checking") : t("servers.ssh.test")}</Button>
            <Button type="submit" value="save" disabled={!settings.data?.available}>{t("servers.ssh.save")}</Button>
          </div>
        </fieldset>
      </form>
      {saved && <div>
        <ConfirmButton label={t("servers.ssh.remove")} title={t("servers.ssh.removeTitle")} confirmLabel={t("servers.ssh.removeConfirm")}
          description={t("servers.ssh.removeDescription")} destructive disabled={pending}
          onConfirm={async () => {
            try { await removeSshSettings(serverId); await settings.refetch(); setResult(""); }
            catch (error) { toast.error(error instanceof Error ? copy(error.message) : t("servers.ssh.removeFailed")); }
          }} />
      </div>}
      </details>
      {result && <p role="status">{copy(result)}</p>}
    </CardContent>
  </Card>;
}
