import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromByTable, jsonRequest, queryBuilder } from '../helpers';

const from = vi.fn();
const getAuthenticatedUser = vi.fn();
const stripe = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  customers: { retrieve: vi.fn() },
};

vi.mock('@/utils/supabase-admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }));
vi.mock('@/utils/supabase-server', () => ({ getAuthenticatedUser: (...a: unknown[]) => getAuthenticatedUser(...a) }));
vi.mock('@/utils/stripe-server', () => ({ getStripeClient: () => stripe }));

import { POST as cancel } from '@/app/api/stripe/cancel/route';
import { POST as reactivate } from '@/app/api/stripe/reactivate/route';
import { POST as sync } from '@/app/api/stripe/sync/route';

const req = (body: unknown) => jsonRequest('http://localhost/api/stripe/x', body);
const PERIOD_END = 1_900_000_000;
const stripeSub = (over = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  current_period_end: PERIOD_END,
  items: { data: [{ price: { id: 'price_1' } }] },
  ...over,
});

beforeEach(() => {
  from.mockReset();
  getAuthenticatedUser.mockReset();
  stripe.subscriptions.retrieve.mockReset();
  stripe.subscriptions.update.mockReset();
  stripe.customers.retrieve.mockReset();
  getAuthenticatedUser.mockResolvedValue({ id: 'u1' });
});

describe.each([
  ['cancel', cancel],
  ['reactivate', reactivate],
])('%s guards', (_name, handler) => {
  it('401s when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    expect((await handler(req({ subscriptionId: 'sub_1' }))).status).toBe(401);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('allows bearer-token auth', async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    await handler(req({ subscriptionId: 'sub_1' }));
    expect(getAuthenticatedUser).toHaveBeenCalledWith({ allowBearerToken: true });
  });

  it('400s without subscriptionId', async () => {
    expect((await handler(req({}))).status).toBe(400);
  });

  it('404s for unknown subscription', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: 'PGRST116' } })] }));
    expect((await handler(req({ subscriptionId: 'sub_1' }))).status).toBe(404);
  });

  it('403s when the subscription belongs to another user', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { user_id: 'other' } })] }));
    expect((await handler(req({ subscriptionId: 'sub_1' }))).status).toBe(403);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('500s on unexpected lookup errors', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: '500', message: 'db' } })] }));
    expect((await handler(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
  });
});

describe('cancel', () => {
  const owned = () => queryBuilder({ data: { user_id: 'u1' } });

  it('sets cancel_at_period_end and updates the DB', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [owned(), update] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    stripe.subscriptions.update.mockResolvedValue(stripeSub({ cancel_at_period_end: true }));
    const res = await cancel(req({ subscriptionId: 'sub_1' }));
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(update.update).toHaveBeenCalledWith(
      expect.objectContaining({ cancel_at_period_end: true, current_period_end: new Date(PERIOD_END * 1000).toISOString() })
    );
  });

  it('is a no-op success for already canceled subscriptions', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [owned()] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: 'canceled' }));
    expect(await (await cancel(req({ subscriptionId: 'sub_1' }))).json()).toEqual({ status: 'success', alreadyCanceled: true });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('400s for non-cancelable states', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [owned()] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: 'past_due' }));
    expect((await cancel(req({ subscriptionId: 'sub_1' }))).status).toBe(400);
  });

  it('500s when Stripe or the DB update fails', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [owned()] }));
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('stripe down'));
    const res = await cancel(req({ subscriptionId: 'sub_1' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to cancel subscription' });

    from.mockImplementation(fromByTable({ subscriptions: [owned(), queryBuilder({ error: { message: 'write' } })] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    stripe.subscriptions.update.mockResolvedValue(stripeSub());
    expect((await cancel(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
  });
});

describe('reactivate', () => {
  it('clears cancel_at_period_end in Stripe and the DB', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { user_id: 'u1' } }), update] }));
    stripe.subscriptions.update.mockResolvedValue(stripeSub());
    const res = await reactivate(req({ subscriptionId: 'sub_1' }));
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false });
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ cancel_at_period_end: false }));
  });

  it('500s when Stripe fails', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { user_id: 'u1' } })] }));
    stripe.subscriptions.update.mockRejectedValue(new Error('x'));
    expect((await reactivate(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
  });
});

describe('sync', () => {
  it('401s when unauthenticated and 400s without id', async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(401);
    getAuthenticatedUser.mockResolvedValue({ id: 'u1' });
    expect((await sync(req({}))).status).toBe(400);
  });

  it('creates a record when none exists', async () => {
    const insert = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: 'PGRST116' } }), insert] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_1', metadata: { user_id: 'u1' } });
    const res = await sync(req({ subscriptionId: 'sub_1' }));
    expect(res.status).toBe(200);
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1', price_id: 'price_1', status: 'active' })
    );
  });

  it('403s when the Stripe customer belongs to another user', async () => {
    const insert = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: 'PGRST116' } }), insert] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_1', metadata: { user_id: 'other' } });
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(403);
    expect(insert.insert).not.toHaveBeenCalled();
  });

  it('500s for deleted customers, missing metadata and Stripe errors', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: 'PGRST116' } })] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_1', deleted: true });
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_1', metadata: {} });
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('nope'));
    const res = await sync(req({ subscriptionId: 'sub_1' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to sync subscription' });
  });

  it('500s when the insert fails', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: 'PGRST116' } }), queryBuilder({ error: { message: 'x' } })] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_1', metadata: { user_id: 'u1' } });
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
  });

  it('updates an existing record owned by the user', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { user_id: 'u1' } }), update] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: 'past_due', cancel_at_period_end: true }));
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(200);
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'past_due', cancel_at_period_end: true }));
  });

  it('403s when an existing record belongs to another user, 500s on update failure', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { user_id: 'other' } })] }));
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(403);

    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { user_id: 'u1' } }), queryBuilder({ error: { message: 'w' } })] }));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
  });

  it('500s on unexpected lookup errors', async () => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: null, error: { code: '500', message: 'db' } })] }));
    expect((await sync(req({ subscriptionId: 'sub_1' }))).status).toBe(500);
  });
});
