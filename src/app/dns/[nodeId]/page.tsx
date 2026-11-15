import { Suspense } from "react";
import { DnsDetailView } from "@/components/views/dns";
import { Skeleton } from "@/components/ui/kit";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <DnsDetailView />
    </Suspense>
  );
}
