export function agentIsSilent(input: {
  now: number;
  heartbeatAt: number;
  latestReportAt: number;
  windowMs: number;
}) {
  const silent = (at: number) => !Number.isFinite(at) || at <= 0 || input.now - at > input.windowMs || at > input.now + 30000;
  return silent(input.heartbeatAt) && silent(input.latestReportAt);
}

export function failoverCause(input: {
  tunnelStatus?: string;
  packetLoss?: number;
  lossThreshold: number;
  agentSilent: boolean;
}) {
  if (input.tunnelStatus === "offline") return "offline" as const;
  if (typeof input.packetLoss === "number" && input.packetLoss >= input.lossThreshold) return "loss" as const;
  if (input.agentSilent) return "agent" as const;
  return null;
}

export function hostSilenceFailover(input: {
  now: number;
  heartbeatAt: number;
  latestReportAt: number;
  windowMs: number;
  ping: "reachable" | "unreachable" | "unavailable";
}) {
  return agentIsSilent(input) && input.ping === "unreachable";
}
