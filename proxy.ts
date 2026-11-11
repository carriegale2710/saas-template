import { NextResponse, type NextRequest } from 'next/server';

const LIMIT = 60; // requests per window per IP
const WINDOW_MS = 60_000;

// ponytail: per-instance memory, resets on cold start and is not shared across
// instances/regions. Upgrade to Upstash/Redis (@upstash/ratelimit) for multi-instance.
const hits = new Map<string, { count: number; resetAt: number }>();

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/stripe/webhook')) return NextResponse.next();

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const now = Date.now();

  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  let entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
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
