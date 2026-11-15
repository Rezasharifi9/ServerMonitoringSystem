"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { DemoNote, PageHeader } from "@/components/shared/chrome";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { createDeploymentJob } from "@/services/api";
import { OperationalProvisionView } from "./operational-provision";
import { useBackend, useInfraAction } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";

const COMPONENTS = ["NodeGuard Agent", "V2bX", "GOST", "Backhaul", "Rathole", "GRE", "IPIP", "WireGuard", "BBR"];
const schema = z.object({
  serverId: z.string().min(1),
  component: z.string().min(1),
  port: z.string().optional(),
  forceConflict: z.enum(["no", "yes"]),
  outcome: z.enum(["success", "fail", "rollback"]),
});
const stepKeys = ["server", "component", "options", "preflight", "preview", "install", "log", "status"] as const;

export function DeploymentsView() {
  const monitor = useBackend((state) => state.mode === "monitor");
  return monitor ? <OperationalProvisionView /> : <SimulatedDeploymentsView />;
}

function SimulatedDeploymentsView() {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const servers = useInfraStore((state) => state.servers);
  const jobs = useInfraStore((state) => state.deployments);
  const rollback = useInfraAction("rollbackDeployment");
  const [step, setStep] = useState(0);
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { serverId: servers[0]?.id ?? "", component: "NodeGuard Agent", port: "4430", forceConflict: "no", outcome: "success" },
  });
  const values = form.watch();
  const server = servers.find((item) => item.id === values.serverId);
  const steps = stepKeys.map((key) => t(`deployments.wizard.${key}`));
  const active = jobs[0];
  const agentStatus = server?.agent.status ? t(`common.status.${server.agent.status}`) : "";
  const agentLabel = !server?.agent.status || agentStatus === `common.status.${server.agent.status}` ? server?.agent.status : agentStatus;

  return (
    <div className="space-y-4">
      <PageHeader title={t("deployments.title")} description={t("deployments.description")} />
      <DemoNote>{t("deployments.statusNote")}</DemoNote>
      <div className="flex flex-wrap gap-2 text-xs">{steps.map((item, index) => <span key={stepKeys[index]} className={index === step ? "rounded-full bg-primary px-2 py-1 text-primary-foreground" : "rounded-full bg-muted px-2 py-1"}>{t(`common.status.${index === 0 ? "pending" : index < 5 ? "validating" : "installing"}`)} · {item}</span>)}</div>
      <Card>
        <CardHeader><CardTitle>{steps[step]}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {step === 0 ? <Field label={t("deployments.wizard.target")}><Select {...form.register("serverId")} value={values.serverId}>{servers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field> : null}
          {step === 1 ? <Field label={t("deployments.wizard.service")}><Select {...form.register("component")} value={values.component}>{COMPONENTS.map((item) => <option key={item}>{item}</option>)}</Select></Field> : null}
          {step === 2 ? (
            <>
              <Field label={t("deployments.wizard.samplePort")}><Input className="tech" {...form.register("port")} /></Field>
              <Field label={t("deployments.wizard.portConflict")}><Select {...form.register("forceConflict")} value={values.forceConflict}><option value="no">{t("deployments.wizard.free")}</option><option value="yes">{t("deployments.wizard.occupied")}</option></Select></Field>
            </>
          ) : null}
          {step === 3 ? <ul className="text-sm leading-7 md:col-span-2"><li>{t("deployments.wizard.os")}: {server?.os}</li><li>{t("deployments.wizard.agent")}: {agentLabel}</li><li>{t("deployments.wizard.resources", { cpu: format.formatPercent(Math.round(server?.cpu ?? 0), 0) })}</li><li>{t("deployments.wizard.demoPreflight")}</li></ul> : null}
          {step === 4 ? <pre className="tech md:col-span-2 rounded-lg bg-muted p-3 text-xs">{`component: ${values.component}\nhost: ${server?.name}\nport: ${values.port}\nmode: simulation`}</pre> : null}
          {step === 5 ? (
            <Field label={t("deployments.wizard.outcome")}>
              <Select {...form.register("outcome")} value={values.outcome}><option value="success">{t("deployments.wizard.success")}</option><option value="fail">{t("deployments.wizard.fail")}</option><option value="rollback">{t("deployments.wizard.rollbackAfterTest")}</option></Select>
            </Field>
          ) : null}
          {step >= 6 && active ? (
            <div className="md:col-span-2 space-y-2 text-sm">
              <StatusBadge value={active.status} />
              {active.preflight.map((check) => <p key={check.name}>{check.ok ? t("deployments.wizard.accepted") : t("deployments.wizard.rejected")} · {copy(check.name)}: {copy(check.detail)}</p>)}
              {active.logs.map((line, index) => <p key={index} className="tech text-xs">{format.formatDateTime(line.at)} {copy(line.line)}</p>)}
            </div>
          ) : null}
          <div className="flex gap-2 md:col-span-2">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>{t("common.previous")}</Button>
            {step < 5 ? <Button type="button" onClick={() => setStep((value) => value + 1)}>{t("common.next")}</Button> : null}
            {step === 5 ? (
              <Button
                disabled={!can(user.role, "deploy.run")}
                onClick={form.handleSubmit((input) => {
                  const error = createDeploymentJob({ serverId: input.serverId, component: input.component, outcome: input.outcome, options: { port: input.port ?? "", forceConflict: input.forceConflict } });
                  void Promise.resolve(error).then((message) => {
                    if (message) toast.error(copy(message));
                    else {
                      toast.success(t("deployments.wizard.jobCreated"));
                      setStep(7);
                    }
                  });
                })}
              >
                {t("deployments.wizard.start")}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("deployments.history")}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {jobs.map((job) => (
            <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2">
              <div>
                <div>{job.component} · {servers.find((server) => server.id === job.serverId)?.name}</div>
                <div className="text-xs text-muted-foreground">{format.formatDateTime(job.createdAt)}</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge value={job.status} />
                <Button size="sm" variant="outline" disabled={!can(user.role, "deploy.run") || job.status !== "completed"} onClick={async () => { const error = await rollback(job.id); if (error) toast.error(copy(error)); else toast.success(t("deployments.rollbackSimulated")); }}>{t("deployments.rollback")}</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><Label>{label}</Label>{children}</label>;
}
