"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ComponentProps, type ReactElement } from "react";
import { Input } from "@/components/ui/kit";
import { optionMatches } from "@/lib/option-search";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export function TooltipContent({ className, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className={cn("z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background", className)} sideOffset={6} {...props} />
    </TooltipPrimitive.Portal>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({ className, children, title, layout = "default", onEscapeKeyDown }: {
  className?: string; children: React.ReactNode; title?: string; layout?: "default" | "wide" | "fill";
  onEscapeKeyDown?: ComponentProps<typeof DialogPrimitive.Content>["onEscapeKeyDown"];
}) {
  const { t } = useI18n();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px]" />
      <DialogPrimitive.Content
        onEscapeKeyDown={onEscapeKeyDown}
        className={cn(
          "fixed z-50 border border-border bg-card p-5 shadow-xl",
          layout === "fill"
            ? "inset-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden rounded-none"
            : "left-1/2 top-1/2 max-h-[86vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl",
          layout === "default" && "w-[min(560px,calc(100%-2rem))]",
          layout === "wide" && "w-[min(72rem,calc(100%-2rem))]",
          className,
        )}>
        {title ? <DialogPrimitive.Title className="mb-3 shrink-0 text-lg font-semibold">{title}</DialogPrimitive.Title> : null}
        <div className={layout === "fill" ? "flex min-h-0 flex-1 flex-col" : "contents"}>{children}</div>
        <DialogPrimitive.Close className="absolute end-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label={t("common.close")}>
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

type MenuItem = { id?: string; label: string; detail?: string } & ({ href: string } | { onSelect: () => void });

export function SearchableMenu({ trigger, label, items, className }: {
  trigger: ReactElement; label: string; items: MenuItem[]; className?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const actions = useRef<HTMLDivElement>(null);
  const matches = optionMatches(query);
  const results = items.filter((item) => matches(`${item.label} ${item.detail ?? ""}`));
  const itemClass = "block w-full rounded-lg px-3 py-2 text-start text-sm outline-none hover:bg-muted focus:bg-muted";

  return <PopoverPrimitive.Root onOpenChange={(open) => { if (open) setQuery(""); }}>
    <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content aria-label={label} sideOffset={8} align="end" collisionPadding={8}
        className={cn("z-50 flex max-h-[var(--radix-popover-content-available-height)] min-w-48 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-lg", className)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const buttons = Array.from(actions.current?.querySelectorAll<HTMLElement>("a, button") ?? []);
          if (!buttons.length) return;
          event.preventDefault();
          const index = buttons.indexOf(event.target as HTMLElement);
          const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
          buttons[next].focus();
        }}>
        <Input aria-label={t("common.searchOptions")} placeholder={t("common.searchOptions")} dir="auto" value={query}
          onChange={(event) => setQuery(event.target.value)} className="h-9 shrink-0 px-2" />
        <div ref={actions} className="mt-1 min-h-0 overflow-y-auto overscroll-contain">
          {results.map((item) => {
            const content = <><span>{item.label}</span>{item.detail && <span className="block text-xs text-muted-foreground">{item.detail}</span>}</>;
            return <PopoverPrimitive.Close key={item.id ?? item.label} asChild>
              {"href" in item
                ? <Link href={item.href} className={itemClass}>{content}</Link>
                : <button type="button" onClick={item.onSelect} className={itemClass}>{content}</button>}
            </PopoverPrimitive.Close>;
          })}
          {!results.length && <p role="status" className="px-2 py-3 text-sm text-muted-foreground">{t("common.noOptions")}</p>}
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex flex-wrap gap-1 rounded-xl bg-muted p-1", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn("rounded-lg px-3 py-1.5 text-sm text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm", className)} {...props} />;
}
export const TabsContent = TabsPrimitive.Content;

export function Switch(props: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root className="relative h-6 w-11 rounded-full bg-muted data-[state=checked]:bg-primary" {...props}>
      <SwitchPrimitive.Thumb className="block h-5 w-5 rounded-full bg-white transition-transform ltr:translate-x-0.5 ltr:data-[state=checked]:translate-x-5 rtl:-translate-x-0.5 rtl:data-[state=checked]:-translate-x-5" />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox(props: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root className="flex h-4 w-4 items-center justify-center rounded border border-border bg-card data-[state=checked]:bg-primary" {...props}>
      <CheckboxPrimitive.Indicator>
        <Check className="h-3 w-3 text-primary-foreground" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
