import { execFile, execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerPing } from "@/types";
import { readWorkspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { publicIp } from "./public-https";

const probes = new Map<string, { expires: number; result: Promise<ServerPing> }>();
const distributed = new Map<string, { expires: number; result: ReturnType<typeof checkHost> }>();

async function checkHost(ip: string) {
  const fetchJson = async (path: string) => {
    const response = await fetch("https://check-host.net/" + path, {
      headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000), cache: "no-store",
    });
    if (!response.ok) throw new Error("CheckHost request failed");
    return await response.json();
  };
  try {
    const task = await fetchJson("check-ping?" + new URLSearchParams({ host: ip, max_nodes: "3" }));
    if (task.ok !== 1 || typeof task.request_id !== "string" || !/^[a-z\d]{1,64}$/i.test(task.request_id) || !task.nodes) throw new Error("Invalid CheckHost request");
    const nodes = Object.keys(task.nodes).slice(0, 3);
    if (!nodes.length) throw new Error("No CheckHost nodes");
    let readings: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(1500);
      readings = await fetchJson("check-result/" + task.request_id);
      if (nodes.every((node) => readings[node] != null)) break;
    }
    return nodes.map((node) => {
      const raw = readings[node];
      const packets = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0].filter(Array.isArray).slice(0, 10) : [];
      const ok = packets.filter(([status, sec]) => status === "OK" && typeof sec === "number" && sec >= 0 && sec <= 120);
      const location = Array.isArray(task.nodes[node]) ? task.nodes[node].slice(1, 3).filter((value: unknown) => typeof value === "string").join(" / ") : node;
      return { node, location, rttMs: ok.length ? Math.round(ok.reduce((sum, packet) => sum + packet[1], 0) * 1000 / ok.length) : null,
        packetLoss: packets.length ? Math.round(100 * (packets.length - ok.length) / packets.length) : null };
    });
  } catch {
    throw new ApiError(502, "CHECK_HOST", "CheckHost در دسترس نیست یا نتیجهٔ معتبر برنگرداند.");
  }
}

function ping(ip: string) {
  const windows = process.platform === "win32";
  const args = windows ? ["-4", "-n", "1", "-w", "1500", ip] : ["-4", "-n", "-c", "1", "-W", "2", ip];
  return new Promise<ServerPing>((resolve) => {
    execFile(windows ? "ping.exe" : "ping", args, { timeout: 3500, windowsHide: true }, (error, stdout) => {
      let status: ServerPing["status"] = "unavailable";
      if (!error) status = windows && !/\bTTL=\d+/i.test(stdout) ? "unreachable" : "reachable";
      else if (error.code === 1) status = "unreachable";
      const match = status === "reachable" ? /\btime[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i.exec(stdout) : null;
      resolve({ status, checkedAt: new Date().toISOString(), rttMs: match ? Number(match[1].replace(",", ".")) : undefined });
    });
  });
}

export function probeAddress(ip: string): ServerPing["status"] {
  if (isIP(ip) !== 4) return "unavailable";
  const windows = process.platform === "win32";
  const args = windows ? ["-4", "-n", "1", "-w", "1500", ip] : ["-4", "-n", "-c", "1", "-W", "2", ip];
  try {
    const stdout = execFileSync(windows ? "ping.exe" : "ping", args, { timeout: 3500, windowsHide: true, encoding: "utf8" });
    return windows && !/\bTTL=\d+/i.test(stdout) ? "unreachable" : "reachable";
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    const stdout = typeof error === "object" && error && "stdout" in error ? String(error.stdout ?? "") : "";
    if (code === 1 || (windows && stdout.length > 0 && !/\bTTL=\d+/i.test(stdout))) return "unreachable";
    return "unavailable";
  }
}

function inventoryIp(id: string) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "پینگ واقعی در حالت پایش در دسترس است.");
  const server = readWorkspace().state.servers.find((item) => item.id === id);
  if (!server) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
  const ip = server.publicIpv4;
  if (isIP(ip) !== 4) throw new ApiError(422, "PUBLIC_IPV4", "سرور IPv4 معتبر ندارد.");
  return ip;
}

export function pingInventoryServer(id: string) {
  const ip = inventoryIp(id);
  const cached = probes.get(ip);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (probes.size >= 512) probes.delete(probes.keys().next().value!);
  const result = ping(ip);
  probes.set(ip, { result, expires: Date.now() + 15000 });
  return result;
}

export function checkHostInventoryServer(id: string) {
  const ip = inventoryIp(id);
  if (!publicIp(ip)) throw new ApiError(422, "PUBLIC_IPV4", "CheckHost به IPv4 عمومی نیاز دارد.");
  const cached = distributed.get(ip);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (distributed.size >= 128) distributed.delete(distributed.keys().next().value!);
  const result = checkHost(ip);
  distributed.set(ip, { expires: Date.now() + 30000, result });
  return result;
}
