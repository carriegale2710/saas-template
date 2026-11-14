import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let proxy: typeof import('@/proxy').proxy;

// Fresh module (and rate-limit map) per test.
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VERCEL', '1');
  ({ proxy } = await import('@/proxy'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const url = (path: string) => `http://localhost:3000${path}`;
const req = (path: string, ip: string, init: { method?: string } = {}) =>
  new NextRequest(url(path), { ...init, headers: { 'x-vercel-forwarded-for': ip } });

const hit = (r: () => NextRequest, n: number) => {
  for (let i = 0; i < n; i++) expect(proxy(r()).status).toBe(200);
};

describe('proxy rate limiter', () => {
  it('returns 429 with Retry-After past the limit, then resets after the window', () => {
    vi.useFakeTimers();
    hit(() => req('/api/user/delete', '1.1.1.1'), 60);

    const blocked = proxy(req('/api/user/delete', '1.1.1.1'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');

    // Other IPs are counted separately.
    expect(proxy(req('/api/user/delete', '2.2.2.2')).status).toBe(200);

    vi.advanceTimersByTime(60_000);
    expect(proxy(req('/api/user/delete', '1.1.1.1')).status).toBe(200);
  });

  it('never limits the Stripe webhook, with or without a trailing slash', () => {
    hit(() => req('/api/stripe/webhook', '3.3.3.3'), 100);
    hit(() => req('/api/stripe/webhook/', '3.3.3.3'), 100);
  });

  it('limits paths that merely start with the webhook path', () => {
    hit(() => req('/api/stripe/webhookx', '4.4.4.4'), 60);
    expect(proxy(req('/api/stripe/webhookx', '4.4.4.4')).status).toBe(429);
  });

  it('never limits email/send (called by shared-egress edge functions)', () => {
    hit(() => req('/api/email/send', '5.5.5.5'), 100);
  });

  it('does not count CORS preflight (OPTIONS) requests', () => {
    hit(() => req('/api/user/delete', '12.12.12.12', { method: 'OPTIONS' }), 100);
    hit(() => req('/api/user/delete', '12.12.12.12'), 60);
  });

  it('on Vercel, uses x-vercel-forwarded-for over a spoofable x-forwarded-for', () => {
    const spoof = (n: number) =>
      new NextRequest(url('/api/user/delete'), {
        headers: { 'x-vercel-forwarded-for': '6.6.6.6', 'x-forwarded-for': `9.9.9.${n}` },
      });
    for (let i = 0; i < 60; i++) expect(proxy(spoof(i)).status).toBe(200);
    expect(proxy(spoof(99)).status).toBe(429);
  });

  it('on Vercel, falls back to x-real-ip', () => {
    const r = () => new NextRequest(url('/api/user/delete'), { headers: { 'x-real-ip': '7.7.7.7' } });
    hit(r, 60);
    expect(proxy(r()).status).toBe(429);
  });

  it('off Vercel, ignores x-vercel-forwarded-for and uses the rightmost x-forwarded-for entry', () => {
    vi.stubEnv('VERCEL', '');
    // A client can prepend anything; only the entry added by our own proxy (rightmost) counts.
    const r = (n: number) =>
      new NextRequest(url('/api/user/delete'), {
        headers: { 'x-vercel-forwarded-for': `1.2.3.${n}`, 'x-forwarded-for': `8.8.8.${n}, 10.0.0.9` },
      });
    for (let i = 0; i < 60; i++) expect(proxy(r(i)).status).toBe(200);
    expect(proxy(r(99)).status).toBe(429);
  });

  it('does not limit when there is no trusted client IP (fail open, no shared bucket)', () => {
    const r = () => new NextRequest(url('/api/user/delete'));
    hit(r, 100);
  });

  it('stays bounded and sweeps expired keys when more than 10k distinct IPs show up', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10_050; i++) proxy(req('/api/user/delete', `10.${i >> 8}.${i & 255}.1`));

    // After the window every key is expired: the next new key triggers the sweep.
    vi.advanceTimersByTime(60_001);
    const ip = '11.11.11.11';
    hit(() => req('/api/user/delete', ip), 60);
    expect(proxy(req('/api/user/delete', ip)).status).toBe(429);
  });
});
