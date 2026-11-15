"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DemoNote, PageHeader, Tech } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@/components/ui/kit";
import { Switch } from "@/components/ui/overlays";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { rollbackFailover, simulateFailover } from "@/services/api";
import { OperationalFailoverView } from "@/components/views/operational-failover";
import { useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { FailoverScenario } from "@/types";

const STATES = ["HEALTHY", "SUSPECT", "CONFIRMED_DOWN", "PREPARING_BACKUP", "SWITCHING", "VERIFYING", "RECOVERED", "ROLLBACK", "FAILED"] as const;
const SCENARIOS: FailoverScenario[] = ["primary-failure", "tunnel-failure", "v2bx-failure", "dns-mismatch", "backup-unavailable", "validation-failed", "auto-recovery"];

export function FailoverView() {
  const monitor = useBackend((state) => state.mode === "monitor");
  return monitor ? <OperationalFailoverView /> : <SimulatedFailoverView />;
}

function SimulatedFailoverView() {
  const { t, copy, locale } = useI18n();
  const format = useFormat();
  const params = useSearchParams();
  const user = useCurrentUser();
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const policies = useInfraStore((state) => state.policies);
  const events = useInfraStore((state) => state.failoverEvents);
  const run = useInfraStore((state) => state.failoverRun);
  const savePolicy = useInfraAction("updatePolicy");
  const updatePolicy = (...args: Parameters<typeof savePolicy>) => void savePolicy(...args).then((error) => { if (error) toast.error(copy(error)); });
  const [nodeId, setNodeId] = useState(() => params.get("node") || nodes[0]?.id || "");
  const node = nodes.find((item) => item.id === nodeId);
  const policy = policies.find((item) => item.nodeId === nodeId);
  const primary = servers.find((server) => server.id === node?.primaryServerId);
  const backup = servers.find((server) => server.id === node?.backupServerId);
  const foreign = servers.find((server) => server.id === node?.foreignServerId);
  const siblings = nodes.filter((item) => item.id !== nodeId && item.primaryServerId === node?.primaryServerId && item.activeSide === "primary");
  const allowed = can(user.role, "failover.run");
  const configure = can(user.role, "failover.configure");
  const names = siblings.map((item) => item.name).join(locale === "fa-IR" ? "، " : ", ") || t("tunnels.failover.none");

  const launch = (scenario: FailoverScenario | "manual") => {
    void simulateFailover(nodeId, scenario).then((error) => (error ? toast.error(copy(error)) : toast.success(t("tunnels.failover.started"))));
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("tunnels.failover.title")} description={t("tunnels.failover.description")} />
      <DemoNote>{t("tunnels.failover.note")}</DemoNote>
      <Card>
        <CardHeader><CardTitle>{t("tunnels.failover.selectNode")}</CardTitle></CardHeader>
        <CardContent>
          <Select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{nodes.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}</Select>
        </CardContent>
      </Card>
      {node && policy ? (
        <>
          <div className="grid gap-3 lg:grid-cols-4">
            <Hop title={t("tunnels.failover.users")} body={node.domain} active />
            <Hop title={t("tunnels.failover.iranPrimary")} body={`${primary?.name ?? "—"} · ${primary?.publicIpv4 ?? ""}`} active={node.activeSide === "primary"} />
            <Hop title={t("tunnels.failover.iranBackup")} body={`${backup?.name ?? "—"} · ${backup?.publicIpv4 ?? ""}`} active={node.activeSide === "backup"} />
            <Hop title={t("tunnels.failover.foreignV2bx")} body={`${foreign?.name ?? "—"} · ${node.v2bxStatus}`} active />
          </div>
          <Card>
            <CardHeader><CardTitle>{t("tunnels.failover.stateMachine")}</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {STATES.map((state) => (
                  <span key={state} className={run?.nodeId === node.id && run.state === state ? "rounded-full bg-primary px-3 py-1 text-xs text-primary-foreground" : "rounded-full bg-muted px-3 py-1 text-xs"}>
                    {t(`common.status.${state}`)}
                  </span>
                ))}
              </div>
              <div className="mt-4 max-h-56 space-y-1 overflow-auto text-sm">
                {(run?.nodeId === node.id ? run.log : []).map((line, index) => <p key={`${line.at}-${index}`}><Tech>{format.formatDateTime(line.at)}</Tech> {copy(line.message)}</p>)}
                {run?.running ? <p className="text-muted-foreground">{t("tunnels.failover.running")}</p> : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t("tunnels.failover.scenarios")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("tunnels.failover.siblingImpact", { count: siblings.length, names })}</p>
              <div className="flex flex-wrap gap-2">
                {SCENARIOS.map((scenario) => <Button key={scenario} variant="outline" disabled={!allowed || run?.running} onClick={() => launch(scenario)}>{t(`common.scenario.${scenario}`)}</Button>)}
                <Button disabled={!allowed || run?.running} onClick={() => launch("manual")}>{t("tunnels.failover.manual")}</Button>
                <Button variant="secondary" disabled={!allowed || run?.running} onClick={() => void rollbackFailover(node.id).then((error) => error ? toast.error(copy(error)) : toast.message(t("tunnels.failover.rollbackStarted")))}>{t("tunnels.failover.rollback")}</Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t("tunnels.failover.policy")}</CardTitle></CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <Num label={t("tunnels.failover.interval")} value={policy.intervalSec} disabled={!configure} onChange={(value) => updatePolicy(node.id, { intervalSec: value })} />
              <Num label={t("tunnels.failover.failureThreshold")} value={policy.failureThreshold} disabled={!configure} onChange={(value) => updatePolicy(node.id, { failureThreshold: value })} />
              <Num label={t("tunnels.failover.probeTimeout")} value={policy.probeTimeoutMs} disabled={!configure} onChange={(value) => updatePolicy(node.id, { probeTimeoutMs: value })} />
              <Num label={t("tunnels.failover.confirmations")} value={policy.minConfirmations} disabled={!configure} onChange={(value) => updatePolicy(node.id, { minConfirmations: value })} />
              <Num label={t("tunnels.failover.cooldown")} value={policy.cooldownSec} disabled={!configure} onChange={(value) => updatePolicy(node.id, { cooldownSec: value })} />
              <Num label={t("tunnels.failover.minCapacity")} value={policy.minBackupCapacity} disabled={!configure} onChange={(value) => updatePolicy(node.id, { minBackupCapacity: value })} />
              <Num label={t("tunnels.failover.stability")} value={policy.stabilitySec} disabled={!configure} onChange={(value) => updatePolicy(node.id, { stabilitySec: value })} />
              <label className="flex items-center justify-between text-sm">{t("tunnels.failover.auto")} <Switch checked={policy.autoEnabled} disabled={!configure} onCheckedChange={(value) => updatePolicy(node.id, { autoEnabled: value })} /></label>
              <label className="flex items-center justify-between text-sm">{t("tunnels.failover.manualApproval")} <Switch checked={policy.manualApproval} disabled={!configure} onCheckedChange={(value) => updatePolicy(node.id, { manualApproval: value })} /></label>
              <label className="flex items-center justify-between text-sm">{t("tunnels.failover.autoFailback")} <Switch checked={policy.autoFailback} disabled={!configure} onCheckedChange={(value) => updatePolicy(node.id, { autoFailback: value })} /></label>
              <Field label={t("tunnels.failover.backupPriority")}>
                <Select disabled={!configure} value={policy.backupPriority} onChange={(event) => updatePolicy(node.id, { backupPriority: event.target.value as typeof policy.backupPriority })}>
                  <option value="latency">{t("tunnels.failover.latency")}</option>
                  <option value="capacity">{t("tunnels.failover.capacity")}</option>
                  <option value="manual">{t("tunnels.failover.manualPriority")}</option>
                </Select>
              </Field>
              <Field label={t("tunnels.failover.dnsStrategy")}>
                <Select disabled={!configure} value={policy.dnsStrategy} onChange={(event) => updatePolicy(node.id, { dnsStrategy: event.target.value as typeof policy.dnsStrategy })}>
                  <option value="lowest-ttl">{t("tunnels.failover.lowestTtl")}</option>
                  <option value="weighted">{t("tunnels.failover.weighted")}</option>
                  <option value="manual-preview">{t("tunnels.failover.manualPreview")}</option>
                </Select>
              </Field>
              <Field label={t("tunnels.failover.rollbackStrategy")}>
                <Select disabled={!configure} value={policy.rollbackStrategy} onChange={(event) => updatePolicy(node.id, { rollbackStrategy: event.target.value as typeof policy.rollbackStrategy })}>
                  <option value="restore-primary-dns">{t("tunnels.failover.restorePrimary")}</option>
                  <option value="keep-backup">{t("tunnels.failover.keepBackup")}</option>
                  <option value="freeze">{t("tunnels.failover.freeze")}</option>
                </Select>
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t("tunnels.failover.history")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {events.filter((event) => event.nodeId === node.id).map((event) => (
                <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2">
                  <span>{format.formatDateTime(event.at)} · {copy(event.summary)}</span>
                  <StatusBadge value={event.result} />
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Hop({ title, body, active }: { title: string; body: string; active?: boolean }) {
  return <div className={active ? "rounded-xl border border-primary bg-primary/10 p-4" : "rounded-xl border border-dashed border-border p-4"}><div className="text-xs text-muted-foreground">{title}</div><div className="mt-2 text-sm">{body}</div></div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><Label>{label}</Label>{children}</label>;
}
function Num({ label, value, onChange, disabled }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean }) {
  return <Field label={label}><Input className="tech" dir="ltr" disabled={disabled} key={value} defaultValue={value} onBlur={(event) => { if (Number(event.target.value) !== value) onChange(Number(event.target.value)); }} /></Field>;
}
