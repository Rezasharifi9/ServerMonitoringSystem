import { Suspense } from "react";
import { NodeDetailView } from "@/components/views/node-detail";
import { Skeleton } from "@/components/ui/kit";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <NodeDetailView />
    </Suspense>
  );
}
