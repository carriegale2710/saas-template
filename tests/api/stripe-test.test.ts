import { beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveBalance = vi.fn();
const stripe = { balance: { retrieve: (...args: unknown[]) => retrieveBalance(...args) } };

vi.mock('@/utils/stripe-server', () => ({ getStripeClient: () => stripe }));

import { GET } from '@/app/api/stripe/test/route';

const request = () =>
  new Request('http://localhost/api/stripe/test') as unknown as import('next/server').NextRequest;

describe('GET /api/stripe/test', () => {
  beforeEach(() => {
    retrieveBalance.mockReset();
    retrieveBalance.mockResolvedValue({});
    vi.stubEnv('NODE_ENV', 'test');
  });

  it('returns 404 in production without contacting Stripe', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(retrieveBalance).not.toHaveBeenCalled();
  });

  it('checks the Stripe connection and returns success', async () => {
    const response = await GET(request());

    expect(retrieveBalance).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      status: 'success',
      message: 'Stripe connection successful',
    });
  });

  it('returns a generic error (not the Stripe message) when the connection check fails', async () => {
    retrieveBalance.mockRejectedValue(new Error('Stripe unavailable'));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: 'error',
      message: 'Stripe connection failed',
    });
  });

  it('returns the same generic error for non-Error failures', async () => {
    retrieveBalance.mockRejectedValue('failure');

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error', message: 'Stripe connection failed' });
  });

  it('keeps structured Stripe errors in server logs', async () => {
    const failure = { message: 'private Stripe details', requestId: 'req_private', raw: { key: 'private-token' } };
    retrieveBalance.mockRejectedValue(failure);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error', message: 'Stripe connection failed' });
    expect(console.error).toHaveBeenCalledWith('Stripe test failed:', failure);
  });

});
