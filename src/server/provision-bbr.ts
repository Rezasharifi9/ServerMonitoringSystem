import type { ProvisionProfile } from "@/types";
import { digest } from "./auth";

export const bbrProfileId = "nodeguard-bbr-v1";
const recipe = { id: bbrProfileId, component: "BBR", version: "1" };
const manifest = JSON.stringify(recipe);
const sha256 = digest(manifest);

export function bbrProfile(serverId: string): ProvisionProfile {
  return { ...recipe, serverId, sha256, summary: "فعال‌سازی الگوریتم BBR در هستهٔ لینوکس" };
}

export function builtInBbrManifest(profile: ProvisionProfile) {
  if (profile.id === recipe.id && profile.component === recipe.component &&
      profile.version === recipe.version && profile.sha256 === sha256) return manifest;
}
