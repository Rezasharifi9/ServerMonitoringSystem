"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { maskSecret } from "@/lib/utils";
import { can } from "@/lib/rbac";
import { v2boardAdminV1, v2bxLegacy } from "@/services/adapters/v2board";
import { refreshProvider, useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import { V2BoardAdminForm } from "./v2board-admin-form";
import { DnsProviderSettings } from "./dns-provider-settings";

export function IntegrationsView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const monitor = useBackend((state) => state.mode === "monitor");
  const integrations = useInfraStore((state) => state.integrations);
  const servers = useInfraStore((state) => state.servers);
  const test = useInfraAction("testIntegration");
  const sync = useInfraAction("syncIntegration");
  const update = useInfraAction("updateIntegration");
  const allowed = can(user.role, "integration.edit");
  const board = integrations.find((item) => item.type === "v2board");
  const cloud = integrations.find((item) => item.type === "cloudflare");
  const agent = integrations.find((item) => item.type === "agent");
  const [zone, setZone] = useState(cloud?.config.zone ?? "");
  async function persist(id: string, config: Record<string, string>) {
    if (!allowed) return toast.error(t("integrations.editDenied"));
    const error = await update(id, config);
    if (error) toast.error(copy(error));
    else toast.success(t("integrations.saved"));
  }
  const syncMode = board?.config.syncMode;
  const schedule = syncMode === "scheduled"
    ? t("integrations.syncScheduled", { seconds: board?.config.syncIntervalSec ?? "" })
    : syncMode === "invalid" ? t("integrations.syncInvalid") : t("integrations.syncManual");

  return (
    <div className="space-y-4">
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      {monitor ? <p className="text-sm text-muted-foreground">{t("integrations.monitorHint")}</p> :
        <DemoNote>{t("integrations.demoAdapterLead")} <Tech>{v2boardAdminV1.version}</Tech> {t("integrations.and")} <Tech>{v2bxLegacy.version}</Tech>.</DemoNote>}
      {board ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between"><CardTitle>V2Board</CardTitle><StatusBadge value={board.status} /></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 text-sm">
            {!monitor && <>
            <Field label={t("integrations.panelUrl")} value={board.config.panelUrl} onSave={(value) => void persist(board.id, { panelUrl: value })} />
            <Field label={t("integrations.securePath")} value={board.config.securePath} onSave={(value) => void persist(board.id, { securePath: value })} />
            <div>{t("integrations.apiStyle")}: <Tech>{board.config.apiStyle}</Tech></div>
            <div>{t("integrations.token")}: <Tech>{maskSecret(board.config.token)}</Tech></div>
            <div>{t("integrations.syncMinutes", { minutes: board.config.syncMinutes })}</div>
            </>}
            <div>{t("integrations.imported")}: <span className="tech">{board.config.imported ?? "—"}</span></div>
            <div>{t("integrations.lastSync")}: <span className="tech">{format.formatDateTime(board.lastSync)}</span></div>
            <div>{t("integrations.lastTest")}: <span className="tech">{format.formatDateTime(board.lastTest)}</span></div>
            {monitor && <div>{t("integrations.schedule")} {schedule}</div>}
            <p className="md:col-span-2 text-muted-foreground">{copy(board.message)}</p>
            <div className="flex gap-2 md:col-span-2">
              {!monitor && <Button disabled={!allowed} onClick={() => void test(board.id).then((error) => error ? toast.error(copy(error)) : toast.success(t("integrations.sampleConnectedToast")))}>{t("integrations.testConnection")}</Button>}
              <Button variant="outline" disabled={!allowed || (monitor && board.config.readEnabled !== "true")} onClick={() => {
                const observed = monitor;
                void (observed ? refreshProvider("v2board/sync") : sync(board.id)).then((error) =>
                  error ? toast.error(copy(error)) : toast.success(observed ? t("integrations.nodesRead") : t("integrations.sampleSynced")));
              }}>{monitor ? t("integrations.readNodes") : t("integrations.sampleSync")}</Button>
              {monitor && <Link className="self-center text-primary" href="/nodes">{t("integrations.catalog")}</Link>}
            </div>
            {monitor && allowed && <V2BoardAdminForm enabled={board.config.adminLoginEnabled === "true"} />}
          </CardContent>
        </Card>
      ) : null}
      {cloud ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between"><CardTitle>{monitor ? t("integrations.dnsTitleMonitor") : t("integrations.dnsTitleDemo")}</CardTitle><StatusBadge value={cloud.status} /></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 text-sm">
            {monitor ? <>
              {allowed && <DnsProviderSettings />}
              <div>{t("integrations.readState")}: {cloud.config.readEnabled === "true" ? t("integrations.readConfigured") : t("integrations.readDisabled")}</div>
              <div>{t("integrations.lastRead")}: <span className="tech">{format.formatDateTime(cloud.lastSync)}</span></div>
              <p>{copy(cloud.message)}</p>
              <div className="flex flex-wrap gap-2">
                <Link className="self-center text-primary" href="/dns">{t("integrations.dnsRecords")}</Link>
              </div>
            </> : <>
            <div>{t("integrations.token")}: <Tech>{maskSecret(cloud.config.token)}</Tech></div>
            <label className="grid gap-1"><Label>{t("integrations.zone")}</Label><Input dir="ltr" value={zone} onChange={(event) => setZone(event.target.value)} /></label>
            <p className="md:col-span-2 text-muted-foreground">{t("integrations.demoMap", { message: copy(cloud.message) })}</p>
            <div className="flex gap-2">
              <Button disabled={!allowed} onClick={async () => { const error = await update(cloud.id, { zone }); if (error) toast.error(copy(error)); else toast.success(t("integrations.zoneSaved")); }}>{t("integrations.saveZone")}</Button>
              <Button variant="outline" disabled={!allowed} onClick={() => void test(cloud.id).then((error) => error ? toast.error(copy(error)) : toast.success(t("integrations.sampleConnectedToast")))}>{t("integrations.testConnection")}</Button>
            </div>
            </>}
          </CardContent>
        </Card>
      ) : null}
      {agent ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between"><CardTitle>{t("integrations.agentTitle")}</CardTitle><StatusBadge value={agent.status} /></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{copy(agent.message)}</p>
            <p>{t("integrations.channel")}: <Tech>{agent.config.channel}</Tech></p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-muted-foreground"><th className="py-2 text-start">{t("integrations.id")}</th><th className="text-start">{t("integrations.server")}</th><th className="text-start">{t("integrations.version")}</th><th className="text-start">{t("integrations.heartbeat")}</th><th className="text-start">{t("integrations.status")}</th></tr></thead>
                <tbody>
                  {servers.map((server) => (
                    <tr key={server.id} className="border-t border-border">
                      <td className="py-2"><Tech>{server.agent.id}</Tech></td>
                      <td>{server.name}</td>
                      <td><Tech>{server.agent.version}</Tech></td>
                      <td className="tech">{format.formatDateTime(server.agent.lastHeartbeat)}</td>
                      <td><StatusBadge value={server.agent.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t("integrations.capabilities")} <span className="tech">metrics, systemd, tunnel, dns-observe, speedtest</span></p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Field({ label, value, onSave }: { label: string; value: string; onSave: (value: string) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  return (
    <label className="grid gap-1">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input dir="ltr" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="button" variant="outline" onClick={() => onSave(draft)}>{t("common.save")}</Button>
      </div>
    </label>
  );
}
