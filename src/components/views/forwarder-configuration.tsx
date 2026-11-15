"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Card, CardHeader, CardTitle, CardContent, Input, Select, Textarea } from "@/components/ui/kit";
import { backhaulFields, ratholeFields, forwarderSettingsSchema, type ForwarderSettings, type NativeOptions } from "@/lib/forwarder-config";
import { getForwarderSettings, saveForwarderSettings, generateForwarderNoiseKeys, generateForwarderCertificate, controlForwarderService } from "@/services/backend";
import Link from "next/link";
import { useCurrentUser, useInfraStore } from "@/stores/infra-store";
import { useI18n } from "@/i18n/provider";

function read(object: NativeOptions, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => v && typeof v === "object" ? (v as NativeOptions)[k] : undefined, object);
}
function write(object: NativeOptions, path: string, value: unknown) {
  const [key, ...keys] = path.split(".");
  if (!keys.length) { if (value === undefined) delete object[key]; else object[key] = value; }
  else { const child = { ...object[key] as NativeOptions }; write(child, keys.join("."), value); if (Object.keys(child).length) object[key] = child; else delete object[key]; }
}

export function ForwarderConfiguration({ tunnelId, disabled = false }: { tunnelId: string; disabled?: boolean }) {
  const { locale, copy } = useI18n();
  const user = useCurrentUser();
  const fa = locale === "fa-IR";
  const query = useQuery({ queryKey: ["forwarder-settings", tunnelId, user.id, user.role], queryFn: () => getForwarderSettings(tunnelId), retry: false, gcTime: 0 });
  return <Card><CardHeader><CardTitle>{fa ? "تنظیمات Rathole / Backhaul" : "Rathole / Backhaul configuration"}</CardTitle></CardHeader><CardContent>
    {query.isPending ? <p>{fa ? "دریافت تنظیمات…" : "Loading…"}</p> : query.error ? <p role="alert">{copy(query.error.message)}</p> : query.data && <Editor key={tunnelId} tunnelId={tunnelId} initial={query.data.settings} disabled={disabled} />}
  </CardContent></Card>;
}

function Editor({ tunnelId, initial, disabled }: { tunnelId: string; initial: ForwarderSettings; disabled: boolean }) {
  const { locale, copy } = useI18n(); const fa = locale === "fa-IR";
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState(false); const [json, setJson] = useState("");
  const [hostname, setHostname] = useState("tunnel.local"); const [days, setDays] = useState(365);
  const [side, setSide] = useState<"iran" | "foreign" | "both">("both");
  const tunnel = useInfraStore(s => s.tunnels.find(t => t.id === tunnelId));
  const update = (change: (next: ForwarderSettings) => void) => { const next = structuredClone(settings); change(next); setSettings(next); setDirty(true); setError(""); };
  const set = (side: "iran" | "foreign", path: string, value: unknown) => update(next => write(next[side].options as NativeOptions, path, value));
  const rathole = settings.technology === "Rathole"; const fields = rathole ? ratholeFields : backhaulFields;
  const field = (side: "iran" | "foreign", path: string, kind: string) => {
    const value = read(settings[side].options as NativeOptions, path);
    return <label key={path} className="space-y-1 text-xs"><span dir="ltr">{path}</span>{kind === "boolean" ?
      <Select aria-label={`${side} ${path}`} value={value === undefined ? "" : String(value)} onChange={e => set(side, path, e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="">{fa ? "پیش‌فرض برنامه" : "Program default"}</option><option value="true">true</option><option value="false">false</option>
      </Select> : <Input aria-label={`${side} ${path}`} dir="ltr" type={kind === "number" ? "number" : kind === "secret" || /token/.test(path) ? "password" : "text"}
        min={kind === "number" ? 0 : undefined} value={String(value ?? "")} onChange={e => set(side, path, e.target.value === "" ? undefined : kind === "number" ? Number(e.target.value) : e.target.value)} />}</label>;
  };
  return <form className="space-y-4" onSubmit={async e => {
    e.preventDefault(); setError(""); let next: unknown = settings;
    try { if (advanced) next = JSON.parse(json); } catch { setError(fa ? "JSON معتبر نیست." : "Invalid JSON."); return; }
    const parsed = forwarderSettingsSchema.safeParse(next);
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.path.join(".") + ": " + i.message).join("\n")); return; }
    setBusy(true); try { await saveForwarderSettings(tunnelId, parsed.data); setSettings(parsed.data); setDirty(false); toast.success(fa ? "ذخیره شد؛ برای اعمال، استقرار یا بازسازی را اجرا کنید." : "Saved. Deploy or rebuild to apply."); }
    catch (e) { setError(e instanceof Error ? copy(e.message) : "Error"); } finally { setBusy(false); }
  }}>
    <p className="text-sm text-muted-foreground">{fa ? "ایران نقش سرور و خارج نقش کلاینت دارد. تنظیمات و فایل‌های خصوصی رمز‌شده ذخیره و با بستهٔ نصب به Agent ارسال می‌شوند." : "Iran runs the server; the foreign host runs the client. Settings and private files are encrypted at rest and delivered in the Agent package."}</p>
    <p className="text-sm text-muted-foreground">{fa ? "چند تونل روی یک سرور پشتیبانی می‌شود؛ پورت کنترل bind_addr و پورت‌های ورودی هر تونل باید مستقل باشند. پورت remote_addr سمت خارج باید با پورت کنترل ایران یکسان باشد." : "Multiple tunnels can share a host with separate control and forwarded ports. The foreign remote_addr port must match Iran's bind_addr port."}</p>
    <fieldset disabled={disabled || busy} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={fa ? "سمت مدیریت سرویس" : "Service control side"} value={side} onChange={e => setSide(e.target.value as typeof side)}><option value="both">{fa ? "هر دو سمت" : "Both sides"}</option><option value="iran">{fa ? "ایران" : "Iran"}</option><option value="foreign">{fa ? "خارج" : "Foreign"}</option></Select>
        {(["start", "stop", "restart"] as const).map(action => <Button key={action} type="button" variant="outline" onClick={async () => { setBusy(true); try { await controlForwarderService(tunnelId, action, side); toast.success(fa ? "عملیات در صف Agent ثبت شد." : "Queued for the Agent."); } catch (e) { setError(e instanceof Error ? copy(e.message) : "Error"); } finally { setBusy(false); } }}>{({ start: fa ? "شروع سرویس" : "Start", stop: fa ? "توقف سرویس" : "Stop", restart: fa ? "ری‌استارت سرویس" : "Restart" })[action]}</Button>)}
        <Link className="text-sm text-primary" href={`/logs?category=tunnel&q=${encodeURIComponent(tunnelId)}`}>{fa ? "لاگ‌های تونل" : "Tunnel logs"}</Link>
      </div>
      <label className="block">{fa ? "هسته و نسخه" : "Core and version"}<Select value={settings.core} onChange={e => update(next => { next.core = e.target.value as ForwarderSettings["core"]; })}>
        <option value="official">{rathole ? "Rathole v0.5.0 · official" : "Backhaul v0.7.2 · Musixal"}</option>
        {rathole && <><option value="modified">Musixal · Modified (amd64)</option><option value="modified-ubuntu22">Musixal · Modified Ubuntu 22 (amd64)</option></>}
      </Select></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => update(next => { const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), x => x.toString(16).padStart(2, "0")).join(""); for (const side of ["iran", "foreign"] as const) write(next[side].options, rathole ? "default_token" : "token", token); })}>{fa ? "تولید توکن مشترک" : "Generate shared token"}</Button>
        {rathole && <Button type="button" variant="outline" onClick={async () => {
          setBusy(true); try { const keys = await generateForwarderNoiseKeys(tunnelId); update(next => { write(next.iran.options, "transport.noise.local_private_key", keys.privateKey); write(next.foreign.options, "transport.noise.remote_public_key", keys.publicKey); for (const side of ["iran", "foreign"] as const) write(next[side].options, "transport.type", "noise"); }); }
          catch (e) { setError(e instanceof Error ? copy(e.message) : "Error"); } finally { setBusy(false); }
        }}>{fa ? "تولید کلید و فعال‌سازی Noise" : "Generate Noise keys"}</Button>}
        <Button type="button" variant="outline" onClick={() => { if (!advanced) setJson(JSON.stringify(settings, null, 2)); else { try { setSettings(forwarderSettingsSchema.parse(JSON.parse(json))); } catch { setError(fa ? "ابتدا خطاهای JSON را رفع کنید." : "Fix JSON errors first."); return; } } setAdvanced(!advanced); }}>{advanced ? (fa ? "فرم تنظیمات" : "Configuration form") : (fa ? "ویرایش کامل تنظیمات" : "Full configuration editor")}</Button>
      </div>
      <div className="grid items-end gap-2 sm:grid-cols-3">
        <label>{fa ? "نام یا IP گواهی TLS" : "TLS hostname or IP"}<Input dir="ltr" value={hostname} onChange={e => setHostname(e.target.value)} /></label>
        <label>{fa ? "اعتبار گواهی (روز)" : "Validity (days)"}<Input type="number" min={1} max={3650} value={days} onChange={e => setDays(Number(e.target.value))} /></label>
        <Button type="button" variant="outline" disabled={advanced} onClick={async () => { setBusy(true); try {
          const cert = await generateForwarderCertificate(tunnelId, hostname, days);
          update(next => { const add = (side: "iran" | "foreign", assets: { name: string; content: string }[]) => { next[side].assets = [...next[side].assets.filter(a => !assets.some(b => b.name === a.name)), ...assets]; };
            if (next.technology === "Rathole") { add("iran", [cert.identity]); add("foreign", [cert.certificate]); next.iran.options.transport.type = "tls"; next.foreign.options.transport.type = "tls";
              next.iran.options.transport.tls = { pkcs12: cert.identity.name, pkcs12_password: cert.password }; next.foreign.options.transport.tls = { hostname: cert.hostname, trusted_root: cert.certificate.name }; }
            else { add("iran", [cert.certificate, cert.key]); next.iran.options.tls_cert = cert.certificate.name; next.iran.options.tls_key = cert.key.name; next.iran.options.transport = "wss"; next.foreign.options.transport = "wss"; }
          });
        } catch (e) { setError(e instanceof Error ? copy(e.message) : "Error"); } finally { setBusy(false); } }}>{fa ? "تولید و تنظیم گواهی خودامضا" : "Generate and configure self-signed TLS"}</Button>
      </div>
      {advanced ? <Textarea aria-label="Forwarder full configuration" dir="ltr" rows={32} spellCheck={false} value={json} onChange={e => { setJson(e.target.value); setDirty(true); }} /> : <>
        <div className="grid gap-4 xl:grid-cols-2">{(["iran", "foreign"] as const).map(side => <section key={side} className="space-y-3 rounded-xl border border-border p-3">
          <h4 className="font-semibold">{side === "iran" ? (fa ? "ایران · Server" : "Iran · Server") : (fa ? "خارج · Client" : "Foreign · Client")}</h4>
          {tunnel && <Link className="text-xs text-primary" href={`/servers/${encodeURIComponent(side === "iran" ? tunnel.iranEndpoint.serverId : tunnel.foreignEndpoint.serverId)}`}>{fa ? "تنظیمات میزبان، BBR و ریبوت" : "Host settings, BBR and reboot"}</Link>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label>{fa ? "معماری میزبان" : "Host architecture"}<Select aria-label={`${side} architecture`} value={settings[side].architecture} onChange={e => update(next => { next[side].architecture = e.target.value as "amd64" | "arm64"; })}><option>amd64</option><option>arm64</option></Select></label>
            <label>{fa ? "ری‌استارت دوره‌ای" : "Periodic restart"}<Select aria-label={`${side} restart`} value={String(settings[side].restartSeconds)} onChange={e => update(next => { next[side].restartSeconds = Number(e.target.value) as 0; })}>
              <option value="0">{fa ? "غیرفعال" : "Disabled"}</option>{[1800, 3600, 7200, 14400, 21600, 43200, 86400].map(s => <option key={s} value={s}>{s / 60} {fa ? "دقیقه" : "minutes"}</option>)}
            </Select></label>
            <label>LimitNOFILE<Input aria-label={`${side} LimitNOFILE`} type="number" min={1024} max={1048576} value={settings[side].limitNofile ?? 1048576} onChange={e => update(next => { next[side].limitNofile = Number(e.target.value); })} /></label>
            {field(side, side === "iran" ? "bind_addr" : "remote_addr", "text")}{field(side, rathole ? "default_token" : "token", "secret")}
            <label>transport<Select aria-label={`${side} transport`} value={String(read(settings[side].options, rathole ? "transport.type" : "transport"))} onChange={e => set(side, rathole ? "transport.type" : "transport", e.target.value)}>
              {(rathole ? ["tcp", "tls", "noise", "websocket"] : ["tcp", "tcpmux", "udp", "ws", "wss", "wsmux", "wssmux"]).map(x => <option key={x}>{x}</option>)}
            </Select></label>{Object.entries({ ...fields.common, ...fields[side] }).map(([path, type]) => field(side, path, type))}
          </div>
          {!rathole && side === "iran" && <label className="block">{fa ? "پورت‌ها و نگاشت‌ها؛ هر خط یک نگاشت" : "Ports and mappings; one per line"}<Textarea aria-label="Backhaul ports" dir="ltr" rows={5} value={((settings.iran.options as NativeOptions).ports as string[]).join("\n")} onChange={e => set(side, "ports", e.target.value.split("\n").map(x => x.trim()).filter(Boolean))} /></label>}
          {rathole && <div className="space-y-3">{Object.entries((settings[side].options as NativeOptions).services as Record<string, NativeOptions>).map(([name, service]) => <div key={name} className="space-y-2 rounded-lg bg-muted p-2">
            <div className="flex items-center justify-between"><strong dir="ltr">{name}</strong><Button type="button" size="sm" variant="ghost" onClick={() => update(next => { for (const s of ["iran", "foreign"] as const) delete ((next[s].options as NativeOptions).services as NativeOptions)[name]; })}>{fa ? "حذف سرویس" : "Remove service"}</Button></div>
            <div className="grid gap-2 sm:grid-cols-2">{field(side, `services.${name}.${side === "iran" ? "bind_addr" : "local_addr"}`, "text")}
              <label>TCP / UDP<Select aria-label={`${side} ${name} protocol`} value={String(service.type)} onChange={e => set(side, `services.${name}.type`, e.target.value)}><option>tcp</option><option>udp</option></Select></label>
              {field(side, `services.${name}.token`, "secret")}{field(side, `services.${name}.nodelay`, "boolean")}{side === "foreign" && field(side, `services.${name}.retry_interval`, "number")}
            </div></div>)}</div>}
          <label className="block">{fa ? "افزودن گواهی، کلید یا فایل PKCS#12" : "Upload certificate, key or PKCS#12"}<Input type="file" aria-label={`${side} credential upload`} onChange={async e => {
            const file = e.target.files?.[0]; if (!file) return; if (file.size > 900 * 1024) { setError("Maximum file size: 900 KiB"); return; }
            const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
            update(next => { next[side].assets = [...next[side].assets.filter(a => a.name !== file.name), { name: file.name, content: btoa(binary) }]; });
          }} /></label>
          <ul className="text-xs">{settings[side].assets.map(asset => <li key={asset.name}><bdi>{asset.name}</bdi><Button type="button" size="sm" variant="ghost" onClick={() => update(next => { next[side].assets = next[side].assets.filter(a => a.name !== asset.name); })}>{fa ? "حذف فایل" : "Remove file"}</Button></li>)}</ul>
          <p className="text-xs text-muted-foreground">{fa ? "برای مسیر TLS نام فایل بارگذاری‌شده را وارد کنید. لاگ ترافیک در فضای همین سرویس ذخیره می‌شود؛ بهینه‌سازی عمومی سیستم از صفحهٔ سرور انجام می‌شود." : "Use uploaded filenames in TLS fields. Traffic logs use the service state directory; manage system optimizations from server settings."}</p>
        </section>)}</div>
        {rathole && <Button type="button" variant="outline" onClick={() => update(next => { const name = "service" + crypto.randomUUID().slice(0, 8); for (const side of ["iran", "foreign"] as const) ((next[side].options as NativeOptions).services as NativeOptions)[name] = { type: "tcp", [side === "iran" ? "bind_addr" : "local_addr"]: side === "iran" ? "0.0.0.0:8443" : "127.0.0.1:8443" }; })}>{fa ? "افزودن سرویس به هر دو سمت" : "Add paired service"}</Button>}
      </>}
      {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
      <Button type="submit">{busy ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "ذخیره تنظیمات" : "Save configuration")}</Button>{dirty && <span className="mx-2 text-xs text-muted-foreground">{fa ? "تغییرات ذخیره نشده" : "Unsaved changes"}</span>}
    </fieldset>
  </form>;
}
