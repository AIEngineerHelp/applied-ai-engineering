import type { NextConfig } from 'next';

/*
 * next.config is evaluated at build time and serialized into the standalone
 * server, so the CSP is fixed per image, like NEXT_PUBLIC_API_URL itself.
 */

const isDev = process.env.NODE_ENV === 'development';

/** Origin of the API, or null when it is served from the same origin (NEXT_PUBLIC_API_URL=""). */
function apiOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
  if (!raw.trim()) return null;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_API_URL must be an absolute URL or empty, got "${raw}"`);
  }
}

/**
 * The OIDC issuer is only known at runtime (GET /v1/auth/config). The browser
 * talks to it for discovery, token exchange and refresh, so connect-src must
 * allow it. Set CSP_OIDC_ORIGIN at build time to pin it; otherwise any HTTPS
 * origin is allowed for fetch/XHR only (scripts, frames etc. stay 'self').
 */
function oidcOrigins(): string[] {
  const pinned = process.env.CSP_OIDC_ORIGIN?.trim();
  if (pinned) return pinned.split(/[\s,]+/).filter(Boolean);
  return isDev ? ['https:', 'http://localhost:*', 'http://127.0.0.1:*'] : ['https:'];
}

const connectSrc = ["'self'", apiOrigin(), ...oidcOrigins(), ...(isDev ? ['ws:'] : [])].filter(
  (v): v is string => Boolean(v),
);

const csp = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; this app has no nonce-capable
  // dynamic rendering, so 'unsafe-inline' is required. React needs eval in dev only.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src ${Array.from(new Set(connectSrc)).join(' ')}`,
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // The OIDC callback URL carries a one-time code; never leak paths cross-origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
