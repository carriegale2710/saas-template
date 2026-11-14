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

// Only trust a client-IP header that your deploy target sets itself:
// - On Vercel, x-vercel-forwarded-for / x-real-ip carry the real client IP (set by the platform).
// - Elsewhere, only the rightmost x-forwarded-for entry (appended by your own reverse proxy) is
//   trustworthy; the leftmost is client-controlled. A Node server exposed directly with no
//   reverse proxy keeps a client-supplied header as is, so a client can rotate it to dodge the
//   limit; put it behind a proxy that appends the real client IP (nginx, ALB, ...).
// Returns null when there is no IP; the caller then skips limiting (fail open) rather than
// putting every client in one shared bucket.
function clientIp(headers: Headers): string | null {
  if (process.env.VERCEL) {
    return (
      headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() ||
      headers.get('x-real-ip')?.trim() ||
      null
    );
  }
  return headers.get('x-forwarded-for')?.split(',').pop()?.trim() || null;
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/+$/, '');
  // CORS preflights are not real API calls; counting them would halve a browser client's budget.
  if (EXEMPT.has(path) || request.method === 'OPTIONS') return NextResponse.next();

  const ip = clientIp(request.headers);
  if (!ip) return NextResponse.next();
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
