"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/shared/chrome";
import { Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui/kit";
import { useI18n } from "@/i18n/provider";
import { BUNDLE_TECHS } from "@/lib/topology";
import { getTunnelBundleRecipe, deployWithAgent, listV2BoardAdminNodes } from "@/services/backend";
import { useInfraStore } from "@/stores/infra-store";
import { ForwarderConfiguration } from "./forwarder-configuration";
import { V2bxFilesEditor } from "./v2bx-files";

export function AgentProvisionForm({ enabled, onDone, hostId }: { enabled: boolean; onDone: () => void; hostId?: string }) {
  const { t, copy, locale } = useI18n();
  const servers = useInfraStore((state) => state.servers);
  const tunnels = useInfraStore((state) => state.tunnels);
  const params = useSearchParams();
  const [kind, setKind] = useState<"v2bx" | "tunnel" | "rebuild">(() => {
    const mode = params.get("mode");
    return mode === "tunnel" || mode === "rebuild" ? mode : "v2bx";
  });
  const [serverId, setServer] = useState(hostId ?? params.get("serverId") ?? "");
  const [tunnelId, setTunnel] = useState(params.get("tunnelId") ?? "");
  const [architecture, setArchitecture] = useState<"amd64" | "arm64">("amd64");
  const [panelNode, setPanelNode] = useState(params.get("panelNode") ?? "");
  const [secondPanelNode, setSecondPanelNode] = useState(params.get("secondPanelNode") ?? "");
  const catalog = useQuery({ queryKey: ["v2board-admin-nodes"], queryFn: listV2BoardAdminNodes, enabled: kind === "v2bx", retry: false });
  const [iranPort, setIranPort] = useState("51820");
  const [foreignPort, setForeignPort] = useState("51820");
  const [pending, setPending] = useState(false);
  const [applyFiles, setApplyFiles] = useState(true);
  const foreignHosts = servers.filter((item) => item.roles.includes("foreign"));
  const server = foreignHosts.find((item) => item.id === serverId);
  const nodes = catalog.data?.nodes.filter((item) => !item.fields.parent_id && Boolean(server?.panelNodeRefs?.includes(`${item.type}:${item.id}`))) ?? [];
  const chosenNode = nodes.find((item) => `${item.type}:${item.id}` === panelNode);
  const secondNode = nodes.find((item) => `${item.type}:${item.id}` === secondPanelNode && `${item.type}:${item.id}` !== panelNode);
  const nodeLabel = ({ type, id, fields }: (typeof nodes)[number]) => `${String(fields.name)} · ${type}:${id}`;
  const choices = tunnels.filter((item) => BUNDLE_TECHS.some((technology) => technology === item.technology) || ["GOST", "Rathole", "Backhaul"].includes(item.technology));
  const tunnel = tunnelId ? choices.find((item) => item.id === tunnelId) : choices[0];
  const recipe = useQuery({ queryKey: ["tunnel-bundle-recipe", tunnel?.id],
    queryFn: () => getTunnelBundleRecipe(tunnel!.id), enabled: kind !== "v2bx" && Boolean(tunnel), retry: false });
  const wireguard = tunnel?.technology === "WireGuard";
  const forwardPort = recipe.data?.port;
  const targetPort = recipe.data?.targetPort ?? forwardPort;
  const peer = tunnel?.technology === "GOST" ? tunnel.foreignEndpoint.publicIp : tunnel?.foreignEndpoint.tunnelIp;
  const target = `${peer?.includes(":") ? `[${peer}]` : peer}:${targetPort}`;

  return <Card>
    <CardHeader><CardTitle>{t(kind === "v2bx" ? "deployments.agent.installV2bx" : kind === "rebuild" ? "deployments.agent.rebuild" : "deployments.agent.deployPath")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">

      {!enabled && <p className="text-muted-foreground">{t("deployments.agent.disabled")}</p>}
      {!hostId && <label className="block">{t("deployments.agent.operation")}<Select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
        <option value="v2bx">{t("deployments.agent.installV2bx")}</option><option value="tunnel">{t("deployments.agent.deployPath")}</option><option value="rebuild">{t("deployments.agent.rebuild")}</option>
      </Select></label>}
      {kind === "v2bx" ? <div className="grid gap-2 md:grid-cols-2">
        <label>{t("deployments.agent.foreignServer")}<Select value={server?.id ?? ""} onChange={(event) => setServer(event.target.value)}>
          <option value="">{foreignHosts.length ? t("deployments.agent.chooseForeign") : t("deployments.agent.registerForeignFirst")}</option>
          {foreignHosts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select></label>
        <label>{t("deployments.agent.architecture")}<Select value={architecture} onChange={(event) => setArchitecture(event.target.value === "arm64" ? "arm64" : "amd64")}>
          <option value="amd64">amd64</option><option value="arm64">arm64</option>
        </Select></label>
        <label className="md:col-span-2">{t("deployments.agent.panelNode")}<Select value={chosenNode ? panelNode : ""} onChange={(event) => {
          const value = event.target.value;
          setPanelNode(value);
          if (value && value === secondPanelNode) setSecondPanelNode("");
        }}>
          <option value="">{catalog.isPending ? t("deployments.agent.loadingNodes") : t("deployments.agent.chooseNode")}</option>
          {nodes.map((item) => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>{nodeLabel(item)}</option>)}
        </Select></label>
        <label className="md:col-span-2">{t("deployments.agent.secondPanelNode")}<Select value={secondNode ? secondPanelNode : ""} onChange={(event) => setSecondPanelNode(event.target.value)}>
          <option value="">{t("deployments.agent.noSecondNode")}</option>
          {nodes.filter((item) => `${item.type}:${item.id}` !== panelNode).map((item) => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>{nodeLabel(item)}</option>)}
        </Select></label>
        <p className="text-muted-foreground md:col-span-2">{t("deployments.agent.secondNodeHint")}</p>
        {catalog.isError && <p className="text-destructive md:col-span-2">{copy(catalog.error.message)}</p>}
      </div> : <div className="grid gap-2 md:grid-cols-2">
        <label className="md:col-span-2">{t("deployments.agent.registeredPath")}<Select value={tunnel?.id ?? ""} onChange={(event) => setTunnel(event.target.value)}>
          {!tunnel && <option value="">{choices.length ? t("deployments.agent.choosePath") : t("deployments.agent.noPath")}</option>}
          {choices.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.technology} · {item.iranEndpoint.serverId} → {item.foreignEndpoint.serverId}</option>)}
        </Select></label>
        <Link href="/tunnels" className="text-primary md:col-span-2">{t("deployments.agent.registerPath")}</Link>
        {recipe.isError && <p className="text-muted-foreground md:col-span-2">{copy(recipe.error.message)}</p>}
        {forwardPort && <p className="md:col-span-2">{t("deployments.agent.forwardLead")} <bdi>{forwardPort}</bdi> {t("deployments.agent.forwardTo")} <bdi>{target}</bdi> {t("deployments.agent.forwardEnd")}</p>}
        {wireguard && <>
          <label>{t("deployments.agent.iranUdp")}<Input dir="ltr" type="number" min={1} max={65535} value={iranPort} onChange={(event) => setIranPort(event.target.value)} /></label>
          <label>{t("deployments.agent.foreignUdp")}<Input dir="ltr" type="number" min={1} max={65535} value={foreignPort} onChange={(event) => setForeignPort(event.target.value)} /></label>
        </>}
      </div>}
      {kind !== "v2bx" && tunnel && ["Rathole", "Backhaul"].includes(tunnel.technology) && <ForwarderConfiguration key={tunnel.id} tunnelId={tunnel.id} disabled={!enabled || pending} />}
      {kind === "v2bx" && server && <>
        <label className="flex items-center gap-2"><input type="checkbox" checked={applyFiles} disabled={pending} onChange={e => setApplyFiles(e.target.checked)} />{locale === "fa-IR" ? "اعمال فایل‌های Route و Outbound ذخیره‌شده هنگام نصب" : "Apply saved Route and Outbound files during installation"}</label>
        <V2bxFilesEditor key={server.id} serverId={server.id} disabled={!enabled || pending} />
      </>}
      <ConfirmButton label={pending ? t("deployments.agent.preparing") : kind === "rebuild" ? t("deployments.agent.autoRebuild") : t("deployments.agent.autoInstall")} title={t("deployments.confirmOperation")} confirmLabel={t("deployments.agent.confirm")}
        description={kind === "rebuild" ? t("deployments.agent.rebuildBody") : secondNode ? t("deployments.agent.installTwoBody") : t("deployments.agent.installBody")}
        disabled={!enabled || pending || (kind === "v2bx" ? !server || !chosenNode : !tunnel || (wireguard && (!iranPort || !foreignPort)))}
        onConfirm={async () => {
          setPending(true);
          try {
            if (kind === "v2bx" && server) {
              await deployWithAgent({ kind, serverId: server.id, architecture, panelNode, applyFiles, ...(secondNode ? { secondPanelNode } : {}) }, crypto.randomUUID());
            } else if (kind !== "v2bx" && tunnel) {
              await deployWithAgent({ kind: "tunnel", tunnelId: tunnel.id, iranPort: wireguard ? Number(iranPort) : undefined,
                foreignPort: wireguard ? Number(foreignPort) : undefined,
                operation: kind === "rebuild" ? "rebuild" : undefined }, crypto.randomUUID());
            }
            onDone();
            toast.success(t("deployments.agent.queued"));
          } catch (error) {
            toast.error(error instanceof Error ? copy(error.message) : t("deployments.agent.failed"));
          } finally { setPending(false); }
        }} />
    </CardContent>
  </Card>;
}
