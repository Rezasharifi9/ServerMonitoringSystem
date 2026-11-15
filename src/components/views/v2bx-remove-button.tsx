"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Select } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useI18n } from "@/i18n/provider";
import { getV2bxRemove, listServerV2bxNodes, removeV2bx, syncBackend } from "@/services/backend";

export function RemoveV2bxButton({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { t, copy } = useI18n();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const client = useQueryClient();
  const admin = useQuery({
    queryKey: ["server-v2bx-nodes", serverId],
    queryFn: () => listServerV2bxNodes(serverId),
    enabled: open,
    refetchInterval: (query) => pollingInterval(query, open ? POLLING.preview : false),
    retry: false,
  });
  const nodes = (admin.data?.nodes ?? []).filter((node) => !node.fields.parent_id).map((node) => ({
    reference: `${node.type}:${node.id}`,
    name: String(node.fields.name || `${node.type}:${node.id}`),
  }));
  const node = nodes.find((item) => item.reference === selected);
  const query = useQuery({
    queryKey: ["v2bx-remove", serverId, selected],
    queryFn: () => getV2bxRemove(serverId, selected),
    enabled: open && admin.isSuccess && Boolean(node),
    refetchInterval: (query) => pollingInterval(query, open ? POLLING.preview : false),
  });
  const mutation = useMutation({
    mutationFn: (panelNode: string) => removeV2bx(serverId, panelNode),
    onSuccess: (job, panelNode) => {
      const key = ["v2bx-remove", serverId, panelNode];
      client.setQueryData(key, { ready: true, job });
      void client.invalidateQueries({ queryKey: key });
      void syncBackend();
      toast.success(t("servers.detail.removeV2bxQueued"));
    },
    onError: (error) => toast.error(copy(error.message)),
  });
  const job = query.data?.job;
  const busy = Boolean(job && (job.status === "queued" || job.status === "running" || job.status === "review"));
  return <>
    <Button variant="outline" onClick={() => {
      setSelected("");
      setOpen(true);
    }}>{t("servers.detail.removeV2bx")}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t("servers.detail.removeV2bx")}>
        <div className="space-y-3 text-sm">
          <p>{t("servers.detail.removeV2bxServer", { server: serverName })}</p>
          {admin.isPending && <p>{t("nodes.list.loadingAdmin")}</p>}
          {admin.isError && <p role="alert" className="text-destructive">
            {copy(admin.error.message)} <Button size="sm" variant="outline" onClick={() => void admin.refetch()}>{t("common.retry")}</Button>
          </p>}
          {admin.isSuccess && (nodes.length ? <label className="block space-y-1">{t("servers.detail.removeV2bxNode")}
            <Select aria-label={t("servers.detail.removeV2bxNode")} value={node?.reference ?? ""} disabled={mutation.isPending}
              onChange={(event) => setSelected(event.target.value)}>
              <option value="" disabled>{t("servers.detail.removeV2bxChooseNode")}</option>
              {nodes.map((item) => <option key={item.reference} value={item.reference}>{item.name} ({item.reference})</option>)}
            </Select>
          </label> : <p>{t("servers.detail.removeV2bxNoNodes")}</p>)}
          {node && <p className="leading-7 text-muted-foreground">{t("servers.detail.removeV2bxBody", { name: node.name })}</p>}
          {query.isError && <p role="alert" className="text-destructive">{copy(query.error.message)}</p>}
          {query.data && !query.data.ready && <p>{t("servers.detail.removeV2bxNeedsAgent")}</p>}
          {job && <p>{t(`deployments.operational.status.${job.status}`)}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" disabled={!node || !admin.isSuccess || query.isError || !query.data?.ready || busy || mutation.isPending}
              onClick={() => { if (node) mutation.mutate(node.reference); }}>{t("servers.detail.removeV2bx")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
