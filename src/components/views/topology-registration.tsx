"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Input, Label, Select } from "@/components/ui/kit";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useI18n } from "@/i18n/provider";
import { BUNDLE_TECHS, FORWARDER_TECHS, isIranServer, tunnelKind, TUNNEL_TECHS } from "@/lib/topology";
import { registrationPrimaryRoutes } from "@/lib/tunnel-registration";
import { serverIdentifier } from "@/lib/server-inventory";
import { registerInventory, syncBackend } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";
import type { Server, Tunnel, TunnelNodeRef, TunnelTech } from "@/types";
import { useV2BoardCatalog } from "./v2board-inventory";

const read = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const isolate = (value: string) => `\u2066${value}\u2069`;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <Label className="grid gap-1.5">{label}{children}</Label>;
}

function RegistrationDialog({
  title, children, payload, reset,
}: {
  title: string;
  children: ReactNode;
  payload: (form: FormData) => object;
  reset: () => void;
}) {
  const { t, copy } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return <Dialog open={open} onOpenChange={(next) => {
    if (busy) return;
    setOpen(next);
    if (next) { setError(""); reset(); }
  }}>
    <Button variant="outline" onClick={() => { setError(""); reset(); setOpen(true); }}>{title}</Button>
    <DialogContent title={title}>
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          const item = await registerInventory("tunnels", payload(fields));
          await syncBackend();
          setOpen(false);
          if (item.dns?.status === "failed") toast.warning(t("nodes.topology.savedDns", { message: copy(item.dns.message ?? "") }));
          else toast.success(item.dns ? t("nodes.topology.savedConfirmed") : t("nodes.topology.saved"));
          router.push(`/tunnels/${encodeURIComponent(item.id)}`);
        } catch (cause) {
          setError(cause instanceof Error ? copy(cause.message) : t("nodes.topology.failed"));
        } finally {
          setBusy(false);
        }
      }}>
        <p className="text-sm text-muted-foreground">{t("nodes.topology.intro")}</p>
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">{children}</fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy}>{busy ? t("nodes.topology.saving") : t("nodes.topology.save")}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function RegisterTunnelButton({ servers }: { servers: Server[] }) {
  const { t } = useI18n();
  const nodes = useInfraStore((state) => state.nodes);
  const catalog = useV2BoardCatalog(true);
  const [side, setSide] = useState<Tunnel["side"] | "">("");
  const tunnels = useInfraStore((state) => state.tunnels);
  const [nodeValue, selectNode] = useState("");
  const [foreign, setForeign] = useState("");
  const [technology, setTechnology] = useState<TunnelTech>("GRE");
  const [iran, setIran] = useState("");
  const [routeKey, setRouteKey] = useState("");
  const hasInterface = tunnelKind(technology) === "interface";
  const automaticPort = FORWARDER_TECHS.some(item => item === technology) || BUNDLE_TECHS.some((item) => item === technology);
  const iranHosts = servers.filter((server) => isIranServer(server.roles));
  const options: { value: string; label: string; ref: TunnelNodeRef }[] = [];
  for (const node of nodes) {
    options.push({ value: `node:${node.id}`, label: node.name, ref: { kind: "inventory", id: node.id } });
  }
  for (const node of catalog.data?.nodes ?? []) {
    if (!node.nodeId) options.push({ value: `v2board:${node.key}`, label: node.name || node.key, ref: { kind: "v2board", key: node.key } });
  }

  const selected = options.find(option => option.value === nodeValue);
  const primaries = selected ? registrationPrimaryRoutes(selected.ref, nodes, tunnels) : [];
  const destinationIds = new Set(primaries.map(path => path.foreignEndpoint.serverId));
  const foreignHosts = servers.filter(server => server.roles.includes("foreign") && server.id !== iran &&
    (side !== "backup" || destinationIds.has(server.id)));

  return <RegistrationDialog title={t("nodes.topology.register")} reset={() => { setSide(""); selectNode(""); setForeign(""); setTechnology("GRE"); setIran(""); setRouteKey(crypto.randomUUID()); }} payload={(form) => {
    if (!side) throw new Error(t("nodes.topology.chooseRole"));
    const selected = options.find(({ value }) => value === read(form, "node"));
    if (!selected) throw new Error(t("nodes.topology.nodeRequired"));
    if (!foreignHosts.some(server => server.id === read(form, "foreignServerId"))) throw new Error(t("nodes.topology.noPrimaryDestination"));
    return {
      nodeRef: selected.ref, technology, side, routeKey,
      iranServerId: read(form, "iranServerId"), foreignServerId: read(form, "foreignServerId"),
      mtu: Number(read(form, "mtu") || 1400), port: automaticPort ? undefined : Number(read(form, "port")),
      ...(technology === "GRE" ? { greTransport: read(form, "greTransport") } : {}),
    };
  }}>
    <Field label={t("nodes.topology.role")}><Select name="side" required value={side} onChange={event => {
      setSide(event.target.value as Tunnel["side"]); selectNode(""); setForeign(""); setIran("");
    }}>
      <option value="" disabled>{t("nodes.topology.chooseRole")}</option>
      <option value="primary">{t("nodes.topology.primary")}</option><option value="backup">{t("nodes.topology.backup")}</option>
    </Select></Field>
    <Field label={t("nodes.topology.node")}>
      <Select name="node" required disabled={!side} value={nodeValue} onChange={event => { selectNode(event.target.value); setForeign(""); setIran(""); }}>
        <option value="" disabled>{options.length ? t("nodes.topology.chooseNode") : catalog.isPending ? t("nodes.topology.loadingNodes") : t("nodes.topology.noDomainNode")}</option>
        {options.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </Select>
    </Field>
    <Field label={t("nodes.topology.foreign")}><Select name="foreignServerId" required disabled={!selected || !side || !foreignHosts.length} value={foreign} onChange={event => setForeign(event.target.value)}>
      <option value="">{t("nodes.topology.chooseServer")}</option>
      {foreignHosts.map((server) => <option key={server.id} value={server.id}>{isolate(serverIdentifier(server))}</option>)}
    </Select></Field>
    {side === "backup" && selected && !foreignHosts.length && <p role="status" className="text-sm text-destructive sm:col-span-2">{t("nodes.topology.noPrimaryDestination")}</p>}
    <Field label={t("nodes.topology.iran")}><Select name="iranServerId" disabled={!foreign} value={iran} onChange={(event) => setIran(event.target.value)} required>
      <option value="">{t("nodes.topology.chooseServer")}</option>
      {iranHosts.map((server) => <option key={server.id} value={server.id}>{isolate(serverIdentifier(server))}</option>)}
    </Select></Field>
    {catalog.isError && <p className="text-xs text-muted-foreground sm:col-span-2">{t("nodes.topology.catalogFailed")} <Button type="button" variant="ghost" size="sm" onClick={() => void catalog.refetch()}>{t("common.retry")}</Button></p>}
    <Field label={t("nodes.topology.technology")}><Select value={technology} onChange={(event) => setTechnology(event.target.value as TunnelTech)}>
      {TUNNEL_TECHS.map((item) => <option key={item} value={item}>{item}</option>)}
    </Select></Field>
    {technology === "GRE" && <Field label={t("tunnels.greTransport.label")}><Select name="greTransport" defaultValue="udp">
      <option value="native">{t("tunnels.greTransport.native")}</option>
      <option value="udp">{t("tunnels.greTransport.udp")}</option>
    </Select></Field>}
    {side === "backup" && <p className="text-sm text-muted-foreground sm:col-span-2">
      {t("nodes.topology.backupHint")}
    </p>}
    {automaticPort ? <p className="text-sm text-muted-foreground sm:col-span-2">{t("nodes.topology.portFromNode")}</p>
      : <Field label={t("nodes.topology.port")}><Input name="port" dir="ltr" className="tech" type="number" min={1} max={65535} step={1} required /></Field>}
    {hasInterface ? <>
      <Field label={t("nodes.topology.localSource")}><Input readOnly value={t("nodes.topology.autoAssign")} /></Field>
      <Field label={t("nodes.topology.localDest")}><Input readOnly value={t("nodes.topology.autoAssign")} /></Field>
      <Field label={t("nodes.topology.mtu")}><Input name="mtu" dir="ltr" className="tech" type="number" min={technology === "SIT" ? 1280 : 576} max={9000} defaultValue={1400} required /></Field>
    </> : <p className="text-sm text-muted-foreground sm:col-span-2">{t("nodes.topology.forwarderNote")}</p>}
  </RegistrationDialog>;
}
