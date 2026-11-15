"use client";

import { POLLING, pollingInterval } from "@/lib/polling";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Tech } from "@/components/shared/chrome";
import { useFormat, useI18n } from "@/i18n/provider";
import { getObservedLogs } from "@/services/backend";
import type { LogEntry } from "@/types";

function LogSection({ entries, pending, failed }: { entries?: LogEntry[]; pending: boolean; failed: boolean }) {
  const { t, copy } = useI18n();
  const format = useFormat();
  if (pending) return <p role="status" className="text-sm text-muted-foreground">{t("nodes.logs.loading")}</p>;
  if (failed) return <p role="alert" className="text-sm text-destructive">{t("nodes.logs.failed")}</p>;
  if (!entries?.length) return <p className="text-sm text-muted-foreground">{t("nodes.logs.empty")}</p>;
  return entries.slice().reverse().map((entry) =>
    <p key={entry.id} className="break-all text-xs"><Tech>{format.formatDateTime(entry.ts)} [{entry.severity}]</Tech> {copy(entry.message)}</p>);
}

export function NodeLogPreview({ nodeId, serverId }: { nodeId: string; serverId: string }) {
  const { t } = useI18n();
  const node = useQuery({
    queryKey: ["node-log-preview", nodeId],
    queryFn: () => getObservedLogs({ nodeId, source: "v2bx-node", limit: 12 }),
    refetchInterval: (query) => pollingInterval(query, POLLING.preview),
  });
  const shared = useQuery({
    queryKey: ["shared-log-preview", serverId],
    queryFn: () => getObservedLogs({ serverId, source: "v2bx-shared", limit: 6 }),
    refetchInterval: (query) => pollingInterval(query, POLLING.preview),
  });
  return <div className="space-y-3">
    <h3 className="font-medium">{t("nodes.logs.node")}</h3>
    <LogSection entries={node.data?.data} pending={node.isPending} failed={node.isError} />
    <h3 className="pt-2 font-medium">{t("nodes.logs.shared")}</h3>
    <LogSection entries={shared.data?.data} pending={shared.isPending} failed={shared.isError} />
    <Link className="text-sm text-primary" href={`/servers/${encodeURIComponent(serverId)}#v2bx-logs`}>{t("nodes.logs.v2bxHistory")}</Link>
  </div>;
}
