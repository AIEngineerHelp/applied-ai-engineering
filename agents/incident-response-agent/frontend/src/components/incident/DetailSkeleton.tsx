import { Skeleton } from '../ui/Skeleton';
import { RunTimelineSkeleton } from './RunTimeline';

export function DetailSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading incident">
      <div className="space-y-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-2 gap-4 border-y border-border py-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3 rounded-lg border border-border p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <RunTimelineSkeleton />
      </div>
    </div>
  );
}
