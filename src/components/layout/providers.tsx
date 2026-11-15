"use client";

import { POLLING } from "@/lib/polling";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AdminMode } from "./session-mode";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { TooltipProvider } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/kit";
import { I18nProvider, useI18n } from "@/i18n/provider";
import { syncBackend, useBackend } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";

export function Providers({ adminMode, initialLocale, children }: { adminMode: boolean; initialLocale?: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: POLLING.workspace, refetchIntervalInBackground: false } } }));
  return (
    <I18nProvider initialLocale={initialLocale}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="nodeguard-theme">
        <QueryClientProvider client={client}>
          <TooltipProvider delayDuration={200}>
            <AdminMode.Provider value={adminMode}>
              {pathname === "/login" || pathname === "/status" ? children : <WorkspaceRoot adminMode={adminMode}>{children}</WorkspaceRoot>}
            </AdminMode.Provider>
            <LocalizedToaster />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

function LocalizedToaster() {
  const { dir } = useI18n();
  return <Toaster position="top-center" dir={dir} richColors />;
}

function WorkspaceRoot({ adminMode, children }: { adminMode: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const actor = useBackend((state) => state.actor);
  useEffect(() => {
    let disposed = false;
    let poll: number | undefined;
    let delay: number = POLLING.workspace;
    const schedule = () => {
      if (!disposed) poll = window.setTimeout(refresh, delay);
    };
    const refresh = async () => {
      if (disposed) return;
      if (document.visibilityState === "visible" && navigator.onLine && useBackend.getState().actor) {
        await syncBackend();
        delay = useBackend.getState().status === "error" ? Math.min(delay * 2, POLLING.error) : POLLING.workspace;
      }
      schedule();
    };
    const finish = async () => {
      await syncBackend();
      if (disposed) return;
      useInfraStore.setState({ hydrated: true });
      setReady(true);
      if (poll === undefined) schedule();
    };
    const unsub = adminMode ? undefined : useInfraStore.persist.onFinishHydration(() => void finish());
    if (adminMode || useInfraStore.persist.hasHydrated()) void finish();
    return () => { disposed = true; unsub?.(); window.clearTimeout(poll); };
  }, [adminMode, retry]);
  if (!ready) {
    return (
      <div className="min-h-screen p-6">
        <Skeleton className="mb-4 h-12 w-full" />
        <div className="grid gap-4 md:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-28" />)}</div>
      </div>
    );
  }
  if (adminMode && !actor) {
    return (
      <main className="grid min-h-dvh place-content-center gap-3 p-6 text-center">
        <p>{t("common.accessFailed")}</p>
        <button className="text-primary underline" onClick={() => setRetry((count) => count + 1)}>{t("common.retry")}</button>
        <a className="text-sm text-muted-foreground underline" href="/login">{t("common.loginPage")}</a>
      </main>
    );
  }
  return (
    <div className="workspace min-h-screen">
      <a href="#main-content" className="skip-link">{t("common.nav.dashboard")}</a>
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-64 border-e border-border lg:block">
        <Sidebar />
      </aside>
      <div className="lg:ps-64">
        <Header />
        <main id="main-content" className="workspace-main px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
