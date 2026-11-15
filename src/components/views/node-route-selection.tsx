"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { selectNodeRoutes } from "@/services/backend";
import type { Node, Tunnel } from "@/types";

export function NodeRouteSelection({ node, tunnels }: { node: Node; tunnels: Tunnel[] }) {
  const { t, copy } = useI18n();
  const [primary, setPrimary] = useState(node.primaryTunnelId);
  const [backup, setBackup] = useState(node.backupTunnelId ?? "");
  const [side, setSide] = useState(node.activeSide);
  const linked = tunnels.filter((tunnel) => node.tunnelIds?.includes(tunnel.id) || tunnel.nodeIds.includes(node.id));
  const mutation = useMutation({ mutationFn: () => selectNodeRoutes(node.id, { primaryTunnelId: primary, backupTunnelId: backup || undefined, activeSide: side }),
    onSuccess: () => toast.success(t("nodes.routes.saved")), onError: (error) => toast.error(copy(error.message)) });
  return <Card className="mb-4"><CardHeader><CardTitle>{t("nodes.routes.title")}</CardTitle></CardHeader>
    <CardContent><form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <p className="text-sm text-muted-foreground md:col-span-2">{t("nodes.routes.hint")}</p>
      <label>{t("nodes.routes.primary")}<Select value={primary} disabled={mutation.isPending} onChange={(event) => { setPrimary(event.target.value); if (event.target.value === backup) setBackup(primary); setSide("primary"); }}>
        {linked.map((tunnel) => <option key={tunnel.id} value={tunnel.id}>{tunnel.name} · {tunnel.technology} · {tunnel.iranEndpoint.publicIp}</option>)}
      </Select></label>
      <label>{t("nodes.routes.backup")}<Select value={backup} disabled={mutation.isPending} onChange={(event) => { setBackup(event.target.value); if (!event.target.value) setSide("primary"); }}>
        <option value="">{t("nodes.routes.none")}</option>
        {linked.filter((tunnel) => tunnel.id !== primary && tunnel.foreignEndpoint.serverId === linked.find((item) => item.id === primary)?.foreignEndpoint.serverId && tunnel.iranEndpoint.serverId !== linked.find((item) => item.id === primary)?.iranEndpoint.serverId).map((tunnel) => <option key={tunnel.id} value={tunnel.id}>{tunnel.name} · {tunnel.technology} · {tunnel.iranEndpoint.publicIp}</option>)}
      </Select></label>
      <label>{t("nodes.routes.active")}<Select value={side} disabled={mutation.isPending} onChange={(event) => setSide(event.target.value as "primary" | "backup")}>
        <option value="primary">{t("nodes.routes.primary")}</option><option value="backup" disabled={!backup}>{t("nodes.routes.backup")}</option>
      </Select></label>
      <Button type="submit" disabled={!primary || mutation.isPending}>{t("nodes.routes.apply")}</Button>
    </form></CardContent></Card>;
}
