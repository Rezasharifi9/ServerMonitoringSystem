import type { TunnelDeployment } from "@/types";

export function tunnelInstallationWarning(run: Pick<TunnelDeployment, "status" | "steps">, messages: string[] = []): TunnelDeployment["warning"] {
  if (["succeeded", "destroyed"].includes(run.status) ||
      !run.steps.some(({ job }) => job.status === "failed" && job.detail === "tcp_target_unreachable")) return undefined;
  return messages.some(message => /(?:cert(?:ificate)?|acme|letsencrypt)/i.test(message) &&
    /(?:error|failed|invalid|refused|unable)/i.test(message)) ? "tls_certificate" : "destination_service";
}
