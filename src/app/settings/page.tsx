import { SettingsView } from "@/components/views/settings";

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <SettingsView initialTab={tab === "integrations" || tab === "failover" || tab === "telegram" ? tab : "general"} />;
}
