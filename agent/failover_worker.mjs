import { setTimeout as delay } from "node:timers/promises";

const endpoint = new URL(process.env.NODEGUARD_CONTROL_URL ?? "http://127.0.0.1:3000");
const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
const modes = [
  { flag: "--failover", token: "NODEGUARD_FAILOVER_WORKER_TOKEN", path: "failover/worker/tick", name: "Failover" },
  { flag: "--telegram", token: "NODEGUARD_TELEGRAM_WORKER_TOKEN", path: "notifications/telegram/tick", name: "Telegram" },
  { flag: "--dns", token: "NODEGUARD_DNS_WORKER_TOKEN", path: "dns/monitor/tick", name: "DNS" },
  { flag: "--health", token: "NODEGUARD_HEALTH_WORKER_TOKEN", path: "health/worker/tick", name: "Agent health" },
  { flag: "--v2board", token: "NODEGUARD_V2BOARD_WORKER_TOKEN", path: "providers/v2board/worker/tick", name: "V2Board", idle: "PANEL_MONITOR_DISABLED" },
];
const args = process.argv.slice(2);
const once = args.includes("--once");
const flags = args.filter((arg) => arg !== "--once");
if (flags.length > 1) throw new Error("Select a single worker");
const mode = flags.length === 0 ? modes[0] : modes.find(({ flag }) => flag === flags[0]);
if (!mode) throw new Error("Unknown worker. Select --failover, --telegram, --dns, --health or --v2board");
const token = process.env[mode.token] ?? "";
const route = "/api/v1/" + mode.path;
const worker = mode.name;
if ((!local && endpoint.protocol !== "https:") || !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
    !/^[^\s]{32,256}$/.test(token)) {
  throw new Error("Set NODEGUARD_CONTROL_URL and the " + worker + " worker token");
}

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
do {
  try {
    const response = await fetch(new URL(route, endpoint), {
      method: "POST", headers: { Authorization: "Bearer " + token }, redirect: "error",
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(25000)]),
    });
    if (!response.ok) {
      const idle = !once && mode.idle && response.status === 503 &&
        (await response.json().catch(() => null))?.error?.code === mode.idle;
      if (!idle) console.error(worker + " worker HTTP", response.status);
      if ([401, 403].includes(response.status) || once) process.exitCode = 1;
    } else {
      const { data } = await response.json();
      if (data.errors || data.prepared || data.resumed || data.standbyStarted || data.switched || data.reasons?.length || data.opened || data.synced || once) console.log(data);
      if (data.errors && once) process.exitCode = 1;
    }
  } catch {
    if (!stop.signal.aborted) {
      console.error(worker + " worker could not reach the control plane");
      if (once) process.exitCode = 1;
    }
  }
  if (stop.signal.aborted || process.exitCode || once) break;
  await delay(5000, undefined, { signal: stop.signal }).catch((error) => {
    if (!stop.signal.aborted) throw error;
  });
} while (!stop.signal.aborted);
