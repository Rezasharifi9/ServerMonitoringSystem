"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Input, Select, Textarea } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useI18n } from "@/i18n/provider";
import { panelNodeFields, panelNodeTypes, type PanelAdminNode, type PanelAdminNodes, type PanelField, type PanelNodeType } from "@/lib/v2board-node-fields";
import { saveV2BoardNode } from "@/services/backend";

const connectionFields = new Set(["name", "host", "port", "group_id", "network", "tls"]);
const tlsFields = new Set(["server_name", "fingerprint", "allow_insecure"]);
const ltrKeys = new Set(["host", "port", "server_port", "server_name", "dest", "private_key", "public_key", "short_id", "fingerprint", "obfs_password", "up_mbps", "down_mbps"]);

function panelError(message: string, t: (key: string, vars?: Record<string, string>) => string, copy: (text: string) => string) {
  const required = /^مقدار (nodes\.[\w.]+) را وارد کنید\.$/.exec(message);
  if (required) return t("nodes.panel.requiredValue", { label: t(required[1]) });
  return copy(message);
}

export function V2BoardNodeEditorDialog({ node, catalog, onClose, onSaved }: {
  node: PanelAdminNode | null | undefined; catalog: PanelAdminNodes; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  return <Dialog open={node !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
    {node !== undefined && <DialogContent className="w-[min(760px,calc(100%-2rem))]" title={node ? t("nodes.panel.editTitle") : t("nodes.panel.addTitle")}>
      <NodeEditor node={node} catalog={catalog} onSaved={onSaved} />
    </DialogContent>}
  </Dialog>;
}

function NodeEditor({ node, catalog, onSaved }: { node: PanelAdminNode | null; catalog: PanelAdminNodes; onSaved: () => Promise<void> }) {
  const { t, copy } = useI18n();
  const [type, setType] = useState<PanelNodeType>(node?.type ?? "vless");
  const [tls, setTls] = useState("0");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const fields = panelNodeFields(type);
  const reality = !node && type === "vless" && tls === "2";
  const primaryFields = node ? fields : fields.filter((field) => connectionFields.has(field.key));
  const advancedFields = node ? [] : fields.filter((field) => !connectionFields.has(field.key)).flatMap((field) => {
    if (field.key !== "tls_settings") return [field];
    if (tls === "0") return [];
    return [{ ...field, label: reality ? "nodes.panel.realitySettings" : "nodes.panel.tlsSettings",
      subfields: field.subfields?.filter(({ key }) => reality ? key !== "server_name" && key !== "allow_insecure" : tlsFields.has(key)) }];
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    setError("");
    setPending(true);
    try {
      const values = Object.fromEntries(fields.map((field) => [field.key, fieldValue(field, input, (label) => t("nodes.panel.invalidJson", { field: t(label) }))]));
      if (reality) {
        const settings = values.tls_settings;
        if (Array.isArray(settings)) throw new Error(t("nodes.panel.realityObject"));
        values.tls_settings = { ...(settings && typeof settings === "object" ? settings : {}),
          server_name: String(input.get("reality_sni") ?? "").trim() };
      }
      await saveV2BoardNode({ id: node?.id, revision: node?.revision, type, fields: values });
      toast.success(t("nodes.panel.saved"));
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? panelError(cause.message, t, copy) : t("nodes.panel.saveFailed"));
    } finally { setPending(false); }
  }

  return <form onSubmit={submit} className="space-y-3 text-sm">
    <label>{t("nodes.panel.nodeType")}<Select value={type} disabled={Boolean(node) || pending} onChange={(event) => {
      const nextType = event.target.value as PanelNodeType;
      if (nextType === type) return;
      setType(nextType);
      setTls("0");
    }}>
      {panelNodeTypes.map((item) => <option key={item}>{item}</option>)}
    </Select></label>
    <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
      {primaryFields.map((field) => !node && field.key === "tls"
        ? <label key={field.key}>{t("nodes.panel.security")}<Select name="tls" value={tls} onChange={(event) => setTls(event.target.value)}>
          <option value="0">{t("nodes.panel.noTls")}</option>
          <option value="1">TLS</option>
          {type === "vless" && <option value="2">{t("nodes.panel.reality")}</option>}
        </Select></label>
        : <NodeField key={field.key} field={field} value={node?.fields[field.key]} editing={Boolean(node)} catalog={catalog} type={type} nodeId={node?.id} />)}
      {reality && <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:col-span-2">
        <label className="block">{t("nodes.panel.realitySni")}
          <Input name="reality_sni" dir="ltr" className="tech" required autoComplete="off" placeholder="www.example.com" />
        </label>
        <p className="text-xs leading-6 text-muted-foreground">{t("nodes.panel.realityHint")}</p>
      </div>}
      {advancedFields.length > 0 && <details className="rounded-lg border border-border p-3 sm:col-span-2">
        <summary className="cursor-pointer font-medium">{t("nodes.panel.advanced")}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {advancedFields.map((field) => <NodeField key={field.key} field={field} value={undefined} editing={false} catalog={catalog} type={type} />)}
        </div>
      </details>}
    </fieldset>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button type="submit" disabled={pending}>{pending ? t("nodes.panel.saving") : t("nodes.panel.save")}</Button>
  </form>;
}

function fieldValue(field: PanelField, data: FormData, invalid: (label: string) => string) {
  if (field.kind === "groups" || field.kind === "routes") return data.getAll(field.key).map(Number);
  const raw = String(data.get(field.key) ?? "").trim();
  if (field.kind === "tags") return raw.split(/[,،\n]/).map((tag) => tag.trim()).filter(Boolean);
  if (!raw) return null;
  if (field.kind === "number" || field.kind === "parent") return Number(raw);
  if (field.kind !== "json") return raw;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch { throw new Error(invalid(field.label)); }
}

function NodeField({ field, value, editing, catalog, type, nodeId }: {
  field: PanelField; value: unknown; editing: boolean; catalog: PanelAdminNodes; type: PanelNodeType; nodeId?: number;
}) {
  const { t } = useI18n();
  const label = t(field.label);
  const automaticPort = !editing && field.key === "server_port";
  const initial = value == null ? (editing || automaticPort ? "" : field.initial ?? "") : Array.isArray(value) ? value.join(", ") : String(value);
  const props = { name: field.key, required: field.required && !automaticPort };
  if (field.kind === "groups" || field.kind === "routes") {
    const items = field.kind === "groups" ? catalog.groups : catalog.routes;
    const selected = Array.isArray(value) ? value.map(String)
      : !editing && field.kind === "groups" && items.length === 1 ? [String(items[0].id)] : [];
    return <label>{label}<Select {...props} multiple defaultValue={selected}>
      {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </Select>{field.kind === "groups" && items.length === 0 && <span className="text-xs text-muted-foreground">{t("nodes.panel.createGroup")}</span>}</label>;
  }
  if (field.kind === "parent") return <label>{label}<Select {...props} defaultValue={initial}>
    <option value="">{t("nodes.panel.noParent")}</option>
    {catalog.nodes.filter((item) => item.type === type && item.id !== nodeId).map((item) =>
      <option key={item.id} value={item.id}>{String(item.fields.name ?? item.id)}</option>)}
  </Select></label>;
  if (field.kind === "json" && field.subfields) return <NestedSettings field={field} value={value} />;
  if (field.kind === "json") return <label className="sm:col-span-2">{label}<Textarea {...props} dir="ltr" spellCheck={false}
    className="tech font-mono" defaultValue={value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2)} placeholder="{}" /></label>;
  if (field.choices) return <label>{label}<Select {...props} defaultValue={initial}>
    {!field.required && <option value="">—</option>}
    {initial && !field.choices.includes(initial) && <option>{initial}</option>}
    {field.choices.map((item) => <option key={item}>{item}</option>)}
  </Select></label>;
  const placeholder = automaticPort ? t("nodes.panel.autoPort")
    : !editing && field.key === "obfs_password" ? t("nodes.panel.autoObfs") : undefined;
  return <label>{label}<Input {...props} dir={ltrKeys.has(field.key) ? "ltr" : "auto"} className={ltrKeys.has(field.key) ? "tech" : undefined} type={field.kind === "number" ? "number" : "text"}
    step={field.kind === "number" ? "any" : undefined} defaultValue={initial} placeholder={placeholder} />
    {automaticPort && <span className="text-xs text-muted-foreground">{t("nodes.panel.portRange")}</span>}
  </label>;
}

function NestedSettings({ field, value }: { field: PanelField; value: unknown }) {
  const { t } = useI18n();
  const label = t(field.label);
  const [raw, setRaw] = useState(() => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  let settings: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // Keep an in-progress JSON edit available in the advanced field.
  }

  function update(key: string, input: string, numeric?: boolean) {
    if (!settings) return;
    const next = { ...settings };
    if (input) next[key] = numeric ? Number(input) : input;
    else delete next[key];
    setRaw(Object.keys(next).length ? JSON.stringify(next, null, 2) : "");
  }

  return <details className="space-y-3 rounded-lg border border-border p-3 sm:col-span-2">
    <summary className="cursor-pointer font-medium">{label}</summary>
    {settings && <div className="grid gap-2 sm:grid-cols-2">{field.subfields?.map(({ key, label: subLabel, choices, numeric }) => {
      const current = String(settings[key] ?? "");
      return <label key={key}>{t(subLabel)}{choices ? <Select value={current} onChange={(event) => update(key, event.target.value, numeric)}>
        <option value="">—</option>
        {current && !choices.includes(current) && <option>{current}</option>}
        {choices.map((choice) => <option key={choice}>{choice}</option>)}
      </Select> : <Input value={current} dir="ltr" className="tech" onChange={(event) => update(key, event.target.value, numeric)} />}</label>;
    })}</div>}
    <label className="block">{t("nodes.panel.advancedOf", { field: label })}<Textarea name={field.key} dir="ltr" spellCheck={false} className="tech font-mono"
      value={raw} onChange={(event) => setRaw(event.target.value)} placeholder="{}" /></label>
  </details>;
}
