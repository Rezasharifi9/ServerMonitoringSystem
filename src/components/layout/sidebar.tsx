"use client";

import Link from "next/link";
import { useContext } from "react";
import { AdminMode } from "./session-mode";
import { usePathname } from "next/navigation";
import { Shield } from "lucide-react";
import { NAV } from "@/components/layout/nav";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const adminMode = useContext(AdminMode);
  const { t } = useI18n();
  return (
    <div className="workspace-sidebar flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="sidebar-brand flex items-center gap-3 px-5 py-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <div className="font-semibold">NodeGuard</div>
          <div className="text-xs text-muted-foreground">{t("common.appSubtitle")}</div>
        </div>
      </div>
      <nav aria-label={t("common.navigation")} className="flex-1 space-y-1.5 overflow-y-auto p-3">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              prefetch={false}
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "sidebar-link flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors",
                active ? "sidebar-link-active bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer m-3 rounded-xl border border-border p-4 text-xs text-muted-foreground">{adminMode ? t("common.administration") : t("common.demoVersion")}</div>
    </div>
  );
}
