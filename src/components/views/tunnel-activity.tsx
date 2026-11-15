"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Circle, LoaderCircle } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { POLLING, jobActive, pollingInterval } from "@/lib/polling";
import { completedCheck, deploymentChecks } from "@/lib/tunnel-deployment-progress";
import { listTunnelDeployments, useBackend, useServerOperations } from "@/services/backend";
import { useCurrentUser } from "@/stores/infra-store";
import type { Tunnel } from "@/types";

export function TunnelActivity({ tunnel }: { tunnel: Tunnel }) {
  const { t, locale } = useI18n();
  const monitor = useBackend((state) => state.mode === "monitor");
  const user = useCurrentUser();
  const local = useServerOperations((state) => state.active[tunnel.iranEndpoint.serverId] || state.active[tunnel.foreignEndpoint.serverId]);
  // All table rows share one request and one polling cache.
  const query = useQuery({
    queryKey: ["tunnel-deployments", user.id, "activity"],
    queryFn: ({ signal }) => listTunnelDeployments(undefined, signal),
    enabled: monitor,
    refetchInterval: (query) => pollingInterval(query,
      local || query.state.data?.deployments.some(jobActive) ? POLLING.job : POLLING.workspace),
  });
  if (!monitor) return null;
  const run = query.data?.deployments.find((item) => item.preview.tunnelId === tunnel.id);
  const active = Boolean(run && jobActive(run));
  const fa = locale === "fa-IR";
  const text = local ? (fa ? "در حال آماده‌سازی عملیات تونل" : "Preparing tunnel operation")
    : run ? run.status === "succeeded" ? (fa ? "آماده · استقرار و بررسی تونل کامل شد" : "Ready · Tunnel deployment verified")
      : active ? `${t(`tunnels.deployment.runStatus.${run.status}`)} · ${t(`tunnels.deployment.phase.${run.phase}`)}`
      : t(`tunnels.deployment.runStatus.${run.status}`)
    : query.isError ? (fa ? "دریافت وضعیت عملیات ناموفق بود" : "Could not load operation status")
    : query.isPending ? (fa ? "در حال دریافت وضعیت" : "Loading operation status") : (fa ? "آماده" : "Ready");
  const Icon = active || local ? LoaderCircle : run?.status === "succeeded" ? Check : Circle;
  return <div className="space-y-1 text-xs" aria-live="polite">
    <div role="status" className={`flex items-center gap-1 ${active || local ? "text-amber-500" : "text-muted-foreground"}`}>
      <Icon className={`size-3 shrink-0 ${active || local ? "animate-spin" : ""}`} /><span>{text}</span>
    </div>
    {run && <details key={run.id} open={active} className="max-w-sm whitespace-normal">
      <summary className="cursor-pointer text-muted-foreground">{fa ? "مراحل عملیات" : "Operation steps"}</summary>
      <ul className="mt-1 space-y-1">
        {run.steps.map(({ phase, job }) => <li key={job.id}>
          <div>{job.status === "succeeded" ? "✓" : job.status === "failed" ? "✕" : "○"} {t(`tunnels.deployment.phase.${phase}`)} · {t(`tunnels.deployment.jobStatus.${job.status}`)}</div>
          {job.operation === "apply" && <ul className="ps-3 text-muted-foreground">
            {deploymentChecks(run, phase, job).map((check) => <li key={check}>
              {completedCheck(check, job, run) ? "✓" : "○"} {t(`tunnels.deployment.check.${check}`)}
            </li>)}
          </ul>}
        </li>)}
        <li>{run.status === "succeeded" ? "✓" : "○"} {t("tunnels.deployment.phase.verify")}</li>
      </ul>
    </details>}
  </div>;
}
