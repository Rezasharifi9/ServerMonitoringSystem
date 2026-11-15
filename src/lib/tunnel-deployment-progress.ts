import { BUNDLE_TECHS } from "./topology";
import type { ProvisionJob, TunnelDeployment } from "@/types";

export type CheckKey = "package" | "service" | "icmp" | "tcp" | "control";

export function deploymentChecks(run: TunnelDeployment, phase: TunnelDeployment["phase"], job: ProvisionJob): CheckKey[] {
  return ["package", job.profile.id.startsWith("tcp-") ? "tcp" : "service",
    ...(phase === "iran_apply" && BUNDLE_TECHS.some((tech) => tech === run.preview.technology) ? ["icmp" as const] : []),
    ...(phase === "iran_apply" && job.profile.forwardPort ? ["tcp" as const] : []),
    ...(phase === "iran_apply" && ["Rathole", "Backhaul"].includes(run.preview.technology) ? ["control" as const] : [])];
}

export function completedCheck(check: CheckKey, job: ProvisionJob, run: TunnelDeployment) {
  if (check === "control") return run.status === "succeeded";
  if (job.checks?.includes(check)) return true;
  if (job.status !== "succeeded") return false;
  return check === "package" || check === "service" || job.detail === "verified"
    || (check === "tcp" && job.profile.id.startsWith("tcp-"))
    || (check === "icmp" && run.status === "succeeded");
}
