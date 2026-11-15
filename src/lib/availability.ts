import type { AvailabilityCount } from "@/types";

export function addAvailability(total: AvailabilityCount, next: AvailabilityCount) {
  return { successful: total.successful + next.successful, samples: total.samples + next.samples };
}

export function availabilityCount(counts: Partial<Record<string, AvailabilityCount>> | undefined, id: string) {
  return counts && Object.hasOwn(counts, id) ? counts[id] : undefined;
}

export function availabilityPct(count?: AvailabilityCount) {
  return count?.samples ? count.successful / count.samples * 100 : null;
}
