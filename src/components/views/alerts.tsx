"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { categoryLabel, severityLabel } from "@/lib/labels";
import { can } from "@/lib/rbac";
import { useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { AlertCategory, AlertSeverity } from "@/types";

import { MetricAlertSettings } from "./metric-alert-settings";

export function AlertsView({ initialScope = "current" }: { initialScope?: "current" | "archived" }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const user = useCurrentUser();
  const alerts = useInfraStore((state) => state.alerts);
  const incidents = useInfraStore((state) => state.incidents);
  const users = useInfraStore((state) => state.users);
  const settings = useInfraStore((state) => state.settings);
  const ack = useInfraAction("acknowledgeIncident");
  const resolve = useInfraAction("resolveIncident");
  const assign = useInfraAction("assignIncident");
  const silence = useInfraAction("silenceAlert");
  const archive = useInfraAction("archiveAlert");
  const restore = useInfraAction("restoreAlert");
  const [q, setQ] = useState("");
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [scope, setScope] = useState<"current" | "archived">(initialScope);
  const [selected, setSelected] = useState(incidents[0]?.id ?? "");
  const allowed = can(user.role, "alert.manage");
  const visible = alerts.filter((alert) => {
    if (Boolean(alert.archived) !== (scope === "archived")) return false;
    const haystack = `${alert.title} ${alert.detail} ${copy(alert.title)} ${copy(alert.detail)}`;
    if (q && !haystack.includes(q)) return false;
    if (severity !== "all" && alert.severity !== severity) return false;
    if (category !== "all" && alert.category !== category) return false;
    return true;
  });
  const incident = incidents.find((item) => item.id === selected) ?? incidents.find((item) => item.id === visible[0]?.incidentId);

  return (
    <div className="space-y-4">
      <PageHeader title={t("alerts.title")} description={t(monitor ? "alerts.monitorDescription" : "alerts.description")} />
      {monitor && <Card>
        <CardHeader><CardTitle>{t("alerts.thresholds")}</CardTitle></CardHeader>
        <CardContent><MetricAlertSettings editable={can(user.role, "settings.edit")} /></CardContent>
      </Card>}
      <div className="grid gap-2 md:grid-cols-4">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t("alerts.search")} />
        <Select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">{t("alerts.allSeverities")}</option>{(Object.keys(severityLabel) as AlertSeverity[]).map((item) => <option key={item} value={item}>{t(`common.status.${item}`)}</option>)}</Select>
        <Select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">{t("alerts.allCategories")}</option>{(Object.keys(categoryLabel) as AlertCategory[]).map((item) => <option key={item} value={item}>{t(`common.category.${item}`)}</option>)}</Select>
        <Select aria-label={t("alerts.scope")} value={scope} onChange={(event) => setScope(event.target.value as "current" | "archived")}>
          <option value="current">{t("alerts.scopeCurrent")}</option>
          <option value="archived">{t("alerts.scopeArchived")}</option>
        </Select>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-2">
          {!visible.length && <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t(scope === "archived" ? "alerts.emptyArchived" : "alerts.emptyCurrent")}</p>}
          {visible.map((alert) => {
            const silenced = Boolean(alert.silencedUntil);
            return (
              <div key={alert.id} onClick={() => alert.incidentId && setSelected(alert.incidentId)} className="w-full cursor-pointer rounded-xl border border-border bg-card p-3 text-start">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{copy(alert.title)}</span>
                  <span className="flex gap-1"><StatusBadge value={alert.severity} />{silenced ? <StatusBadge value="silenced" /> : null}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t(`common.category.${alert.category}`)} · <span className="tech">{format.formatDateTime(alert.createdAt)}</span> · {copy(alert.detail)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {alert.tunnelId && <Link href={`/tunnels/${encodeURIComponent(alert.tunnelId)}`} onClick={(event) => event.stopPropagation()} className="inline-flex items-center rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">{t("alerts.tunnelDetails")}</Link>}
                  <Button size="sm" variant="outline" disabled={!allowed || !alert.incidentId} onClick={async (event) => { event.stopPropagation(); const error = alert.incidentId ? await ack(alert.incidentId) : t("alerts.noIncident"); if (error) toast.error(copy(error)); else toast.success(t("alerts.acked")); }}>{t("alerts.ack")}</Button>
                  <Button size="sm" variant="outline" disabled={!allowed || !alert.incidentId} onClick={async (event) => { event.stopPropagation(); const error = alert.incidentId ? await resolve(alert.incidentId) : t("alerts.noIncident"); if (error) toast.error(copy(error)); else toast.success(t("alerts.resolved")); }}>{t("alerts.resolve")}</Button>
                  <Button size="sm" variant="ghost" disabled={!allowed} onClick={async (event) => { event.stopPropagation(); const error = await silence(alert.id, 60); if (error) toast.error(copy(error)); else toast.success(t("alerts.silenced", { minutes: 60 })); }}>{t("alerts.silence")}</Button>
                  {alert.archived ? (
                    <Button size="sm" variant="outline" disabled={!allowed} onClick={async (event) => { event.stopPropagation(); const error = await restore(alert.id); if (error) toast.error(copy(error)); else toast.success(t("alerts.restored")); }}>{t("alerts.restore")}</Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={!allowed} onClick={async (event) => { event.stopPropagation(); const error = await archive(alert.id); if (error) toast.error(copy(error)); else toast.success(t("alerts.archived")); }}>{t("alerts.archive")}</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <Card>
          <CardHeader><CardTitle>{t("alerts.timeline")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {incident ? (
              <>
                <div className="flex items-center justify-between"><span>{copy(incident.title)}</span><StatusBadge value={incident.status} /></div>
                <p className="text-muted-foreground">{copy(incident.summary)}</p>
                {incident.timeline.map((item, index) => <div key={index}><span className="tech">{format.formatDateTime(item.at)}</span> · {copy(item.text)}</div>)}
                <Select value={incident.assignee ?? ""} disabled={!allowed} onChange={async (event) => { const error = await assign(incident.id, event.target.value); if (error) toast.error(copy(error)); else toast.success(t("alerts.assigned")); }}>
                  <option value="">{t("alerts.assign")}</option>
                  {users.map((item) => <option key={item.id}>{item.name}</option>)}
                </Select>
              </>
            ) : <p>{t("alerts.none")}</p>}
            <div className="border-t border-border pt-3 text-xs text-muted-foreground">
              {t("alerts.channels", {
                telegram: settings.notifications.telegram ? t("alerts.on") : t("alerts.off"),
                email: settings.notifications.email ? t("alerts.on") : t("alerts.off"),
                webhook: settings.notifications.webhook ? t("alerts.on") : t("alerts.off"),
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
