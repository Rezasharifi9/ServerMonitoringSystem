"use client";

import { POLLING, pollingInterval, jobActive } from "@/lib/polling";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton, DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { decideOperationalFailover, listOperationalFailovers, operationalFailoverPreflight, prepareOperationalFailover, progressOperationalFailover, syncBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { FailoverPolicy } from "@/types";
import { ImportPanelNode, useV2BoardCatalog } from "./v2board-inventory";

function FailoverFirstNode() {
  const { t, copy } = useI18n();
  const actor = useCurrentUser();
  const editable = can(actor.role, "node.edit");
  const catalog = useV2BoardCatalog(editable);
  const [selected, setSelected] = useState("");
  const entries = (catalog.data?.nodes ?? []).filter((entry) => !entry.nodeId);
  const entry = entries.find((item) => item.key === selected);
  return <Card>
    <CardHeader><CardTitle>{t("tunnels.failover.firstTitle")}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm">{t("tunnels.failover.firstBody")}</p>
      {entries.length > 0 && <label className="block">{t("tunnels.failover.v2boardNode")}
        <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">{t("tunnels.failover.chooseNode")}</option>
          {entries.map((item) => <option key={item.key} value={item.key}>{item.name || item.key}</option>)}
        </Select>
      </label>}
      {editable && catalog.isError && <p className="text-sm text-destructive">{copy(catalog.error.message)}</p>}
      {entry && <ImportPanelNode key={entry.key} entry={entry} onCancel={() => setSelected("")}
        onDone={() => { setSelected(""); void syncBackend(); }} />}
      <div className="flex flex-wrap gap-2">
        <Button asChild><Link href="/nodes">{t("tunnels.failover.manageNodes")}</Link></Button>
        <Button variant="outline" asChild><Link href="/tunnels">{t("tunnels.failover.manageTunnels")}</Link></Button>
      </div>
    </CardContent>
  </Card>;
}

function FailoverPolicyForm({ nodeId, policy }: { nodeId: string; policy: FailoverPolicy }) {
  const { t, copy } = useI18n();
  const actor = useCurrentUser();
  const node = useInfraStore((state) => state.nodes.find((item) => item.id === nodeId));
  const tunnels = useInfraStore((state) => state.tunnels);
  const update = useInfraAction("updatePolicy");
  const [busy, setBusy] = useState(false);
  const editable = can(actor.role, "failover.configure");
  const backup = tunnels.find((tunnel) => tunnel.id === node?.backupTunnelId);
  return <Card>
    <CardHeader><CardTitle>{t("tunnels.failover.policyTitle")}</CardTitle></CardHeader>
    <CardContent><form className="grid gap-3 md:grid-cols-3" key={JSON.stringify(policy)} onSubmit={async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBusy(true);
      try {
        const error = await update(nodeId, {
          trigger: String(data.get("trigger")) as FailoverPolicy["trigger"],
          intervalSec: Number(data.get("interval")), failureThreshold: Number(data.get("failures")),
          packetLossThreshold: Number(data.get("loss")), cooldownSec: Number(data.get("cooldown")),
          autoEnabled: data.has("auto"), manualApproval: data.has("approval"),
          autoFailback: data.has("failback"), notifyTelegram: data.has("telegram"),
        });
        if (error) throw new Error(error);
        toast.success(t("tunnels.failover.saved"));
      } catch (error) { toast.error(error instanceof Error ? copy(error.message) : t("tunnels.failover.saveFailed")); }
      finally { setBusy(false); }
    }}>
      <div>{t("tunnels.failover.backupPath")}<p>{backup ? `${backup.name} · ${backup.iranEndpoint.publicIp}` : "—"}</p>
        {!backup && <Link href="/tunnels/new">{t("nodes.detail.registerBackupLink")}</Link>}
      </div>
      <label>{t("tunnels.failover.trigger")}<Select name="trigger" disabled={!editable || busy} defaultValue={policy.trigger ?? "independent"}>
        <option value="independent">{t("tunnels.failover.triggerIndependent")}</option>
        <option value="server-ping">{t("tunnels.failover.triggerServerPing")}</option>
        <option value="packet-loss">{t("tunnels.failover.triggerLoss")}</option>
        <option value="tunnel-ping">{t("tunnels.failover.triggerTunnelPing")}</option>
      </Select></label>
      <label>{t("tunnels.failover.intervalSec")}<Input dir="ltr" name="interval" type="number" min={5} max={86400} required defaultValue={policy.intervalSec} disabled={!editable || busy} /></label>
      <label>{t("tunnels.failover.consecutive")}<Input dir="ltr" name="failures" type="number" min={1} max={100} required defaultValue={policy.failureThreshold} disabled={!editable || busy} /></label>
      <label>{t("tunnels.failover.lossThreshold")}<Input dir="ltr" name="loss" type="number" min={1} max={100} required defaultValue={policy.packetLossThreshold ?? 50} disabled={!editable || busy} /></label>
      <label>{t("tunnels.failover.cooldownSec")}<Input dir="ltr" name="cooldown" type="number" min={0} max={604800} required defaultValue={policy.cooldownSec} disabled={!editable || busy} /></label>
      <label><input name="auto" type="checkbox" defaultChecked={policy.autoEnabled} disabled={!editable || busy} /> {t("tunnels.failover.autoDns")}</label>
      <label><input name="approval" type="checkbox" defaultChecked={policy.manualApproval} disabled={!editable || busy} /> {t("tunnels.failover.needsApproval")}</label>
      <label><input name="failback" type="checkbox" defaultChecked={policy.autoFailback} disabled={!editable || busy} /> {t("tunnels.failover.autoReturn")}</label>
      <label><input name="telegram" type="checkbox" defaultChecked={policy.notifyTelegram} disabled={!editable || busy} /> {t("tunnels.failover.telegram")}</label>
      <Button type="submit" disabled={!editable || busy}>{t("tunnels.failover.savePolicy")}</Button>
    </form></CardContent>
  </Card>;
}

export function OperationalFailoverView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const params = useSearchParams();
  const user = useCurrentUser();
  const nodes = useInfraStore((state) => state.nodes);
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState(params.get("node") ?? "");
  const node = nodes.find((item) => item.id === selectedId) ?? nodes[0];
  const policy = useInfraStore((state) => state.policies.find((item) => item.nodeId === node?.id));
  const target = node?.activeSide === "backup" ? "primary" : "backup";
  const queryKey = ["operational-failover-plans", user.id];
  const plans = useQuery({ queryKey, queryFn: listOperationalFailovers, refetchInterval: (query) => pollingInterval(query,
    query.state.data?.data.some((plan) => plan.execution && jobActive(plan.execution)) ? POLLING.job : POLLING.idle) });
  const preflight = useQuery({
    queryKey: ["operational-failover-preflight", user.id, node?.id, target],
    queryFn: () => operationalFailoverPreflight(node.id, target),
    enabled: Boolean(node), refetchInterval: (query) => pollingInterval(query, POLLING.preview),
  });
  const editable = can(user.role, "failover.run");
  const refresh = () => void client.invalidateQueries({ queryKey });
  const prepare = useMutation({
    mutationFn: prepareOperationalFailover,
    onSuccess: () => { refresh(); toast.success(t("tunnels.failover.registered")); },
    onError: (error) => toast.error(copy(error.message)),
  });
  const decide = useMutation({
    mutationFn: decideOperationalFailover,
    onSuccess: (plan) => {
      refresh();
      if (plan.status === "stale") toast.error(t("tunnels.failover.stale"));
      else toast.success(plan.status === "approved" ? t("tunnels.failover.approved") : t("tunnels.failover.rejected"));
    },
    onError: (error) => toast.error(copy(error.message)),
  });
  const progress = useMutation({
    mutationFn: progressOperationalFailover,
    onSuccess: () => refresh(),
    onError: (error) => toast.error(copy(error.message)),
  });
  const canExecute = editable && can(user.role, "dns.switch") && Boolean(plans.data?.executionEnabled);
  const result = preflight.data;
  const history = (plans.data?.data ?? []).filter((item) => item.nodeId === node?.id);
  const confirm = t("deployments.confirmOperation");

  return (
    <div className="space-y-4">
      <PageHeader title={t("tunnels.failover.operationalTitle")} description={t("tunnels.failover.operationalDescription")} />
      <DemoNote>{t("tunnels.failover.operationalNote")}</DemoNote>
      {!node ? <FailoverFirstNode /> : (
        <Card>
          <CardHeader><CardTitle>{t("tunnels.failover.preflightTitle", { side: target === "backup" ? t("tunnels.failover.backupSide") : t("tunnels.failover.primarySide") })}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Select value={node.id} onChange={(event) => setSelectedId(event.target.value)}>
              {nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
            {preflight.isPending && <p>{t("tunnels.failover.checking")}</p>}
            {preflight.isError && <p className="text-destructive">{copy(preflight.error.message)}</p>}
            {result && (
              <>
                <p className="text-sm"><Tech>{result.domain}</Tech> · <Tech>{result.fromIp ?? "—"} → {result.toIp ?? "—"}</Tech></p>
                <p className="text-sm">{t("tunnels.failover.confirmationsLine", { current: result.targetConfirmations, required: result.requiredConfirmations, failures: result.failureConfirmations })}</p>
                <p className="text-sm">{result.automaticEligible ? t("tunnels.failover.automaticReady") : t("tunnels.failover.automaticNotReady")}</p>
                <ul className="space-y-1 text-sm">
                  {result.checks.map((check) => <li key={check.code}><span className={check.ok ? "text-emerald-600" : "text-destructive"}>{check.ok ? "✓" : "×"}</span> {copy(check.label)}</li>)}
                </ul>
                <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.registerPlan")} title={t("tunnels.failover.registerTitle")} description={t("tunnels.failover.registerBody", { from: String(result.fromIp), to: String(result.toIp) })}
                  disabled={!editable || !result.ready || prepare.isPending || history.some((item) => item.status === "awaiting_approval" || (item.status === "approved" && !["succeeded", "rolled_back", "aborted"].includes(item.execution?.status ?? "")))}
                  onConfirm={() => prepare.mutate({ nodeId: node.id, target, key: crypto.randomUUID() })} />
              </>
            )}
          </CardContent>
        </Card>
      )}
      {node && policy && <FailoverPolicyForm key={node.id} nodeId={node.id} policy={policy} />}
      {node && <Card>
        <CardHeader><CardTitle>{t("tunnels.failover.plansTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {plans.isPending ? <p>{t("tunnels.failover.loadingHistory")}</p> : plans.isError ? <p className="text-destructive">{copy(plans.error.message)}</p>
            : !history.length && <p>{t("tunnels.failover.noPlans")}</p>}
          {history.map((plan) => (
            <div className="space-y-2 rounded-lg border border-border p-3 text-sm" key={plan.id}>
              <div className="flex flex-wrap justify-between"><strong>{plan.execution ? t(`tunnels.failover.execution.${plan.execution.status}`) : t(`tunnels.failover.status.${plan.status}`)}</strong><span>{format.formatDateTime(plan.createdAt)}</span></div>
              <div><Tech>{plan.preflight.fromIp} → {plan.preflight.toIp}</Tech></div>
              <p>{plan.automatic ? t("tunnels.failover.automaticPlan") : t("tunnels.failover.manualPlan")} · {t("tunnels.failover.deadline", { time: format.formatDateTime(plan.expiresAt) })}{plan.requireSecondActor ? ` ${t("tunnels.failover.secondActor")}` : ""}</p>
              <div className="flex flex-wrap gap-2">
                {plan.status === "awaiting_approval" && <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.approve")} title={t("tunnels.failover.approveTitle")}
                  description={t("tunnels.failover.approveBody", { from: String(plan.preflight.fromIp), to: String(plan.preflight.toIp) })}
                  disabled={!editable || decide.isPending || (plan.requireSecondActor && plan.requestedBy === user.id)}
                  onConfirm={() => decide.mutate({ id: plan.id, decision: "approve" })} />}
                {!plan.execution && (plan.status === "awaiting_approval" || plan.status === "approved") && <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.reject")} title={t("tunnels.failover.rejectTitle")}
                  description={plan.automatic ? t("tunnels.failover.rejectAutomatic") : t("tunnels.failover.rejectManual")}
                  disabled={!editable || decide.isPending} onConfirm={() => decide.mutate({ id: plan.id, decision: "reject" })} />}
                {plan.status === "approved" && !plan.execution && <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.execute")} title={t("tunnels.failover.executeTitle")}
                  description={t("tunnels.failover.executeBody")}
                  disabled={!canExecute || progress.isPending}
                  onConfirm={() => progress.mutate({ id: plan.id, action: "execute" })} />}
                {plan.execution && ["applying", "verifying", "rolling_back"].includes(plan.execution.status) &&
                  <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.advance")} title={t("tunnels.failover.advanceTitle")} description={t("tunnels.failover.advanceBody")}
                    disabled={!canExecute || progress.isPending}
                    onConfirm={() => progress.mutate({ id: plan.id, action: "advance" })} />}
                {plan.execution?.status === "review" && <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.reconcile")} title={t("tunnels.failover.reconcileTitle")}
                  description={t("tunnels.failover.reconcileBody")}
                  disabled={!canExecute || progress.isPending}
                  onConfirm={() => progress.mutate({ id: plan.id, action: "reconcile" })} />}
                {plan.execution?.status === "verifying" && <ConfirmButton confirmLabel={confirm} label={t("tunnels.failover.requestRollback")} title={t("tunnels.failover.requestRollbackTitle")}
                  description={t("tunnels.failover.requestRollbackBody")}
                  disabled={!canExecute || progress.isPending}
                  onConfirm={() => progress.mutate({ id: plan.id, action: "rollback" })} />}
              </div>
              {plan.execution && <p className="text-muted-foreground">{copy(plan.execution.detail)}</p>}
            </div>
          ))}
        </CardContent>
      </Card>}
    </div>
  );
}
