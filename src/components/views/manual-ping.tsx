"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/kit";
import { useFormat, useI18n } from "@/i18n/provider";
import { checkHostPing, requestTunnelPing } from "@/services/backend";

export function CheckHostPing({ serverId }: { serverId: string }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const probe = useMutation({ mutationFn: () => checkHostPing(serverId) });
  return <Card><CardHeader><CardTitle>{t("speedtest.ping.checkHostTitle")}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
    <Button variant="outline" disabled={probe.isPending} onClick={() => probe.mutate()}>{probe.isPending ? t("speedtest.ping.probing") : t("speedtest.ping.fromCheckHost")}</Button>
    {probe.error && <p role="alert">{copy(probe.error.message)}</p>}
    {probe.data?.map((row) => <p key={row.node}><bdi>{row.location || row.node}</bdi> · <span className="tech">{row.rttMs === null ? "—" : format.formatMs(row.rttMs)}</span> · {t("speedtest.ping.loss")} <span className="tech">{row.packetLoss === null ? "—" : format.formatPercent(row.packetLoss, 1)}</span></p>)}
  </CardContent></Card>;
}

export function TunnelPing({ tunnelId, editable }: { tunnelId: string; editable: boolean }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  const client = useQueryClient();
  const key = ["tunnel-ping", tunnelId];
  const query = useQuery({ queryKey: key, queryFn: () => requestTunnelPing(tunnelId),
    refetchInterval: (query) => pollingInterval(query, query.state.data?.status === "pending" ? POLLING.job : false) });
  const probe = useMutation({ mutationFn: () => requestTunnelPing(tunnelId, true), onSuccess: (data) => client.setQueryData(key, data) });
  const reading = query.data;
  const result = reading?.result;
  const measurement = result
    ? t("speedtest.ping.result", {
      rtt: result.rttMs === null ? "—" : format.formatMs(result.rttMs),
      jitter: result.jitterMs === null ? "—" : format.formatMs(result.jitterMs),
      loss: format.formatPercent(result.packetLoss, 1),
    })
    : t("speedtest.ping.interfaceUnavailable");
  return <Card><CardHeader><CardTitle>{t("speedtest.ping.tunnelTitle")}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
    <Button variant="outline" disabled={!editable || probe.isPending || reading?.status === "pending"} onClick={() => probe.mutate()}>{t("speedtest.ping.tunnelPing")}</Button>
    {reading?.status === "pending" && <p role="status">{t("speedtest.ping.waiting")}</p>}
    {reading?.status === "expired" && <p>{t("speedtest.ping.expired")}</p>}
    {reading?.status === "complete" && <p dir="ltr">{measurement}</p>}
    {(probe.error || query.error) && <p role="alert">{copy((probe.error ?? query.error)?.message ?? "")}</p>}
  </CardContent></Card>;
}
