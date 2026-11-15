"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import Link from "next/link";
import { Hammer, Rocket, Settings, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmButton, Tech } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { BUNDLE_TECHS } from "@/lib/topology";
import { deleteTunnelFromInventory, deployWithAgent, listTunnelDeployments, manageTunnelDeployment, queueTunnelDeployment } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { TunnelDeployment } from "@/types";
import { ForwarderConfiguration } from "./forwarder-configuration";
import { GreTransportSettings } from "./gre-transport-settings";
import { completedCheck, deploymentChecks } from "@/lib/tunnel-deployment-progress";

const successDisplayMs = 5000;

function inProgress(run: TunnelDeployment) {
  return run.status === "deploying" || run.status === "verifying" || run.status === "rolling_back";
}

export function OperationalTunnelDeployment({ tunnelId, children }: { tunnelId?: string; children?: ReactNode }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const router = useRouter();
  const tunnels = useInfraStore((state) => state.tunnels);
  const client = useQueryClient();
  const [selection, select] = useState("");
  const [greSaving, setGreSaving] = useState(false);
  const key = ["tunnel-deployments", user.id];
  const query = useQuery({
    queryKey: [...key, tunnelId],
    queryFn: ({ signal }) => listTunnelDeployments(tunnelId, signal),
    refetchInterval: (query) => pollingInterval(query, query.state.data?.deployments.some(inProgress) ? POLLING.job : POLLING.idle),
  });
  const previews = (query.data?.previews ?? []).filter((item) => !tunnelId || item.tunnelId === tunnelId);
  const preview = previews.find((item) => item.tunnelId === selection) ?? previews[0];
  const deployments = (query.data?.deployments ?? []).filter((item) => !tunnelId || item.preview.tunnelId === tunnelId);
  const current = tunnelId ? deployments.find(inProgress) : undefined;
  const currentId = current?.id;
  const [visible, setVisible] = useState<{ activeId?: string; completedId?: string }>({});
  if (visible.activeId !== currentId) {
    const completedId = !currentId && deployments.some((run) => run.id === visible.activeId && run.status === "succeeded")
      ? visible.activeId : undefined;
    setVisible({ activeId: currentId, completedId });
  }
  const completedId = visible.completedId;
  useEffect(() => {
    if (!completedId) return;
    const timer = window.setTimeout(() => setVisible((value) =>
      value.completedId === completedId ? { activeId: value.activeId } : value), successDisplayMs);
    return () => window.clearTimeout(timer);
  }, [completedId]);
  const live = current ?? deployments.find((run) => run.id === completedId && run.status === "succeeded");
  const history = tunnelId ? deployments.filter((run) => !inProgress(run) && run.id !== live?.id) : deployments;
  const allowed = can(user.role, "deploy.run") && can(user.role, "server.configure") && can(user.role, "tunnel.mutate");
  const agentAvailable = query.data?.enabled && allowed;
  const tunnel = tunnels.find((item) => item.id === tunnelId);
  const forwarding = query.data?.forwarding;
  const automaticForwarding = tunnel && (["GOST", "Rathole", "Backhaul"].includes(tunnel.technology) || BUNDLE_TECHS.some((technology) => technology === tunnel.technology));
  const peer = tunnel?.technology === "GOST" ? tunnel.foreignEndpoint.publicIp : tunnel?.foreignEndpoint.tunnelIp;
  const busy = (iran: string, foreign: string) => (query.data?.deployments ?? []).some((run) =>
    ["deploying", "verifying", "rolling_back", "review"].includes(run.status) &&
      [run.preview.iran.serverId, run.preview.foreign.serverId].some((host) => host === iran || host === foreign));
  const refresh = () => void client.invalidateQueries({ queryKey: key });
  const start = useMutation({
    mutationFn: queueTunnelDeployment, onSuccess: (_, input) => {
      refresh();
      toast.success(input.operation === "destroy" ? t("tunnels.deployment.queuedDestroy") : input.operation === "rebuild" ? t("tunnels.deployment.queuedRebuild") : t("tunnels.deployment.queuedBoth"));
    },
    onError: (error) => toast.error(copy(error.message)),
  });
  const action = useMutation({ mutationFn: manageTunnelDeployment, onSuccess: refresh, onError: (error) => toast.error(copy(error.message)) });
  const deploy = useMutation({
    mutationFn: ({ id, operation }: { id: string; operation?: "rebuild" }) => deployWithAgent({ kind: "tunnel", tunnelId: id, operation }, crypto.randomUUID()),
    onSuccess: () => { refresh(); toast.success(t("tunnels.deployment.queuedAgent")); },
    onError: (error) => toast.error(copy(error.message)),
  });
  const removeInventory = useMutation({ mutationFn: deleteTunnelFromInventory, onSuccess: () => {
    refresh();
    router.push("/tunnels");
    toast.success(t("tunnels.deployment.removed"));
  }, onError: (error) => toast.error(copy(error.message)) });
  const active = Boolean(tunnelId && deployments.some((run) => ["deploying", "verifying", "rolling_back", "review"].includes(run.status)));
  const pending = greSaving || start.isPending || deploy.isPending || action.isPending || removeInventory.isPending || active;
  const failureText = (detail: string) => {
    const label = t(`tunnels.deployment.failure.${detail}`);
    return label === `tunnels.deployment.failure.${detail}` ? copy(detail) : label;
  };

  const renderRun = (run: TunnelDeployment, showActions: boolean) => <div className="space-y-2 rounded-lg border border-border p-3" key={run.id}>
    <div className="flex flex-wrap justify-between gap-2"><strong>{run.operation === "destroy" ? t("tunnels.deployment.destroyPrefix") : run.operation === "rebuild" ? t("tunnels.deployment.rebuildPrefix") : ""}{run.status === "rolling_back" && run.phase.endsWith("_remove") ? t("tunnels.deployment.cleaning") : run.status === "review" && run.standbyNodeId ? t("tunnels.deployment.reviewIran") : t(`tunnels.deployment.runStatus.${run.status}`)} · <Tech>{run.preview.tunnelId}</Tech></strong><span>{format.formatDateTime(run.createdAt)}</span></div>
    {run.standbyNodeId && <p>{t("tunnels.deployment.standbyFor")} <Tech>{run.standbyNodeId}</Tech> {t("tunnels.deployment.standbyReady")}</p>}
    <ul className="space-y-2">{run.steps.map(({ phase, job }) => <li key={job.id}>
      <div>{job.status === "succeeded" ? "✓ " : "○ "}{t(`tunnels.deployment.phase.${phase}`)} · {t(`tunnels.deployment.jobStatus.${job.status}`)}{job.status === "failed" && <span> · {failureText(job.detail)}</span>}</div>
      {job.operation === "apply" && <ul className="mr-4 text-muted-foreground">
        {deploymentChecks(run, phase, job).map((check) =>
          <li key={check}>{completedCheck(check, job, run) ? "✓" : "○"} {t(`tunnels.deployment.check.${check}`)}</li>)}
      </ul>}
    </li>)}</ul>
    {run.warning && <div role="alert" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p>{t(`tunnels.deployment.warning.${run.warning}`)}</p>
      <Link className="underline" href={`/servers/${encodeURIComponent(run.preview.foreign.serverId)}`}>{t("tunnels.deployment.warning.openForeign")}</Link>
    </div>}
    {run.activation && <p>{run.activation === "succeeded" ? "✓ " : "○ "}{t("tunnels.deployment.phase.dns")} · {t(`tunnels.deployment.activation.${run.activation}`)}</p>}
    {showActions && run.status === "succeeded" && <ConfirmButton confirmLabel={t("deployments.confirmOperation")} label={run.standbyNodeId ? t("tunnels.deployment.rollbackIran") : t("tunnels.deployment.rollbackBoth")} title={t("tunnels.deployment.rollbackTitle")}
      description={run.standbyNodeId ? t("tunnels.deployment.rollbackIranBody") : t("tunnels.deployment.rollbackBothBody")}
      disabled={!allowed || !query.data?.enabled || action.isPending || busy(run.preview.iran.serverId, run.preview.foreign.serverId)}
      onConfirm={() => action.mutate({ id: run.id, action: "rollback" })} />}
    {showActions && run.status === "review" && <ConfirmButton confirmLabel={t("deployments.confirmOperation")} label={run.standbyNodeId ? t("tunnels.deployment.reviewIranAction") : t("tunnels.deployment.reviewBoth")} title={t("tunnels.deployment.reviewTitle")}
      description={run.standbyNodeId ? t("tunnels.deployment.reviewIranBody") : t("tunnels.deployment.reviewBothBody")}
      disabled={!allowed || !query.data?.enabled || action.isPending} onConfirm={() => action.mutate({ id: run.id, action: "review" })} />}
  </div>;

  return <div className="space-y-4">
    {tunnelId && tunnel?.technology === "GRE" && <GreTransportSettings tunnelId={tunnelId}
      transport={tunnel.config.greTransport === "native" ? "native" : "udp"} disabled={!allowed || Boolean(pending)} onSaving={setGreSaving} />}
    {tunnelId && tunnel && ["Rathole", "Backhaul"].includes(tunnel.technology) && <ForwarderConfiguration tunnelId={tunnelId} disabled={!allowed || pending} />}
    {tunnelId && tunnel && <div className="flex flex-wrap items-center gap-2" aria-label={t("tunnels.deployment.actions")}>
      {agentAvailable && automaticForwarding && tunnel.technology === "WireGuard" ? <Button asChild size="icon" variant="outline">
        <Link href={`/deployments?mode=tunnel&tunnelId=${encodeURIComponent(tunnelId)}`} aria-label={t("tunnels.deployment.deployAgent")} title={t("tunnels.deployment.deployAgent")}><Rocket /></Link>
      </Button> : <ConfirmButton icon={<Rocket />} label={t("tunnels.deployment.deployAgent")} title={t("tunnels.deployment.deployTitle")} confirmLabel={t("tunnels.deployment.deployConfirm")}
        description={t("tunnels.deployment.deployBody")}
        disabled={!agentAvailable || pending || (!automaticForwarding && !preview)}
        onConfirm={() => automaticForwarding ? deploy.mutate({ id: tunnelId }) : preview && start.mutate({ tunnelId, fingerprint: preview.fingerprint })} />}
      <ConfirmButton icon={<Hammer />} destructive label={t("tunnels.deployment.teardown")} title={t("tunnels.deployment.teardownTitle")} confirmLabel={t("tunnels.deployment.teardown")}
        description={t("tunnels.deployment.teardownBody")}
        disabled={!allowed || !query.data?.enabled || !query.data.hasManagedInstall || pending}
        onConfirm={() => start.mutate({ tunnelId, operation: "destroy" })} />
      <ConfirmButton icon={<Settings />} label={t("tunnels.deployment.rebuild")} title={t("tunnels.deployment.rebuildTitle")} confirmLabel={t("tunnels.deployment.rebuild")}
        description={t("tunnels.deployment.rebuildBody")}
        disabled={!allowed || !query.data?.enabled || !preview || pending}
        onConfirm={() => {
          if (automaticForwarding && tunnel.technology !== "WireGuard") deploy.mutate({ id: tunnelId, operation: "rebuild" });
          else if (preview) start.mutate({ tunnelId, operation: "rebuild", fingerprint: preview.fingerprint });
        }} />
      <ConfirmButton icon={<Trash2 />} destructive label={t("tunnels.deployment.deletePanel")} title={t("tunnels.deployment.deletePanelTitle")} confirmLabel={t("tunnels.deployment.deletePanel")}
        description={t("tunnels.deployment.deletePanelBody")}
        disabled={!can(user.role, "tunnel.delete") || !query.data || start.isPending || deploy.isPending || action.isPending || removeInventory.isPending}
        onConfirm={() => removeInventory.mutate(tunnelId)} />
      {query.isError && !query.data && <p className="text-destructive">{copy(query.error.message)}</p>}
    </div>}
    {!tunnelId && <Card>
      <CardHeader><CardTitle>{t("tunnels.deployment.coordinated")}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {query.isPending && <p>{t("tunnels.deployment.loading")}</p>}
        {query.isError && <p className="text-destructive">{copy(query.error.message)} <Button variant="outline" onClick={() => void query.refetch()}>{t("common.retry")}</Button></p>}
        {query.data && !query.data.enabled && <p>{t("tunnels.deployment.disabled")}</p>}
        {agentAvailable && <Button asChild variant="outline"><Link href="/deployments?mode=tunnel">{t("tunnels.deployment.configure")}</Link></Button>}
        {query.data?.enabled && !preview && <p>{t("tunnels.deployment.noBundle")}</p>}
        {forwarding?.error && <p className="text-destructive">{copy(forwarding.error)}</p>}
        {automaticForwarding && forwarding?.port && peer && <p>{t("tunnels.deployment.tcpFrom")} <Tech>{forwarding.port}</Tech> {t("tunnels.deployment.tcpTo")} <Tech>{peer.includes(":") ? `[${peer}]` : peer}:{forwarding.targetPort ?? forwarding.port}</Tech></p>}
        {preview && <>
          {!tunnelId && <Select aria-label={t("tunnels.deployment.target")} value={preview.tunnelId} onChange={(event) => select(event.target.value)}>
            {previews.map((item) => <option key={item.tunnelId} value={item.tunnelId}>{tunnels.find((tunnel) => tunnel.id === item.tunnelId)?.name ?? item.tunnelId} · {item.technology}</option>)}
          </Select>}
          <div className="grid gap-2 md:grid-cols-2">
            {([{ label: t("tunnels.deployment.foreign"), profile: preview.foreign }, { label: t("tunnels.deployment.iran"), profile: preview.iran }]).map(({ label, profile }) =>
              <div key={profile.serverId} className="space-y-1 rounded-lg bg-muted p-3">
                <strong>{label} · <Tech>{profile.serverId}</Tech></strong>
                <p><Tech>{profile.id}</Tech> · {t("tunnels.deployment.version")} <Tech>{profile.version}</Tech></p>
                <p className="break-all"><Tech>{profile.sha256}</Tech></p>
                <p>{copy(profile.summary)}</p>
              </div>)}
          </div>
          <p className="text-muted-foreground">{t("tunnels.deployment.afterInstall")}</p>
          <ConfirmButton confirmLabel={t("deployments.confirmOperation")} label={t("tunnels.deployment.register")} title={t("tunnels.deployment.confirmTitle")} description={t("tunnels.deployment.confirmBody")}
            disabled={!allowed || pending || busy(preview.iran.serverId, preview.foreign.serverId)}
            onConfirm={() => start.mutate({ tunnelId: preview.tunnelId, fingerprint: preview.fingerprint })} />
        </>}
      </CardContent>
    </Card>}
    {live && <Card role="region" aria-label={t("tunnels.deployment.active")} aria-live="polite">
      <CardHeader><CardTitle>{t("tunnels.deployment.active")}</CardTitle></CardHeader>
      <CardContent className="text-sm">{renderRun(live, false)}</CardContent>
    </Card>}
    {children}
    <Card role="region" aria-label={t("tunnels.deployment.history")}>
      <CardHeader><CardTitle>{t("tunnels.deployment.history")}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {query.data && !history.length && <p>{t("tunnels.deployment.historyEmpty")}</p>}
        {history.map((run) => renderRun(run, true))}
      </CardContent>
    </Card>
  </div>;
}
