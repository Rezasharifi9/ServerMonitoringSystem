import type { Metadata } from "next";
import { AdminLogin } from "@/components/layout/admin-login";

export const metadata: Metadata = { title: "Sign in | NodeGuard" };

export default function LoginPage() {
  return <AdminLogin />;
}
