import type { Server, ServerRole } from "@/types";

export const LINUX_DISTRIBUTIONS = [
  "Ubuntu", "Debian", "AlmaLinux", "Rocky Linux", "CentOS Stream", "CentOS", "Red Hat Enterprise Linux",
  "Fedora", "Oracle Linux", "Amazon Linux", "openSUSE", "SUSE Linux Enterprise", "Arch Linux", "Alpine Linux",
  "Linux Mint", "Gentoo", "Other Linux",
] as const;

export const serverRoleLabel: Record<ServerRole, string> = {
  iran: "سرور ایران",
  "iran-primary": "سرور ایران",
  foreign: "سرور خارج",
  "iran-backup": "سرور ایران",
};

export function asciiDigits(value: string) {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩".indexOf(digit) % 10));
}

export function serverIdentifier(server: Pick<Server, "countryCode" | "publicIpv4">) {
  return `${server.countryCode}-${server.publicIpv4}`;
}
