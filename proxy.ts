import { NextResponse, type NextRequest } from 'next/server';

const LIMIT = 60; // requests per window per IP
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

// Exact paths that are never limited: Stripe retries legitimately, and email/send is called
// by Supabase edge functions that share egress IPs (it is already secret-authenticated).
const EXEMPT = new Set(['/api/stripe/webhook', '/api/email/send']);

// ponytail: per-instance memory, resets on cold start and is not shared across
// instances/regions. Upgrade to Upstash/Redis (@upstash/ratelimit) for multi-instance.
const hits = new Map<string, { count: number; resetAt: number }>();
let lastSweep = 0;

// Assumes the platform sets the real client IP (Vercel overwrites these headers). Behind a
// proxy that only appends to x-forwarded-for, the leftmost entry is attacker-controlled; use
// the rightmost entry added by your own proxy instead.
function clientIp(headers: Headers) {
  return (
    headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() ||
    headers.get('x-real-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  );
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/+$/, '');
  if (EXEMPT.has(path)) return NextResponse.next();

  const ip = clientIp(request.headers);
  const now = Date.now();

  let entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (hits.size >= MAX_KEYS) {
      // Sweep expired keys at most once per window, then evict oldest so memory stays bounded
      // even if an attacker rotates keys (which can reset other clients' counters).
      if (now - lastSweep >= WINDOW_MS) {
        lastSweep = now;
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      while (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value as string);
    }
    entry = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(ip, entry);
  }

  if (++entry.count > LIMIT) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((entry.resetAt - now) / 1000)) } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
