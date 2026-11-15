"use client";

import { useContext, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AdminMode } from "@/components/layout/session-mode";
import { toast } from "sonner";
import { DemoNote, PageHeader } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@/components/ui/kit";
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { telemetryIntervals, telemetryStreams } from "@/lib/telemetry-policy";
import { TelegramDeliverySettings } from "./telegram-delivery";
import { VirtualizorSettings } from "./virtualizor";
import { GmailSettings } from "./gmail-settings";
import { IntegrationsView } from "./integrations";
import { AdminPasskeySettings } from "./admin-passkey-settings";
import { AgentUpdateSettings } from "./agent-update-settings";
import { V2bxFilesEditor } from "./v2bx-files";
import { adminPasskeysQueryKey, updateAdminPassword, useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { AlertSeverity } from "@/types";

export function SettingsView({ initialTab = "general" }: { initialTab?: "general" | "integrations" | "failover" | "telegram" }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const adminMode = useContext(AdminMode);
  const settings = useInfraStore((state) => state.settings);
  const users = useInfraStore((state) => state.users);
  const audit = useInfraStore((state) => state.audit);
  const saveSettings = useInfraAction("updateSettings");
  const updateSettings = (...args: Parameters<typeof saveSettings>) => void saveSettings(...args).then((error) => { if (error) toast.error(copy(error)); });
  const backend = useBackend((state) => state.actor);
  const monitor = useBackend((state) => state.mode === "monitor");
  const testNotification = useInfraAction("testNotification");
  const resetDemo = useInfraStore((state) => state.resetDemo);
  const edit = can(user.role, "settings.edit");
  const security = can(user.role, "settings.security");
  const intervals = settings.telemetryIntervals ?? telemetryIntervals;

  return (
    <div>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      {!adminMode && <DemoNote>{t("settings.demoNote")}</DemoNote>}
      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="general">{t("settings.tabs.general")}</TabsTrigger>
          <TabsTrigger value="monitor">{t("settings.tabs.monitor")}</TabsTrigger>
          <TabsTrigger value="failover">{t("settings.tabs.failover")}</TabsTrigger>
          <TabsTrigger value="notify">{t("settings.tabs.notify")}</TabsTrigger>
          {monitor && <TabsTrigger value="telegram">{t("settings.tabs.telegram")}</TabsTrigger>}
          {!adminMode && <TabsTrigger value="access">{t("settings.tabs.access")}</TabsTrigger>}
          {adminMode && security && <TabsTrigger value="security">{t("settings.tabs.security")}</TabsTrigger>}
          <TabsTrigger value="audit">{t("settings.tabs.audit")}</TabsTrigger>
          <TabsTrigger value="retention">{t("settings.tabs.retention")}</TabsTrigger>
          <TabsTrigger value="integrations">{t("settings.tabs.integrations")}</TabsTrigger>
        </TabsList>
        <TabsContent value="integrations" className="mt-4 space-y-4">{monitor && edit && <VirtualizorSettings />}<IntegrationsView /></TabsContent>
        {adminMode && security && <TabsContent value="security" className="mt-4 space-y-4">
          <AdminPasskeySettings />
          <AdminPasswordForm />
        </TabsContent>}
        <TabsContent value="general" className="mt-4">
          {monitor && edit && <div className="mb-4"><AgentUpdateSettings /></div>}
          {monitor && edit && can(user.role, "server.configure") && can(user.role, "deploy.run") && can(user.role, "server.restart") && <div className="mb-4"><V2bxFilesEditor global /></div>}
          <Card><CardContent className="grid gap-3 pt-5">
            <Field label={t("settings.orgName")}><Input disabled={!edit} key={settings.orgName} defaultValue={settings.orgName} onBlur={(event) => { if (event.target.value !== String(settings.orgName)) updateSettings({ orgName: event.target.value }); }} /></Field>
            <p className="text-sm text-muted-foreground">{t("settings.themeHint")}</p>
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="monitor" className="mt-4">
          {monitor && <Card className="mb-4">
            <CardHeader><CardTitle>{t("settings.intervalsTitle")}</CardTitle></CardHeader>
            <CardContent><p className="mb-4 text-sm text-muted-foreground">{t("settings.historyPolicy")}</p><form key={JSON.stringify(intervals)} className="grid gap-3 md:grid-cols-2" onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const telemetryIntervals = Object.fromEntries(telemetryStreams.map((stream) => [stream, Number(values.get(stream))])) as typeof intervals;
              updateSettings({ telemetryIntervals });
            }}>
              {telemetryStreams.map((stream) => <Field key={stream} label={t(`settings.streams.${stream}`)}>
                <Input className="tech" disabled={!edit} name={stream} type="number" required min={5} max={86400} defaultValue={intervals[stream]} />
              </Field>)}
              <Button disabled={!edit} type="submit">{t("settings.saveIntervals")}</Button>
            </form></CardContent>
          </Card>}
        </TabsContent>
        <TabsContent value="failover" className="mt-4">
          <Card><CardContent className="pt-5">
            <form key={JSON.stringify(settings.failover)} className="grid gap-3 md:grid-cols-2" onSubmit={async (event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const error = await saveSettings({ failover: {
                ...settings.failover, trigger: "tunnel-loss", autoEnabled: values.has("enabled"),
                packetLossThreshold: Number(values.get("loss")), intervalSec: Number(values.get("minutes")) * 60,
                failureThreshold: 1, cooldownSec: 0, manualApproval: false, autoFailback: values.has("failback"),
                notifyTelegram: values.has("telegram"),
              } });
              if (error) toast.error(copy(error)); else toast.success(t("settings.failoverSaved"));
            }}>
              <label><input type="checkbox" name="enabled" disabled={!edit} defaultChecked={settings.failover.autoEnabled && settings.failover.trigger === "tunnel-loss"} /> {t("settings.autoDns")}</label>
              <label><input type="checkbox" name="telegram" disabled={!edit} defaultChecked={settings.failover.notifyTelegram} /> {t("settings.routeTelegram")}</label>
              <label className="md:col-span-2"><input type="checkbox" name="failback" disabled={!edit} defaultChecked={settings.failover.trigger === "tunnel-loss" && settings.failover.autoFailback} /> {t("settings.autoFailback")}</label>
              <Field label={t("settings.lossThreshold")}><Input name="loss" type="number" min={1} max={99} required disabled={!edit}
                defaultValue={settings.failover.packetLossThreshold ?? 10} /></Field>
              <Field label={t("settings.checkInterval")}><Input name="minutes" type="number" min={1} max={1440} required disabled={!edit}
                defaultValue={settings.failover.trigger === "tunnel-loss" ? settings.failover.intervalSec / 60 : 5} /></Field>
              <p className="text-sm text-muted-foreground md:col-span-2">{t("settings.failoverHint")}</p>
              <Button type="submit" disabled={!edit}>{t("settings.saveFailover")}</Button>
            </form>
          </CardContent></Card>
        </TabsContent>
        {monitor && <TabsContent value="telegram" className="mt-4">
          <Card><CardContent className="space-y-3 pt-5">
            <Toggle label={t("settings.sendTelegramAlerts")} checked={settings.notifications.telegram} disabled={!edit}
              onChange={(value) => updateSettings({ notifications: { ...settings.notifications, telegram: value } })} />
            {edit && <TelegramDeliverySettings />}
          </CardContent></Card>
        </TabsContent>}
        <TabsContent value="notify" className="mt-4">
          <Card><CardContent className="grid gap-3 pt-5">
            {!monitor && <Toggle label={t("settings.channelTelegram")} checked={settings.notifications.telegram} disabled={!edit} onChange={(value) => updateSettings({ notifications: { ...settings.notifications, telegram: value } })} />}
            <Toggle label={t("settings.channelEmail")} checked={settings.notifications.email} disabled={!edit} onChange={(value) => updateSettings({ notifications: { ...settings.notifications, email: value } })} />
            {!monitor && <Toggle label={t("settings.channelWebhook")} checked={settings.notifications.webhook} disabled={!edit} onChange={(value) => updateSettings({ notifications: { ...settings.notifications, webhook: value } })} />}
            {!monitor && <Field label={t("settings.telegramChat")}><Input disabled={!edit} key={settings.notifications.telegramChat} defaultValue={settings.notifications.telegramChat} onBlur={(event) => { if (event.target.value !== String(settings.notifications.telegramChat)) updateSettings({ notifications: { ...settings.notifications, telegramChat: event.target.value } }); }} /></Field>}
            {!monitor && <Field label={t("settings.emailTo")}><Input dir="ltr" disabled={!edit} key={settings.notifications.emailTo} defaultValue={settings.notifications.emailTo} onBlur={(event) => { if (event.target.value !== String(settings.notifications.emailTo)) updateSettings({ notifications: { ...settings.notifications, emailTo: event.target.value } }); }} /></Field>}
            {!monitor && <Field label={t("settings.webhookUrl")}><Input className="tech" disabled={!edit} key={settings.notifications.webhookUrl} defaultValue={settings.notifications.webhookUrl} onBlur={(event) => { if (event.target.value !== String(settings.notifications.webhookUrl)) updateSettings({ notifications: { ...settings.notifications, webhookUrl: event.target.value } }); }} /></Field>}
            <Field label={t("settings.minSeverity")}>
              <Select disabled={!edit} value={settings.notifications.onSeverity} onChange={(event) => updateSettings({ notifications: { ...settings.notifications, onSeverity: event.target.value as AlertSeverity } })}>
                <option value="info">{t("common.status.info")}</option>
                <option value="warning">{t("common.status.warning")}</option>
                <option value="critical">{t("common.status.critical")}</option>
              </Select>
            </Field>
            {monitor && edit && <GmailSettings />}
            {!monitor && <div className="flex gap-2">
              <Button disabled={!edit} onClick={() => void testNotification("telegram").then((error) => error ? toast.error(copy(error)) : toast.success(t("settings.telegramSimulated")))}>{t("settings.testTelegram")}</Button>
              <Button variant="outline" disabled={!edit} onClick={() => void testNotification("email").then((error) => error ? toast.error(copy(error)) : toast.success(t("settings.emailSimulated")))}>{t("settings.testEmail")}</Button>
              <Button variant="outline" disabled={!edit} onClick={() => void testNotification("webhook").then((error) => error ? toast.error(copy(error)) : toast.success(t("settings.webhookSimulated")))}>{t("settings.testWebhook")}</Button>
            </div>}
          </CardContent></Card>
        </TabsContent>
        {!adminMode && <TabsContent value="access" className="mt-4 space-y-3">
          {users.map((item) => (
            <Card key={item.id}><CardContent className="flex items-center justify-between pt-5"><div><div className="font-medium">{item.name}</div><div className="tech text-xs text-muted-foreground">{item.email}</div></div><div>{t(`common.roles.${item.role}`)}</div></CardContent></Card>
          ))}
          <p className="text-sm text-muted-foreground">{t("settings.accessHint")}</p>
          {!security ? <p className="text-sm text-amber-600">{t("settings.securityHidden")}</p> : <p className="text-sm">{t("settings.superAdminAccess")}</p>}
        </TabsContent>}
        <TabsContent value="audit" className="mt-4">
          <Card><CardContent className="space-y-2 pt-5 text-sm">{audit.slice(0, 30).map((item) => <div key={item.id}><span className="tech">{format.formatDateTime(item.at)}</span> · {item.actor} · <span className="tech">{item.action}</span> · {copy(item.detail)}</div>)}</CardContent></Card>
        </TabsContent>
        <TabsContent value="retention" className="mt-4 space-y-4">
          <Card><CardContent className="grid gap-3 pt-5">
            <Field label={t("settings.retentionDays")}><Input className="tech" disabled={!edit} key={settings.dataRetentionDays} defaultValue={settings.dataRetentionDays} onBlur={(event) => { if (event.target.value !== String(settings.dataRetentionDays)) updateSettings({ dataRetentionDays: Number(event.target.value) }); }} /></Field>
            <p className="text-sm text-muted-foreground">{t("settings.retentionHint")}</p>
          </CardContent></Card>
          {!backend && <Button variant="destructive" onClick={() => { resetDemo(); toast.success(t("common.demoResetDone")); }}>{t("common.resetDemo")}</Button>}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AdminPasswordForm() {
  const { t, copy } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return <Card>
    <CardHeader><CardTitle>{t("settings.password.title")}</CardTitle></CardHeader>
    <CardContent>
      <form className="max-w-md space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        const current = String(fields.get("currentPassword") ?? "");
        const next = String(fields.get("newPassword") ?? "");
        if (next !== fields.get("confirmPassword")) {
          setError(t("settings.password.mismatch"));
          return;
        }
        setError("");
        setBusy(true);
        try {
          await updateAdminPassword(current, next);
          await queryClient.invalidateQueries({ queryKey: adminPasskeysQueryKey });
          form.reset();
          toast.success(t("settings.password.saved"));
        } catch (cause) {
          setError(cause instanceof Error ? copy(cause.message) : t("settings.password.failed"));
        } finally {
          setBusy(false);
        }
      }}>
        <fieldset className="grid gap-3" disabled={busy}>
          <Field label={t("settings.password.current")}><Input name="currentPassword" type="password" autoComplete="current-password" maxLength={256} required dir="ltr" /></Field>
          <Field label={t("settings.password.next")}><Input name="newPassword" type="password" autoComplete="new-password" minLength={15} maxLength={256} required dir="ltr" /></Field>
          <Field label={t("settings.password.confirm")}><Input name="confirmPassword" type="password" autoComplete="new-password" minLength={15} maxLength={256} required dir="ltr" /></Field>
        </fieldset>
        <p className="text-sm text-muted-foreground">{t("settings.password.hint")}</p>
        {error && <p role="alert" className="text-sm text-destructive">{copy(error)}</p>}
        <Button type="submit" disabled={busy}>{busy ? t("settings.password.saving") : t("settings.password.submit")}</Button>
      </form>
    </CardContent>
  </Card>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><Label>{label}</Label>{children}</label>;
}
function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <div className="flex items-center justify-between text-sm"><span>{label}</span><Switch checked={checked} disabled={disabled} onCheckedChange={onChange} /></div>;
}
