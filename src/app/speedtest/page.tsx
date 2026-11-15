import { Suspense } from "react";
import { SpeedtestView } from "@/components/views/speedtest";
import { Skeleton } from "@/components/ui/kit";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <SpeedtestView />
    </Suspense>
  );
}
