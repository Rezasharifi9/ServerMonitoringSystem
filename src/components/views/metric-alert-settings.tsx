"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button, Input, Select } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { alertMetrics, alertOperators, type AlertMetric, type AlertOperator } from "@/lib/alert-rules";
import { useInfraAction } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";

export function MetricAlertSettings({ editable }: { editable: boolean }) {
  const { t, copy } = useI18n();
  const rules = useInfraStore((s) => s.settings.metricAlertRules) ?? [];
  const update = useInfraAction("updateSettings");
  const [metric, setMetric] = useState<AlertMetric>("cpu");
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const current = rules.find((rule) => rule.id === editing);
  async function save(next: typeof rules) {
    setBusy(true);
    try {
      const error = await update({ metricAlertRules: next });
      if (error) { toast.error(copy(error)); return false; }
      return true;
    } finally { setBusy(false); }
  }
  return <section className="space-y-3 border-t pt-4">
    <h3 className="font-medium">{t("alerts.rules.title")}</h3>
    <p className="text-sm text-muted-foreground">{t("alerts.rules.description")}</p>
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-muted/60"><tr>{["name", "metric", "target", "operator", "severity", "status", "actions"].map((key) => <th key={key} scope="col" className="p-3 text-start">{t(`alerts.rules.${key}`)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{rules.map((rule) => <tr key={rule.id}>
          <td className="p-3 font-medium">{rule.name}</td>
          <td className="p-3">{t(`alerts.metrics.${rule.metric}`)}</td>
          <td className="p-3">{t(rule.targetId === "all" ? "alerts.rules.allServers" : "alerts.rules.legacyTarget")}</td>
          <td className="p-3"><bdi className="tech">{alertOperators[rule.operator]} {rule.threshold}</bdi></td>
          <td className="p-3">{t(`common.status.${rule.severity ?? "warning"}`)}</td>
          <td className="p-3">{t(rule.enabled ? "alerts.on" : "alerts.off")}</td>
          <td className="p-3"><div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={!editable || busy} onClick={() => { setEditing(rule.id); setMetric(rule.metric); }}>{t("alerts.rules.edit")}</Button>
      <Button variant="outline" size="sm" disabled={!editable || busy} onClick={() => void save(rules.map((item) => item.id === rule.id ? { ...rule, enabled: !rule.enabled } : item))}>
        {rule.enabled ? t("alerts.rules.disable") : t("alerts.rules.enable")}
      </Button>
      <Button variant="ghost" size="sm" disabled={!editable || busy} onClick={() => void save(rules.filter((item) => item.id !== rule.id)).then((ok) => { if (ok && editing === rule.id) setEditing(undefined); })}>{t("alerts.rules.delete")}</Button>
          </div></td>
        </tr>)}</tbody>
      </table>
      {!rules.length && <p className="p-6 text-center text-muted-foreground">{t("alerts.rules.empty")}</p>}
    </div>
    {editable && <form key={editing ?? "new"} className="grid gap-4 rounded-xl border border-border bg-muted/20 p-4 md:grid-cols-3" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const rule = { id: current?.id ?? crypto.randomUUID(), name: String(data.get("name")), targetId: "all", metric,
        operator: String(data.get("operator")) as AlertOperator, threshold: Number(data.get("threshold")),
        severity: String(data.get("severity")) as "info" | "warning" | "critical", cooldownMinutes: 60, enabled: current?.enabled ?? true };
      if (await save(current ? rules.map((item) => item.id === current.id ? rule : item) : [...rules, rule])) {
        form.reset(); setEditing(undefined);
      }
    }}>
      <label>{t("alerts.rules.name")}<Input name="name" required maxLength={96} defaultValue={current?.name} /></label>
      <label>{t("alerts.rules.metric")}<Select value={metric} onChange={(event) => setMetric(event.target.value as AlertMetric)}>
        {(Object.keys(alertMetrics) as AlertMetric[]).map((key) => <option key={key} value={key}>{t(`alerts.metrics.${key}`)}</option>)}
      </Select></label>
      <div className="rounded-lg border border-border p-3 text-sm">{t("alerts.rules.allServers")}<p className="mt-1 text-xs text-muted-foreground">{t("alerts.rules.hourly")}</p></div>
      <label>{t("alerts.rules.severity")}<Select name="severity" defaultValue={current?.severity ?? "warning"}>{["info", "warning", "critical"].map((level) => <option key={level} value={level}>{t(`common.status.${level}`)}</option>)}</Select></label>
      <label>{t("alerts.rules.operator")}<Select name="operator" defaultValue={current?.operator ?? "gt"}>{Object.entries(alertOperators).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></label>
      <label>{t("alerts.rules.threshold")}<Input dir="ltr" name="threshold" type="number" min={0} max={["disk", "cpu", "ram", "serverLoss", "tunnelLoss"].includes(metric) ? 100 : 120000} step="any" required defaultValue={current?.threshold} /></label>
      <Button disabled={busy} type="submit">{current ? t("alerts.rules.saveEdit") : t("alerts.rules.add")}</Button>
      {current && <Button type="button" variant="outline" onClick={() => setEditing(undefined)}>{t("alerts.rules.cancelEdit")}</Button>}
    </form>}
  </section>;
}
