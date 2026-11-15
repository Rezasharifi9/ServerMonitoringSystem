import { Suspense } from "react";
import { TunnelDetailView } from "@/components/views/tunnels";
import { Skeleton } from "@/components/ui/kit";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <TunnelDetailView />
    </Suspense>
  );
}
