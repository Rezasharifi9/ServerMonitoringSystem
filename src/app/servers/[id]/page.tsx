import { Suspense } from "react";
import { ServerDetailView } from "@/components/views/server-detail";
import { Skeleton } from "@/components/ui/kit";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <ServerDetailView />
    </Suspense>
  );
}
