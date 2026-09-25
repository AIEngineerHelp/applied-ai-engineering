import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:opacity-85',
  secondary: 'border border-border-strong bg-bg text-fg hover:bg-hover',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg',
  danger: 'border border-border-strong bg-bg text-danger-fg hover:bg-hover',
};

/* 32px on desktop, 44px touch targets below md. */
const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 max-md:h-11 max-md:px-3',
  md: 'h-8 px-3 text-[13px] gap-1.5 max-md:h-11 max-md:px-4',
  icon: 'h-8 w-8 justify-center max-md:h-11 max-md:w-11',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center rounded-md font-medium whitespace-nowrap transition-[background-color,opacity,color] duration-150 ease-out select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        '[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5]',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <LoaderCircle aria-hidden className="animate-spin" />}
      {children}
    </button>
  );
});
