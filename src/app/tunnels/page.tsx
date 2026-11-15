import { TunnelsView } from "@/components/views/tunnels";

export default async function Page({ searchParams }: { searchParams: Promise<{ server?: string | string[] }> }) {
  const { server } = await searchParams;
  return <TunnelsView serverId={typeof server === "string" ? server : undefined} />;
}
