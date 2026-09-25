/**
 * API base URL, inlined at build time. An empty string means "same origin"
 * (the ingress routes /v1 to the API), so requests use relative URLs.
 */
const raw = process.env.NEXT_PUBLIC_API_URL;
export const API_BASE_URL = (raw ?? 'http://localhost:8000').replace(/\/+$/, '');

/** Human-readable description of where the API lives, for error messages. */
export function apiLocation(): string {
  if (API_BASE_URL) return API_BASE_URL;
  return typeof window === 'undefined' ? 'this origin' : window.location.origin;
}

export const AUTH_CALLBACK_PATH = '/auth/callback';
