import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromByTable, queryBuilder } from '../helpers';

const from = vi.fn();
const stripe = {
  webhooks: { constructEvent: vi.fn() },
  subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
};

vi.mock('@/utils/supabase-admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }));
vi.mock('@/utils/stripe-server', () => ({
  getStripeClient: () => stripe,
  getStripeWebhookSecret: () => 'whsec_test',
}));

import { POST } from '@/app/api/stripe/webhook/route';

const hook = (headers: Record<string, string> = { 'stripe-signature': 'sig' }) =>
  POST(new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}', headers }) as any);

const PERIOD_END = 1_900_000_000;
const sub = (over = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  current_period_end: PERIOD_END,
  items: { data: [{ price: { id: 'price_1' } }] },
  ...over,
});
const event = (type: string, object: unknown) => stripe.webhooks.constructEvent.mockReturnValue({ id: 'evt_1', type, data: { object } });
const session = (over = {}) => ({ id: 'cs_1', client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1', ...over });

beforeEach(() => {
  from.mockReset();
  from.mockImplementation(fromByTable({})); // default: every table succeeds (incl. stripe_events claim)
  stripe.webhooks.constructEvent.mockReset();
  stripe.subscriptions.retrieve.mockReset();
  stripe.subscriptions.cancel.mockReset();
});

describe('POST /api/stripe/webhook', () => {
  it('400s without a stripe-signature header', async () => {
    const res = await hook({});
    expect(res.status).toBe(400);
    expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it('400s on invalid signatures', async () => {
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('bad sig');
    });
    expect((await hook()).status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('acknowledges unhandled event types', async () => {
    event('invoice.upcoming', {});
    expect(await (await hook()).json()).toEqual({ received: true });
  });

  it('records the event id before processing', async () => {
    const claim = queryBuilder();
    from.mockImplementation(fromByTable({ stripe_events: [claim] }));
    event('invoice.upcoming', {});
    expect((await hook()).status).toBe(200);
    expect(claim.insert).toHaveBeenCalledWith({ id: 'evt_1', type: 'invoice.upcoming' });
  });

  it('skips duplicate events (unique violation) with a 200', async () => {
    const update = queryBuilder();
    from.mockImplementation(
      fromByTable({ stripe_events: [queryBuilder({ error: { code: '23505' } })], subscriptions: [update] })
    );
    event('customer.subscription.updated', sub());
    const res = await hook();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(update.update).not.toHaveBeenCalled();
  });

  it('400s (so Stripe retries) when the event id cannot be recorded', async () => {
    const update = queryBuilder();
    from.mockImplementation(
      fromByTable({ stripe_events: [queryBuilder({ error: { code: '08006', message: 'down' } })], subscriptions: [update] })
    );
    event('customer.subscription.updated', sub());
    expect((await hook()).status).toBe(400);
    expect(update.update).not.toHaveBeenCalled();
  });

  it('releases the event id when processing fails so a retry can reprocess', async () => {
    const claim = queryBuilder();
    const release = queryBuilder();
    from.mockImplementation(fromByTable({ stripe_events: [claim, release] }));
    event('invoice.payment_failed', { subscription: 'sub_1' });
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('stripe down'));
    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalled();
    expect(release.eq).toHaveBeenCalledWith('id', 'evt_1');
  });

  it.each([
    ['invoice.payment_failed', 'past_due'],
    ['invoice.paid', 'active'],
  ])('%s stores the subscription status from Stripe', async (type, status) => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [update] }));
    event(type, { subscription: 'sub_1' });
    stripe.subscriptions.retrieve.mockResolvedValue(sub({ status }));
    expect((await hook()).status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    expect(update.update).toHaveBeenCalledWith(
      expect.objectContaining({ status, current_period_end: new Date(PERIOD_END * 1000).toISOString() })
    );
    expect(update.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_1');
  });

  it('invoice.paid accepts an expanded subscription object', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [update] }));
    event('invoice.paid', { subscription: { id: 'sub_1' } });
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    expect((await hook()).status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
  });

  it('invoice.paid reads the subscription from invoice.parent on newer Stripe API versions', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [update] }));
    event('invoice.paid', { parent: { subscription_details: { subscription: 'sub_1' } } });
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    expect((await hook()).status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    expect(update.update).toHaveBeenCalled();
  });

  it('logs loudly when releasing the event id fails, and still 400s', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const release = queryBuilder({ error: { message: 'db blip' } });
    from.mockImplementation(fromByTable({ stripe_events: [queryBuilder(), release] }));
    event('invoice.payment_failed', { subscription: 'sub_1' });
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('stripe down'));
    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes('Failed to release event claim'))).toBe(true);
  });

  it('invoice.paid without a subscription is acknowledged without writing', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [update] }));
    event('invoice.paid', { subscription: null });
    expect((await hook()).status).toBe(200);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  it('400s and releases the event id when the invoice subscription update fails', async () => {
    const release = queryBuilder();
    from.mockImplementation(
      fromByTable({ stripe_events: [queryBuilder(), release], subscriptions: [queryBuilder({ error: { message: 'db' } })] })
    );
    event('invoice.paid', { subscription: 'sub_1' });
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalled();
  });

  it('checkout.session.completed inserts a subscription', async () => {
    const insert = queryBuilder({ data: { id: 'row1' } });
    from.mockImplementation(
      fromByTable({
        subscriptions: [
          queryBuilder({ data: null, error: { code: 'PGRST116' } }), // duplicate check
          queryBuilder({ data: null, error: { code: 'PGRST116' } }), // existing check
          insert,
        ],
      })
    );
    event('checkout.session.completed', session());
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    expect(await (await hook()).json()).toEqual({ received: true });
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', price_id: 'price_1' })
    );
  });

  it('checkout.session.completed updates an existing row', async () => {
    const update = queryBuilder({ data: { id: 'row1' } });
    from.mockImplementation(
      fromByTable({
        subscriptions: [
          queryBuilder({ data: null }),
          queryBuilder({ data: { id: 'row1', stripe_subscription_id: 'sub_1' } }),
          update,
        ],
      })
    );
    event('checkout.session.completed', session());
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    expect((await hook()).status).toBe(200);
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('blocks a duplicate active subscription and cancels the new one', async () => {
    const insert = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { id: 'existing' } }), insert] }));
    event('checkout.session.completed', session());
    const res = await hook();
    expect(await res.json()).toMatchObject({ status: 'blocked' });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1');
    expect(insert.insert).not.toHaveBeenCalled();
  });

  it('400s on incomplete checkout sessions and releases the event id', async () => {
    const release = queryBuilder();
    from.mockImplementation(
      fromByTable({ stripe_events: [queryBuilder(), release], subscriptions: [queryBuilder({ data: null })] })
    );
    event('checkout.session.completed', session({ client_reference_id: null }));
    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalled();
  });

  it('400s when creating the subscription fails', async () => {
    from.mockImplementation(
      fromByTable({ subscriptions: [queryBuilder({ data: null }), queryBuilder({ data: null }), queryBuilder({ error: { message: 'insert failed' } })] })
    );
    event('checkout.session.completed', session());
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    expect((await hook()).status).toBe(400);
  });

  it('customer.subscription.created is acknowledged without writing subscriptions', async () => {
    event('customer.subscription.created', sub());
    expect(await (await hook()).json()).toEqual({ received: true });
    expect(from).not.toHaveBeenCalledWith('subscriptions');
  });

  it('customer.subscription.updated syncs the values supplied by Stripe', async () => {
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [update] }));
    event('customer.subscription.updated', sub({ status: 'past_due', cancel_at_period_end: true }));
    expect((await hook()).status).toBe(200);
    expect(update.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'past_due',
        cancel_at_period_end: true,
        current_period_end: new Date(PERIOD_END * 1000).toISOString(),
      })
    );
    expect(update.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_1');
  });

  it('customer.subscription.deleted clears cancellation and syncs the deletion time', async () => {
    const deletionTime = new Date('2025-01-02T03:04:05.000Z');
    const update = queryBuilder();
    from.mockImplementation(fromByTable({ subscriptions: [update] }));
    event(
      'customer.subscription.deleted',
      sub({ status: 'canceled', cancel_at_period_end: true })
    );

    vi.useFakeTimers();
    vi.setSystemTime(deletionTime);
    try {
      expect((await hook()).status).toBe(200);
      expect(update.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'canceled',
          cancel_at_period_end: false,
          current_period_end: deletionTime.toISOString(),
        })
      );
    } finally {
      vi.useRealTimers();
    }

    expect(update.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_1');
  });
});
