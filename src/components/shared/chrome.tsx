"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Button } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  useEffect(() => {
    document.title = `${title} | NodeGuard`;
  }, [title]);
  return (
    <div className="page-heading mb-7 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function DemoNote({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200">{children}</div>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

export function ConfirmButton({
  label,
  icon,
  title,
  description,
  confirmLabel,
  destructive,
  disabled,
  onConfirm,
}: {
  label: string;
  icon?: React.ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const confirmText = confirmLabel ?? t("common.confirmSimulation");
  return (
    <>
      <Button variant={destructive ? "destructive" : "outline"} size={icon ? "icon" : undefined} aria-label={icon ? label : undefined}
        title={icon ? label : undefined} disabled={disabled} onClick={() => setOpen(true)}>{icon ?? label}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={title}>
          <p className="text-sm leading-7 text-muted-foreground">{description}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmText}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function KpiCard({ label, value, hint, icon, tone = "primary" }: { label: string; value: string | number; hint?: string; icon?: React.ReactNode; tone?: "primary" | "success" | "warning" | "destructive" }) {
  return (
    <div className="metric-card rounded-2xl border border-border bg-card p-5" data-tone={tone}>
      <div className="flex items-center justify-between gap-3"><div className="text-sm font-medium text-muted-foreground">{label}</div>{icon ? <span className="metric-icon" aria-hidden="true">{icon}</span> : null}</div>
      <div className="mt-4 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Tech({ children }: { children: React.ReactNode }) {
  return <span className="tech">{children}</span>;
}
