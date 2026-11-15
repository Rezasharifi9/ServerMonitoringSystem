"use client";

import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { useServerOperations } from "@/services/backend";
import type { Server } from "@/types";

export function useServerActivity(server: Server) {
  return useServerOperations((state) => state.active[server.id]) || server.activity;
}

export function ServerActivity({ server }: { server: Server }) {
  const activity = useServerActivity(server);
  const { locale } = useI18n();
  const labels: Record<string, [string, string]> = {
    agent: ["در حال نصب Nord Agent", "Installing Nord Agent"], ssh: ["در حال آماده‌سازی SSH", "Preparing SSH"],
    tunnel: ["در حال اجرای عملیات تونل", "Tunnel operation in progress"], v2bx: ["در حال نصب V2bX", "Installing V2bX"],
    apply: ["در حال نصب و پیکربندی", "Installing and configuring"],
    "remove-v2bx": ["در حال حذف V2bX", "Removing V2bX"], "restart-v2bx": ["در حال راه‌اندازی مجدد V2bX", "Restarting V2bX"],
    reboot: ["در حال راه‌اندازی مجدد سرور", "Rebooting server"], remove: ["در حال حذف", "Removing"],
    rollback: ["در حال بازگردانی تنظیمات", "Rolling back"],
  };
  const fa = locale === "fa-IR";
  return activity ? <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap text-sm text-amber-500">
    <LoaderCircle className="size-4 animate-spin" />{labels[activity]?.[fa ? 0 : 1] ?? (fa ? "در حال انجام عملیات" : "Operation in progress")}
  </span> : <span className="text-sm text-muted-foreground">{fa ? "آماده" : "Ready"}</span>;
}
