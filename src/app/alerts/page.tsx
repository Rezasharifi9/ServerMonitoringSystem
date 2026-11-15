import { AlertsView } from "@/components/views/alerts";

export default async function Page({ searchParams }: PageProps<"/alerts">) {
  const scope = (await searchParams).scope === "archived" ? "archived" : "current";
  return <AlertsView key={scope} initialScope={scope} />;
}
