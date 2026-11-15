"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Textarea } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { v2bxFilesSchema, type V2bxFiles } from "@/lib/v2bx-files";
import { getV2bxFiles, saveV2bxFiles, getGlobalV2bxFiles, saveGlobalV2bxFiles, applyGlobalV2bxFiles } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";

export function V2bxFilesEditor({ serverId = "", disabled = false, global = false }: { serverId?: string; disabled?: boolean; global?: boolean }) {
  const { locale } = useI18n();
  const fa = locale === "fa-IR";
  const client = useQueryClient();
  const key = global ? ["v2bx-files-global"] : ["v2bx-files", serverId];
  const query = useQuery({ queryKey: key, queryFn: () => global ? getGlobalV2bxFiles() : getV2bxFiles(serverId), retry: false, staleTime: Infinity });
  const servers = useInfraStore(state => state.servers);
  const targets = servers.filter(server => server.roles.includes("foreign"));
  const [results, setResults] = useState<{ id: string; name: string; status: "waiting" | "running" | "succeeded" | "failed"; error?: string }[]>([]);
  const [draft, setDraft] = useState<V2bxFiles | null>(null);
  const [pending, setPending] = useState(false);
  const [apply, setApply] = useState(false);
  const files = draft ?? query.data ?? { route: null, outbound: null };
  const blocked = disabled || pending || !query.data;
  return <Card>
    <CardHeader><CardTitle>{global ? (fa ? "تنظیمات سراسری فایل‌های V2bX" : "Global V2bX files") : (fa ? "فایل‌های Route و Outbound در V2bX" : "V2bX Route and Outbound files")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">{global ? (fa ? `هر دو فایل را آپلود یا ویرایش کنید. «اعمال روی همه» فایل‌ها و مسیرهای Xray را روی ${targets.length} سرور خارج جایگزین و سپس V2bX هر سرور را restart می‌کند. اتصال SSH ذخیره‌شده لازم است. خطای یک سرور مانع ادامهٔ بقیه نمی‌شود. تا پایان عملیات این صفحه را باز نگه دارید.` : `Upload or edit both files. Apply to all replaces the Xray files and paths on ${targets.length} foreign servers and restarts each server’s V2bX. Saved SSH access is required. Failures do not stop other servers. Keep this page open until completion.`) : (fa ? "فایل‌ها برای همین سرور ذخیره می‌شوند. آپلود یا ویرایش کنید و ثبت را بزنید. حذف، مسیر مربوط را هم از هستهٔ Xray پاک می‌کند. این فایل‌ها با sing سازگار نیستند." : "Upload or edit files, then save for this server. Removing a file also clears its Xray path. These files require Xray.")}</p>
      {query.isError && <p role="alert" className="text-destructive">{query.error.message} <Button variant="outline" onClick={() => void query.refetch()}>{fa ? "تلاش مجدد" : "Retry"}</Button></p>}
      {query.isPending && <p>{fa ? "در حال دریافت…" : "Loading…"}</p>}
      {([ ["route", "route.json"], ["outbound", "custom_outbound.json"] ] as const).map(([field, name]) => <div key={field} className="space-y-2">
        <label className="block text-sm"><span dir="ltr">{name}</span>
          <Input type="file" accept=".json,application/json" disabled={blocked} aria-label={fa ? `آپلود ${name}` : `Upload ${name}`} onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            if (file.size > 300000) { toast.error(fa ? "حداکثر اندازهٔ فایل ۳۰۰ کیلوبایت است." : "Maximum file size is 300 KB."); return; }
            try {
              const text = await file.text();
              setDraft(previous => ({ ...(previous ?? files), [field]: text.replace(/^\uFEFF/, "") }));
            } catch { toast.error(fa ? "خواندن فایل ناموفق بود." : "Could not read file."); }
          }} />
        </label>
        <Textarea dir="ltr" className="min-h-48 font-mono text-xs" spellCheck={false} aria-label={`${name} JSON`} disabled={blocked}
          value={files[field] ?? ""} placeholder={field === "route" ? '{"rules": []}' : '[]'} onChange={event => setDraft({ ...files, [field]: event.target.value || null })} />
        <Button variant="outline" disabled={blocked || files[field] === null} onClick={() => setDraft({ ...files, [field]: null })}>{fa ? `حذف ${name}` : `Remove ${name}`}</Button>
        <span className="ms-2 text-xs text-muted-foreground">{files[field] === null ? (fa ? "غیرفعال؛ با ثبت حذف می‌شود" : "Disabled; save to remove") : (fa ? "فعال؛ با ثبت جایگزین می‌شود" : "Enabled; save to replace")}</span>
      </div>)}
      {!global && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={blocked} checked={apply} onChange={e => setApply(e.target.checked)} />{fa ? "همین حالا روی V2bX نصب‌شده اعمال و سرویس را راه‌اندازی مجدد کن (SSH لازم است)" : "Apply to installed V2bX and restart now (requires SSH)"}</label>
      <p className="text-xs text-muted-foreground">{fa ? "بدون انتخاب گزینهٔ بالا، فایل‌ها فقط برای نصب بعدی ذخیره می‌شوند. ویرایشگر محتوای ذخیره‌شدهٔ پنل را نمایش می‌دهد." : "Otherwise files are saved for the next installation. This editor shows the panel’s saved copy."}</p></>}
      <p className="text-xs text-muted-foreground">{fa ? "نصب مجددِ بستهٔ قبلی، فایل‌های همان بسته را برمی‌گرداند. برای نصب با فایل‌های جدید، از فرم نصب و گزینهٔ اعمال فایل‌های ذخیره‌شده استفاده کنید." : "Reinstalling a previous bundle restores that bundle’s files. Use the installation form with saved files enabled to build a new bundle."}</p>
      <Button disabled={blocked || (!draft && !apply)} onClick={async () => {
        const parsed = v2bxFilesSchema.safeParse(files);
        if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
        setPending(true);
        try {
          const saved = global ? await saveGlobalV2bxFiles(parsed.data) : await saveV2bxFiles(serverId, parsed.data, apply);
          client.setQueryData(key, saved); setDraft(null);
          toast.success(fa ? (global ? "فایل‌های مشترک ذخیره شدند؛ برای اجرای سراسری «اعمال روی همه» را بزنید." : apply ? "فایل‌ها ثبت و روی V2bX اعمال شدند." : "فایل‌ها برای نصب ذخیره شدند.") : "Files saved.");
        } catch (error) { toast.error(error instanceof Error ? error.message : "Failed"); }
        finally { setPending(false); }
      }}>{pending ? (fa ? "در حال ثبت…" : "Saving…") : (fa ? "ثبت" : "Save")}</Button>
      {global && <Button className="ms-2" disabled={blocked || !targets.length} onClick={async () => {
        const parsed = v2bxFilesSchema.safeParse(files);
        if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
        const hosts = targets.map(({ id, name }) => ({ id, name }));
        setPending(true);
        setResults(hosts.map(host => ({ ...host, status: "waiting" })));
        try {
          const saved = await saveGlobalV2bxFiles(parsed.data);
          client.setQueryData(key, saved); setDraft(null);
          let failures = 0;
          for (const host of hosts) {
            setResults(previous => previous.map(result => result.id === host.id ? { ...result, status: "running" } : result));
            try {
              await applyGlobalV2bxFiles(host.id, saved);
              client.setQueryData(["v2bx-files", host.id], saved);
              setResults(previous => previous.map(result => result.id === host.id ? { ...result, status: "succeeded" } : result));
            } catch (error) {
              failures++;
              setResults(previous => previous.map(result => result.id === host.id ? { ...result, status: "failed", error: error instanceof Error ? error.message : "Failed" } : result));
            }
          }
          const message = fa ? `عملیات تمام شد: ${hosts.length - failures} موفق، ${failures} ناموفق.` : `Completed: ${hosts.length - failures} succeeded, ${failures} failed.`;
          if (failures) toast.error(message); else toast.success(message);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed";
          setResults(previous => previous.map(result => ({ ...result, status: "failed", error: message })));
          toast.error(message);
        } finally { setPending(false); }
      }}>{fa ? "اعمال روی همه و Restart تمامی V2bXها" : "Apply to all and restart V2bX"}</Button>}
      {global && results.length > 0 && <ul className="space-y-2 text-sm" aria-live="polite">{results.map(result => <li key={result.id}>
        <span className="font-medium">{result.name}</span> · {fa ? ({ waiting: "در صف", running: "در حال اعمال و Restart", succeeded: "اعمال و Restart موفق", failed: "ناموفق" }[result.status]) : result.status}
        {result.error && <p className="text-destructive">{result.error}</p>}
      </li>)}</ul>}
    </CardContent>
  </Card>;
}
