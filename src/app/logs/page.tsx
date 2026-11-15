import { Suspense } from "react";
import { LogsView } from "@/components/views/logs";
import { Skeleton } from "@/components/ui/kit";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <LogsView />
    </Suspense>
  );
}
