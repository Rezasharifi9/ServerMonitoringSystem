"use client";

import { POLLING, pollingInterval, jobActive } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { getAgentUpdates, updateAllAgents } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";
import { serverIdentifier } from "@/lib/server-inventory";

export function AgentUpdateSettings() {
  const { t, copy } = useI18n();
  const servers = useInfraStore((state) => state.servers);
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["agent-updates"], queryFn: getAgentUpdates, refetchInterval: (query) => pollingInterval(query, query.state.data?.jobs.some(jobActive) ? POLLING.job : POLLING.idle) });
  const mutation = useMutation({ mutationFn: updateAllAgents,
    onSuccess: () => void client.invalidateQueries({ queryKey: ["agent-updates"] }),
    onError: (error) => toast.error(copy(error.message)),
  });
  const busy = mutation.isPending || query.data?.jobs.some((job) => ["queued", "running"].includes(job.status));
  return <Card>
    <CardHeader><CardTitle>{t("settings.agent.title")}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p>{t("settings.agent.bundleVersion", { version: query.data?.version ?? "—" })}</p>
      <p className="text-sm text-muted-foreground">{t("settings.agent.hint")}</p>
      {query.isError && <p role="alert">{copy(query.error.message)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !query.data?.enabled} onClick={() => mutation.mutate(false)}>{t("settings.agent.updateAll")}</Button>
        <Button variant="outline" disabled={busy || !query.data?.enabled || !query.data?.jobs.some((job) => job.status === "failed")}
          onClick={() => mutation.mutate(true)}>{t("settings.agent.retryFailed")}</Button>
      </div>
      <div className="space-y-2">
        {servers.map((server) => {
          const job = query.data?.jobs.find((item) => item.serverId === server.id);
          return <div key={server.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3 text-sm">
            <span><bdi>{serverIdentifier(server)}</bdi> · {t("settings.agent.hostVersion", { version: server.agent.version || "—" })}</span>
            {job && <span role="status">{t(`settings.agent.status.${job.status}`)}
              {job.status === "succeeded" && !job.reporting && ` · ${t("settings.agent.awaitingTelemetry")}`}
              {job.detail && ` · ${copy(job.detail)}`}</span>}
          </div>;
        })}
      </div>
    </CardContent>
  </Card>;
}
