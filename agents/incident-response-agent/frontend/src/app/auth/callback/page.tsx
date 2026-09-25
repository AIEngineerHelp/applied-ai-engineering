import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Signing in · Incident Response',
  robots: { index: false },
};

/**
 * OIDC redirect target. The code exchange happens in <AuthGate> (see
 * lib/auth.ts), which then navigates back to where the user started; this
 * page is only visible for the moment in between.
 */
export default function AuthCallbackPage() {
  return (
    <div role="status" className="flex h-full items-center justify-center p-4 text-[13px] text-fg-subtle">
      Signing you in…
    </div>
  );
}
