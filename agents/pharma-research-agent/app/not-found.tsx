import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center px-6">
      <p className="text-[13px] font-medium text-muted-foreground">404</p>
      <h1 className="mt-1 text-[24px] font-semibold tracking-tight">Report not found</h1>
      <p className="mt-2 text-[14px] text-muted-foreground">It may have been deleted, the share link turned off, or it belongs to another browser.</p>
      <Button asChild className="mt-6">
        <Link href="/">Start new research</Link>
      </Button>
    </main>
  );
}
