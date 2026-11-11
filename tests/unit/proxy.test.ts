import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

const req = (path: string, ip: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });

describe('proxy rate limiter', () => {
  it('returns 429 with Retry-After past the limit, then resets after the window', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 60; i++) expect(proxy(req('/api/user/delete', '1.1.1.1')).status).toBe(200);

      const blocked = proxy(req('/api/user/delete', '1.1.1.1'));
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('60');

      // Other IPs are counted separately.
      expect(proxy(req('/api/user/delete', '2.2.2.2')).status).toBe(200);

      vi.advanceTimersByTime(60_000);
      expect(proxy(req('/api/user/delete', '1.1.1.1')).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never limits the Stripe webhook', () => {
    for (let i = 0; i < 100; i++) expect(proxy(req('/api/stripe/webhook', '3.3.3.3')).status).toBe(200);
  });
});
