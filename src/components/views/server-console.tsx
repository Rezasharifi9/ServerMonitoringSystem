"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Terminal as TerminalIcon } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/kit";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { revealServerSshPassword } from "@/services/backend";

export function ServerConsoleButton({ serverId, labeled = false }: { serverId: string; labeled?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const title = t("servers.console.title");
  const leaveFullscreen = () => {
    setExpanded(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  return <Dialog open={open} onOpenChange={(next) => {
    setOpen(next);
    if (!next) leaveFullscreen();
  }}>
    <DialogTrigger asChild>
      <Button variant="outline" size={labeled ? "sm" : "icon"} title={title} aria-label={title}>
        <TerminalIcon className={labeled ? "h-4 w-4" : undefined} />
        {labeled ? title : null}
      </Button>
    </DialogTrigger>
    {open && <DialogContent title={title} layout={expanded ? "fill" : "wide"} onEscapeKeyDown={(event) => event.preventDefault()}>
      <ServerConsole serverId={serverId} expanded={expanded} onToggleFullscreen={() => {
        if (expanded || document.fullscreenElement) {
          leaveFullscreen();
          return;
        }
        setExpanded(true);
        void document.documentElement.requestFullscreen().catch(() => undefined);
      }} />
    </DialogContent>}
  </Dialog>;
}

function ServerConsole({ serverId, expanded, onToggleFullscreen }: {
  serverId: string; expanded: boolean; onToggleFullscreen: () => void;
}) {
  const { t, copy } = useI18n();
  const i18n = useRef({ t, copy });
  i18n.current = { t, copy };
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const terminal = new Terminal({ fontSize: 13, scrollback: 1000 });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    const fitNow = () => {
      if (!container.current || container.current.clientHeight < 2) return;
      fit.fit();
    };
    fitNow();
    terminal.focus();
    const abort = new AbortController();
    const url = `/api/v1/servers/${encodeURIComponent(serverId)}/console/${crypto.randomUUID()}/`;
    let input = Promise.resolve();
    let ready = false;
    let sent = "";
    let resizeTimer = 0;
    const pushSize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!ready || abort.signal.aborted) return;
        const next = `${terminal.cols}x${terminal.rows}`;
        if (next === sent) return;
        sent = next;
        void fetch(url + "resize", {
          method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
        }).catch(() => undefined);
      }, 40);
    };
    const resized = terminal.onResize(pushSize);
    const observer = new ResizeObserver(fitNow);
    observer.observe(container.current!);
    let data = { dispose() {} };
    data = terminal.onData((text) => {
      if (!ready) return;
      input = input.then(async () => {
        for (const chunk of text.match(/[\s\S]{1,4096}/gu) ?? []) {
          const response = await fetch(url + "input", {
            method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunk }),
          });
          if (!response.ok) throw new Error(i18n.current.t("servers.console.inputFailed"));
        }
      }).catch((error: Error) => { if (!abort.signal.aborted && error.name !== "AbortError") setStatus(i18n.current.copy(error.message)); });
    });
    void (async () => {
      const response = await fetch(url + "open", {
        method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? i18n.current.t("servers.console.connectFailed"));
      }
      sent = `${terminal.cols}x${terminal.rows}`;
      const reader = response.body.getReader();
      while (!abort.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!ready) { ready = true; pushSize(); setStatus(i18n.current.t("servers.console.active")); }
        await new Promise<void>((resolve) => terminal.write(chunk.value, resolve));
      }
      ready = false;
      if (!abort.signal.aborted) setStatus(i18n.current.t("servers.console.closed"));
    })().catch((error: Error) => { if (!abort.signal.aborted && error.name !== "AbortError") setStatus(i18n.current.copy(error.message)); });
    return () => {
      window.clearTimeout(resizeTimer);
      abort.abort();
      observer.disconnect();
      terminalRef.current = null;
      resized.dispose();
      data.dispose();
      terminal.dispose();
    };
  }, [serverId]);
  useEffect(() => { terminalRef.current?.focus(); }, [expanded]);
  const clipboard = async (operation: () => Promise<void>) => {
    try { await operation(); }
    catch { setStatus(t("servers.console.clipboardFailed")); }
  };
  const fullscreenLabel = expanded ? t("servers.console.exitFullscreen") : t("servers.console.fullscreen");
  return <div className={cn("flex min-h-0 flex-col gap-3", expanded && "flex-1")}>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" onClick={() => void clipboard(async () => {
        const selected = terminalRef.current?.getSelection();
        if (selected) await navigator.clipboard.writeText(selected);
      })}>{t("servers.console.copy")}</Button>
      <Button type="button" variant="outline" onClick={() => void clipboard(async () => terminalRef.current?.paste(await navigator.clipboard.readText()))}>{t("servers.console.paste")}</Button>
      <Button type="button" variant="outline" onClick={() => void clipboard(async () => terminalRef.current?.paste(await revealServerSshPassword(serverId)))}>{t("servers.console.pastePassword")}</Button>
      <Button type="button" variant="outline" aria-pressed={expanded} onClick={onToggleFullscreen}>
        {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        {fullscreenLabel}
      </Button>
      <p role="status" className="text-sm text-muted-foreground">{status || t("servers.console.connecting")}</p>
    </div>
    <div ref={container} dir="ltr" className={cn("min-h-0 overflow-hidden rounded border border-border bg-black", expanded ? "flex-1" : "h-[28rem]")} />
  </div>;
}
