import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoUser } from "@/types";
import { getAgentRegistration } from "./agent-enrollment";
import { readWorkspace } from "./database";
import { ApiError } from "./http";
import { iperfReceiversForHost, iperfTargetsForHost } from "./iperf-jobs";

const sourceFiles = [
  "agent_credentials.py", "nodeguard_agent.py", "nodeguard_enroll.py", "iperf_worker.py", "iperf_receiver.py", "provision_worker.py", "provision_artifacts.py",
  "nodeguard-agent.service", "nodeguard-iperf.service", "nodeguard-provision.service", "managed_link.py",
];
const marker = "BUNDLE = None  # NODEGUARD_EMBEDDED_BUNDLE";

function telemetryEndpoint(request: Request) {
  const configured = process.env.NODEGUARD_ORIGIN ?? new URL(request.url).origin;
  const origin = URL.parse(configured);
  if (!origin) throw new ApiError(503, "AGENT_INSTALLER_ORIGIN", "نشانی عمومی NodeGuard معتبر نیست.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(loopback && origin.protocol === "http:")) ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new ApiError(503, "AGENT_INSTALLER_ORIGIN", "نشانی عمومی NodeGuard باید HTTPS باشد.");
  }
  return new URL("/api/v1/agent/telemetry", origin).href;
}

export async function downloadAgentInstaller(actor: DemoUser, serverId: string, request: Request) {
  getAgentRegistration(actor, serverId);
  const { state } = readWorkspace();
  const config = {
    endpoint: telemetryEndpoint(request), serverId, tokenFile: "/etc/nodeguard/agent.token",
    interface: "eth0", intervalSec: 20,
    v2bxUnit: state.nodes.some((node) => node.foreignServerId === serverId) ? "V2bX.service" : null,
    tunnels: state.tunnels.flatMap((tunnel) => {
      const endpoint = tunnel.iranEndpoint;
      const peer = tunnel.foreignEndpoint.tunnelIp;
      return tunnel.kind === "interface" && endpoint.serverId === serverId && endpoint.interfaceName && peer
        ? [{ id: tunnel.id, interface: endpoint.interfaceName, peer }] : [];
    }).slice(0, 12),
    forwarderProbes: [], proxyProbes: [], v2bxLogTags: {},
    iperfTargets: iperfTargetsForHost(state, serverId), iperfReceivers: iperfReceiversForHost(state, serverId),
  };
  const source = (file: string) => join(process.cwd(), "agent", file);
  const [template, artifacts] = await Promise.all([
    readFile(source("install_agent.py"), "utf8"),
    Promise.all(sourceFiles.map(async (file) => {
      const code = (await readFile(source(file), "utf8")).replaceAll("\r\n", "\n");
      return [file, Buffer.from(code).toString("base64")] as const;
    })),
  ]);
  if (!template.includes(marker)) throw new Error("Agent installer bundle marker is missing");
  // Encode the configuration separately so the generated Python never interpolates user data as code.
  const bundle = Buffer.from(JSON.stringify({ config, files: Object.fromEntries(artifacts) })).toString("base64");
  const script = template.replace(marker, `BUNDLE = json.loads(b64decode("${bundle}"))`);
  return new Response(script, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="nodeguard-agent-install.py"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
