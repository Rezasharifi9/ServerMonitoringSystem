"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useContext, useMemo, useState } from "react";
import { AdminMode } from "./session-mode";
import { Bell, Menu, Moon, Search, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { crumbsFor } from "@/components/layout/nav";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { Sidebar } from "@/components/layout/sidebar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/kit";
import { Dialog, DialogContent, SearchableMenu } from "@/components/ui/overlays";
import { BackendSession } from "@/components/layout/backend-session";
import { useI18n } from "@/i18n/provider";
import { disconnectBackend, useBackend } from "@/services/backend";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";

export function Header() {
  const pathname = usePathname();
  const adminMode = useContext(AdminMode);
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  const user = useCurrentUser();
  const users = useInfraStore((state) => state.users);
  const switchUser = useInfraStore((state) => state.switchUser);
  const resetDemo = useInfraStore((state) => state.resetDemo);
  const alerts = useInfraStore((state) => state.alerts);
  const nodes = useInfraStore((state) => state.nodes);
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const dns = useInfraStore((state) => state.dns);
  const integrations = useInfraStore((state) => state.integrations);
  const [loginOpen, setLoginOpen] = useState(false);
  const backend = useBackend();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const crumbs = crumbsFor(pathname);
  const unread = alerts.filter((alert) => !alert.archived && !alert.resolved && !alert.acked).length;
  const panel = integrations.find((item) => item.type === "v2board");
  const offlineAgents = servers.filter((server) => server.agent.status === "offline").length;
  const connection = panel?.status === "connected" && offlineAgents === 0 ? "connected" : offlineAgents > 0 ? "degraded" : panel?.status ?? "disconnected";
  const roleName = (role: string) => t(`common.roles.${role}`);
  const accountItems = backend.actor ? [{
    label: t("common.signOut"),
    onSelect: () => void disconnectBackend().then(() => {
      if (adminMode) window.location.replace("/login");
    }).catch(() => toast.error(t("common.signOutFailed"))),
  }] : adminMode ? [] : [
    ...users.map((item) => ({
      id: item.id,
      label: `${item.name} · ${roleName(item.role)}`,
      onSelect: () => { switchUser(item.id); toast.success(t("common.demoRole", { role: roleName(item.role) })); },
    })),
    { label: t("common.backendSignIn"), onSelect: () => setLoginOpen(true) },
    { label: t("common.resetDemo"), onSelect: () => setResetOpen(true) },
  ];
  const modeLabel = !backend.actor
    ? t("common.demoMode")
    : backend.status === "error"
      ? t("common.backendError")
      : backend.mode === "monitor"
        ? t("common.backendMonitor")
        : t("common.backendDemo");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return [
      ...nodes.filter((node) => `${node.id} ${node.name} ${node.domain}`.toLowerCase().includes(q)).slice(0, 4).map((node) => ({ href: `/nodes/${node.id}`, label: node.name, meta: node.domain })),
      ...servers.filter((server) => `${server.name} ${server.publicIpv4}`.toLowerCase().includes(q)).slice(0, 3).map((server) => ({ href: `/servers/${server.id}`, label: server.name, meta: server.publicIpv4 })),
      ...tunnels.filter((tunnel) => tunnel.name.toLowerCase().includes(q)).slice(0, 3).map((tunnel) => ({ href: `/tunnels/${tunnel.id}`, label: tunnel.name, meta: tunnel.technology })),
      ...(backend.mode === "monitor" ? [] : dns.filter((record) => record.domain.toLowerCase().includes(q)).slice(0, 3).map((record) => ({ href: `/dns/${record.nodeId}`, label: record.domain, meta: "DNS" }))),
    ].slice(0, 8);
  }, [backend.mode, dns, nodes, query, servers, tunnels]);

  return (
    <header className="workspace-header sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="header-controls flex flex-wrap items-center gap-2 px-4 py-3 md:gap-3 md:px-8">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMenuOpen(true)} aria-label={t("common.menu")}>
          <Menu className="h-5 w-5" />
        </Button>
        <div className="header-search relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("common.searchPlaceholder")}
            aria-label={t("common.searchPlaceholder")}
            className="h-10 w-full rounded-xl border border-border bg-card pe-3 ps-9 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {results.length > 0 ? (
            <div className="absolute z-40 mt-2 w-full overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              {results.map((item) => (
                <button
                  key={item.href + item.label}
                  className="block w-full px-3 py-2 text-start hover:bg-muted"
                  onClick={() => {
                    setQuery("");
                    router.push(item.href);
                  }}
                >
                  <div className="text-sm">{item.label}</div>
                  <div className="tech text-xs text-muted-foreground">{item.meta}</div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700 md:flex dark:text-amber-200">{modeLabel}</div>
        <div className="hidden items-center gap-2 xl:flex">
          <span className="text-xs text-muted-foreground">{t("common.connection")}</span>
          <StatusBadge value={connection} />
        </div>
        <AlertsMenu unread={unread} />
        <LanguageSwitcher />
        <Button variant="ghost" size="icon" aria-label={t("common.theme")} onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <SearchableMenu label={t("common.accountMenu")} items={accountItems} trigger={
          <button type="button" className="rounded-xl border border-border bg-card px-3 py-1.5 text-start">
            <span className="block text-sm font-medium">{user.name}</span>
            <span className="block text-xs text-muted-foreground">{adminMode ? t("common.admin") : roleName(user.role)}</span>
          </button>
        } />
      </div>
      <div className="flex items-center gap-2 px-4 pb-3 md:px-8 text-xs text-muted-foreground">
        {crumbs.map((crumb, index) => (
          <span key={crumb.href} className="flex items-center gap-2">
            {index > 0 ? <span>/</span> : null}
            <Link href={crumb.href} className="hover:text-foreground">{t(crumb.labelKey)}</Link>
          </span>
        ))}
      </div>
      {!adminMode && <BackendSession users={users} open={loginOpen} onOpenChange={setLoginOpen} />}
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="mobile-navigation left-auto right-auto start-0 top-0 h-dvh max-h-none w-72 max-w-[80vw] translate-x-0 translate-y-0 overflow-hidden rounded-none p-0" title={t("common.navigation")}>
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent title={t("common.demoResetTitle")}>
          <p className="text-sm leading-7 text-muted-foreground">{t("common.demoResetBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setResetOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                resetDemo();
                setResetOpen(false);
                toast.success(t("common.demoResetDone"));
              }}
            >
              {t("common.reset")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}

function AlertsMenu({ unread }: { unread: number }) {
  const { t, copy } = useI18n();
  const alerts = useInfraStore((state) => state.alerts);
  const recent = alerts.filter((alert) => !alert.archived && !alert.resolved).slice(0, 6);
  return (
    <SearchableMenu label={t("common.notifications")} className="w-80" items={[
      ...recent.map((alert) => ({ id: alert.id, label: copy(alert.title), detail: copy(alert.detail), href: alert.tunnelId ? `/tunnels/${encodeURIComponent(alert.tunnelId)}` : "/alerts" })),
      { label: t("common.viewAllAlerts"), href: "/alerts" },
    ]} trigger={
      <Button variant="ghost" size="icon" aria-label={t("common.notifications")} className="relative">
        <Bell className="h-4 w-4" />
        {unread > 0 ? <span className="absolute end-1 top-1 rounded-full bg-destructive px-1 text-[10px] text-white">{unread}</span> : null}
      </Button>
    } />
  );
}
