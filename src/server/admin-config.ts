import type { DemoUser } from "@/types";

export const adminAccount: DemoUser = {
  id: "usr-reza", name: "مدیر", role: "super-admin", email: "",
};

export const adminHashPattern = /^scrypt:([a-f\d]{32}):([a-f\d]{64})$/;

export function adminConfig() {
  const username = process.env.NODEGUARD_ADMIN_USER;
  const hash = process.env.NODEGUARD_ADMIN_PASSWORD_HASH;
  if (username === undefined && hash === undefined) return null;
  if (!username || !/^[a-z\d_.@-]{1,64}$/i.test(username) || !hash || !adminHashPattern.test(hash)) {
    throw new Error("Invalid NodeGuard single-admin configuration");
  }
  return { username, hash };
}
