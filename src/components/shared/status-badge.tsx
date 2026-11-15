"use client";

import type { HealthStatus } from "@/types";
import { Badge } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const tone: Record<string, string> = {
  healthy: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  running: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  online: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  connected: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  matched: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  completed: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  success: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  RECOVERED: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  HEALTHY: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  degraded: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  warning: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  propagation: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  stale: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  proxied: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  cname: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  silenced: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  info: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  offline: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  stopped: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  critical: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  failed: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  error: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  mismatched: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  FAILED: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  disconnected: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  SUSPECT: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  CONFIRMED_DOWN: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  PREPARING_BACKUP: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  SWITCHING: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  VERIFYING: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  ROLLBACK: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  restarting: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  pending: "bg-muted text-muted-foreground ring-border",
  validating: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  installing: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  configuring: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  testing: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  "rolled-back": "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  ack: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  resolved: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  open: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
};

export function StatusBadge({ value, className }: { value: string; className?: string }) {
  const { t } = useI18n();
  const key = `common.status.${value}`;
  const label = t(key);
  return <Badge className={cn(tone[value] ?? "bg-muted text-muted-foreground ring-border", className)}>{label === key ? value : label}</Badge>;
}

export function HealthDot({ status }: { status: HealthStatus | string }) {
  const color = status === "healthy" || status === "running" || status === "online" ? "bg-emerald-400" : status === "degraded" ? "bg-amber-400" : "bg-rose-400";
  return <span className={cn("inline-block h-2.5 w-2.5 rounded-full", color)} />;
}
