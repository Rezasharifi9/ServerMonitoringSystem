"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/shared/chrome";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { can } from "@/lib/rbac";
import { importV2BoardNode, listV2BoardNodes, refreshProvider } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import type { V2BoardCatalogEntry } from "@/types";

export function useV2BoardCatalog(enabled: boolean) {
  const user = useCurrentUser();
  return useQuery({
    queryKey: ["v2board-catalog", user.id],
    queryFn: listV2BoardNodes,
    enabled,
    refetchInterval: (query) => pollingInterval(query, query.state.data?.inProgress ? POLLING.job : query.state.data?.automatic ? POLLING.inventory : false),
  });
}

export function V2BoardInventory({ catalog }: { catalog: ReturnType<typeof useV2BoardCatalog> }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const { data, refetch } = catalog;
  const sync = useMutation({
    mutationFn: async () => {
      const error = await refreshProvider("v2board/sync");
      if (error) throw new Error(error);
    },
    onSuccess: async () => {
      await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: ["v2board-admin-nodes"] })]);
      toast.success(t("nodes.inventory.updated"));
    },
    onError: (error) => { void refetch(); toast.error(copy(error.message)); },
  });

  return <Card className="mb-4">
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
      <CardTitle>{t("nodes.inventory.title")}</CardTitle>
      <Button variant="outline" disabled={!data?.enabled || !can(user.role, "integration.edit") || sync.isPending || data.inProgress} onClick={() => sync.mutate()}>
        {sync.isPending || data?.inProgress ? t("nodes.inventory.reading") : t("nodes.inventory.sync")}
      </Button>
    </CardHeader>
    <CardContent className="space-y-2 text-sm">
      {catalog.isPending && <p>{t("nodes.inventory.loading")}</p>}
      {catalog.isError && <p className="text-destructive">{copy(catalog.error.message)} <Button variant="outline" onClick={() => void refetch()}>{t("common.retry")}</Button></p>}
      {data && !data.enabled && <p>{t("nodes.inventory.disabled")}</p>}
      {data?.enabled && !data.syncedAt && <p>{t("nodes.inventory.waiting")}</p>}
      {data?.syncedAt && <p className="text-muted-foreground">{t("nodes.inventory.last", { time: format.formatDateTime(data.syncedAt), count: data.nodes.length })}</p>}
      {data?.automatic && <p className="text-muted-foreground">
        {data.intervalSec === null ? t("nodes.inventory.invalidInterval") :
          <>{t("nodes.inventory.every", { seconds: data.intervalSec })}{data.nextSyncAt && !data.inProgress && t("nodes.inventory.next", { time: format.formatDateTime(data.nextSyncAt) })}</>}
      </p>}
      {data?.lastError && <p role="status" className="text-destructive">{t("nodes.inventory.failed")} {data.syncedAt && t("nodes.inventory.staleShown")}</p>}
      {data?.stale && <p className="text-destructive">{t("nodes.inventory.resync")}</p>}
    </CardContent>
  </Card>;
}

export function ImportPanelNode({ entry, onDone, onCancel }: { entry: V2BoardCatalogEntry; onDone: () => void; onCancel: () => void }) {
  const { t, copy } = useI18n();
  const tunnels = useInfraStore((state) => state.tunnels);
  const suggested = tunnels.find((item) => item.side === "primary" && item.nodeRef?.kind === "v2board" && item.nodeRef.key === entry.key);
  const [domain, setDomain] = useState(entry.host);
  const [primaryId, setPrimary] = useState("");
  const candidates = tunnels.filter((item) => item.side === "primary");
  const primary = candidates.find((item) => item.id === primaryId) ?? suggested ?? candidates[0];
  const mutation = useMutation({
    mutationFn: importV2BoardNode,
    onSuccess: () => { onDone(); toast.success(t("nodes.inventory.registered")); },
    onError: (error) => toast.error(copy(error.message)),
  });
  return <div className="grid gap-3 rounded-lg bg-muted p-3">
    <strong className="font-medium">{entry.name || entry.key}</strong>
    <label className="space-y-1">{t("nodes.inventory.monitorDomain")}<Input className="tech" value={domain} onChange={(event) => setDomain(event.target.value)} /></label>
    <label className="space-y-1">{t("nodes.inventory.primaryTunnel")}<Select value={primary?.id ?? ""} onChange={(event) => { setPrimary(event.target.value); }}>
      {!candidates.length && <option value="">{t("nodes.inventory.noPrimary")}</option>}
      {candidates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </Select></label>
    <div className="flex flex-wrap gap-2">
      <ConfirmButton label={t("nodes.inventory.register")} confirmLabel={t("nodes.inventory.registerNode")} title={t("nodes.inventory.importTitle")}
        description={t("nodes.inventory.importBody")}
        disabled={!primary || !domain.trim() || mutation.isPending}
        onConfirm={() => { if (primary) mutation.mutate({ key: entry.key, fingerprint: entry.fingerprint,
          domain: domain.trim(), primaryTunnelId: primary.id }); }} />
      <Button variant="ghost" onClick={onCancel}>{t("nodes.inventory.close")}</Button>
    </div>
  </div>;
}
