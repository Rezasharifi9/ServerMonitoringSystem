import type { Metadata } from "next";
import { StatusPage } from "@/components/views/public-status";
import { publicStatus } from "@/server/public-status";

export const metadata: Metadata = { title: "وضعیت نودهای V2ray | NodeGuard", description: "وضعیت اتصال نودهای V2ray، پایداری و کیفیت سرویس" };

export default async function Page() {
  const initialData = await publicStatus().catch(() => undefined);
  return <StatusPage initialData={initialData} />;
}
