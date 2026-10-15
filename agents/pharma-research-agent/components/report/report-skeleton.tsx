import { Skeleton } from "@/components/ui/skeleton";

export function ReportSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pt-6 sm:px-6 lg:px-10 lg:pt-10" aria-busy="true" aria-label="Loading report">
      <Skeleton className="h-8 w-3/4 max-w-[640px]" />
      <Skeleton className="mt-3 h-4 w-1/2 max-w-[420px]" />
      <div className="mt-10 grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${88 - (i % 3) * 9}%` }} />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
    </div>
  );
}
