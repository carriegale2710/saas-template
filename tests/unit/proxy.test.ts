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

  it('limits paths that merely start with the webhook path', () => {
    for (let i = 0; i < 60; i++) expect(proxy(req('/api/stripe/webhookx', '4.4.4.4')).status).toBe(200);
    expect(proxy(req('/api/stripe/webhookx', '4.4.4.4')).status).toBe(429);
  });

  it('never limits email/send (called by shared-egress edge functions)', () => {
    for (let i = 0; i < 100; i++) expect(proxy(req('/api/email/send', '5.5.5.5')).status).toBe(200);
  });

  it('prefers x-vercel-forwarded-for over a spoofable x-forwarded-for', () => {
    const spoof = (n: number) =>
      new NextRequest('http://localhost:3000/api/user/delete', {
        headers: { 'x-vercel-forwarded-for': '6.6.6.6', 'x-forwarded-for': `9.9.9.${n}` },
      });
    for (let i = 0; i < 60; i++) expect(proxy(spoof(i)).status).toBe(200);
    expect(proxy(spoof(99)).status).toBe(429);
  });

  it('keeps working (bounded) when more than 10k distinct IPs show up', () => {
    for (let i = 0; i < 10_050; i++) proxy(req('/api/user/delete', `10.${i >> 8}.${i & 255}.1`));
    const ip = '11.11.11.11';
    for (let i = 0; i < 60; i++) expect(proxy(req('/api/user/delete', ip)).status).toBe(200);
    expect(proxy(req('/api/user/delete', ip)).status).toBe(429);
  });
});
