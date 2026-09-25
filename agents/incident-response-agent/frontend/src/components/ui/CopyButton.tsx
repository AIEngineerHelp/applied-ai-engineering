'use client';

import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useToast } from './Toast';

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const { toast } = useToast();

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ kind: 'error', title: 'Could not copy to clipboard' });
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-subtle transition-colors duration-150 hover:bg-hover hover:text-fg max-md:h-11 max-md:w-11',
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-fg" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
