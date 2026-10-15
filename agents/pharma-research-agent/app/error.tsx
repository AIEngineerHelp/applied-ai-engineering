"use client";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-start justify-center px-6">
      <h1 className="text-[22px] font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-[14px] text-muted-foreground">The page couldn&apos;t load. Your reports are safe — try again in a moment.{error.digest ? ` (Reference ${error.digest})` : ""}</p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
