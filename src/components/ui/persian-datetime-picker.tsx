"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button, Input } from "./kit";

const DAY = 86400000;
const parts = (ts: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US-u-ca-persian", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ts).map(p => [p.type, p.value]));
const midnight = (ts: number) => Math.floor((ts + 12600000) / DAY) * DAY;

/** Calendar days use UTC internally; selected times are explicitly Asia/Tehran (+03:30). */
export function PersianDateTimePicker({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const selected = midnight(value);
  const [cursor, setCursor] = useState(selected);
  const current = parts(cursor);
  const first = cursor - (Number(current.day) - 1) * DAY;
  const days = Array.from({ length: 31 }, (_, i) => first + i * DAY).filter(ts => parts(ts).month === current.month);
  const offset = (new Date(first).getUTCDay() + 1) % 7;
  const time = new Date(value + 12600000).toISOString().slice(11, 16);
  const dateLabel = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "medium", timeStyle: "short" }).format(value);
  return <Popover.Root onOpenChange={open => { if (open) setCursor(selected); }}>
    <Popover.Trigger asChild><button type="button" className="w-full rounded-lg border border-border bg-card p-3 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}: {dateLabel}</button></Popover.Trigger>
    <Popover.Portal>
    <Popover.Content side="bottom" align="start" sideOffset={8} collisionPadding={12} aria-label={label} className="z-[100] max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl" dir="rtl">
      <div className="mb-3 flex items-center justify-between">
        <Button type="button" size="sm" variant="outline" aria-label="ماه قبل" onClick={() => setCursor(first - DAY)}>→</Button>
        <span>{new Intl.DateTimeFormat("fa-IR", { timeZone: "UTC", month: "long", year: "numeric" }).format(cursor)}</span>
        <Button type="button" size="sm" variant="outline" aria-label="ماه بعد" onClick={() => setCursor(first + days.length * DAY)}>←</Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-sm">
        {["ش", "ی", "د", "س", "چ", "پ", "ج"].map((d, i) => <span key={i} className="py-2 text-muted-foreground">{d}</span>)}
        {Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}
        {days.map(ts => <button type="button" key={ts} aria-pressed={ts === selected} className={`rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${ts === selected ? "bg-primary text-primary-foreground" : ""}`} onClick={() => onChange(ts - 12600000 + Number(time.slice(0, 2)) * 3600000 + Number(time.slice(3)) * 60000)}>{Number(parts(ts).day).toLocaleString("fa-IR")}</button>)}
      </div>
      <label className="mt-4 flex items-center gap-3 text-sm">ساعت تهران<Input type="time" value={time} onChange={e => { if (e.target.value) onChange(selected - 12600000 + Number(e.target.value.slice(0, 2)) * 3600000 + Number(e.target.value.slice(3)) * 60000); }} /></label>
    </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
