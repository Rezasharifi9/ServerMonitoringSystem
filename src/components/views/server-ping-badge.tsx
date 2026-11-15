"use client";

import { StatusBadge } from "@/components/shared/status-badge";
import { useFormat, useI18n } from "@/i18n/provider";
import { useBackend, useServerPing } from "@/services/backend";
import type { Server } from "@/types";

const pingTone = {
  reachable: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  unreachable: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  unavailable: undefined,
};

export function ServerPingBadge({ server }: { server: Server }) {
  const { t } = useI18n();
  const format = useFormat();
  const monitor = useBackend((state) => state.mode === "monitor");
  const ping = useServerPing(server, monitor);
  if (!monitor) return <StatusBadge value={server.status} />;
  if (ping.isError) return <StatusBadge value={t("servers.ping.unavailable")} />;
  if (!ping.data) return <StatusBadge value={t("servers.ping.checking")} />;
  const label = t(`servers.ping.${ping.data.status}`);
  const text = ping.data.rttMs === undefined ? label : t("servers.ping.withRtt", { status: label, rtt: format.formatMs(ping.data.rttMs) });
  return <span className="whitespace-nowrap" title={t("servers.ping.lastFromPanel", { time: format.formatDateTime(ping.data.checkedAt) })}>
    <StatusBadge value={text} className={pingTone[ping.data.status]} />
  </span>;
}
