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
    expect(claim.insert).toHaveBeenCalledWith({ id: 'evt_1', type: 'invoice.upcoming', attempt_id: expect.any(String) });
  });

  it('skips already-processed duplicate events with a 200', async () => {
    const update = queryBuilder();
    from.mockImplementation(
      fromByTable({
        stripe_events: [
          queryBuilder({ error: { code: '23505' } }), // claim: unique violation
          queryBuilder({ data: { processed_at: '2026-11-14T00:00:00Z' } }), // existing row is done
        ],
        subscriptions: [update],
      })
    );
    event('customer.subscription.updated', sub());
    const res = await hook();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(update.update).not.toHaveBeenCalled();
  });

  it('409s (so Stripe retries later) while another attempt still holds a fresh claim', async () => {
    const update = queryBuilder();
    from.mockImplementation(
      fromByTable({
        stripe_events: [
          queryBuilder({ error: { code: '23505' } }),
          queryBuilder({ data: { processed_at: null } }), // unfinished
          queryBuilder({ data: [] }), // reclaim matched nothing: claim is not stale
        ],
        subscriptions: [update],
      })
    );
    event('customer.subscription.updated', sub());
    expect((await hook()).status).toBe(409);
    expect(update.update).not.toHaveBeenCalled();
  });

  it('retakes a stale unfinished claim, processes the event and marks it processed', async () => {
    const reclaim = queryBuilder({ data: [{ id: 'evt_1' }] });
    const markDone = queryBuilder();
    const update = queryBuilder();
    from.mockImplementation(
      fromByTable({
        stripe_events: [
          queryBuilder({ error: { code: '23505' } }),
          queryBuilder({ data: { processed_at: null } }),
          reclaim,
          markDone,
        ],
        subscriptions: [update],
      })
    );
    event('customer.subscription.updated', sub());
    expect((await hook()).status).toBe(200);
    expect(reclaim.is).toHaveBeenCalledWith('processed_at', null);
    expect(reclaim.lt).toHaveBeenCalledWith('created_at', expect.any(String));
    expect(update.update).toHaveBeenCalled();
    expect(markDone.update).toHaveBeenCalledWith({ processed_at: expect.any(String) });
    // The attempt that retook the claim owns it: reclaim sets its id, and completion is scoped to it.
    const owner = (reclaim.update.mock.calls[0][0] as { attempt_id: string }).attempt_id;
    expect(owner).toEqual(expect.any(String));
    expect(markDone.eq).toHaveBeenCalledWith('attempt_id', owner);
  });

  it('only releases the claim it owns, so a slow attempt cannot delete a retry\'s claim', async () => {
    const claim = queryBuilder();
    const release = queryBuilder();
    from.mockImplementation(fromByTable({ stripe_events: [claim, release] }));
    event('invoice.payment_failed', { subscription: 'sub_1' });
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('stripe down'));
    expect((await hook()).status).toBe(400);
    const owner = (claim.insert.mock.calls[0][0] as { attempt_id: string }).attempt_id;
    expect(release.delete).toHaveBeenCalled();
    expect(release.eq).toHaveBeenCalledWith('id', 'evt_1');
    expect(release.eq).toHaveBeenCalledWith('attempt_id', owner);
  });

  it('marks the event processed after a successful run', async () => {
    const claim = queryBuilder();
    from.mockImplementation(fromByTable({ stripe_events: [claim] }));
    event('invoice.upcoming', {});
    expect((await hook()).status).toBe(200);
    expect(claim.update).toHaveBeenCalledWith({ processed_at: expect.any(String) });
  });

  it('still 200s but logs when marking the event processed fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    from.mockImplementation(
      fromByTable({ stripe_events: [queryBuilder(), queryBuilder({ error: { message: 'db blip' } })] })
    );
    event('invoice.upcoming', {});
    expect((await hook()).status).toBe(200);
    expect(log.mock.calls.some((c) => String(c[0]).includes('Failed to mark event processed'))).toBe(true);
  });

  it('400s when the existing claim cannot be read', async () => {
    from.mockImplementation(
      fromByTable({
        stripe_events: [queryBuilder({ error: { code: '23505' } }), queryBuilder({ error: { message: 'down' } })],
      })
    );
    event('customer.subscription.updated', sub());
    expect((await hook()).status).toBe(400);
  });

  it.each([
    ['customer.subscription.updated'],
    ['customer.subscription.deleted'],
  ])('%s 400s and releases the claim when the subscription update fails', async (type) => {
    const release = queryBuilder();
    from.mockImplementation(
      fromByTable({
        stripe_events: [queryBuilder(), release],
        subscriptions: [queryBuilder({ error: { message: 'db' } })],
      })
    );
    event(type, sub());
    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalled();
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

  it('does not cancel the subscription a replayed checkout event already created', async () => {
    const update = queryBuilder({ data: { id: 'row1' } });
    from.mockImplementation(
      fromByTable({
        subscriptions: [
          // active-subscription check finds the row THIS session created earlier
          queryBuilder({ data: { id: 'row1', stripe_subscription_id: 'sub_1', status: 'active' } }),
          queryBuilder({ data: { id: 'row1', stripe_subscription_id: 'sub_1' } }),
          update,
        ],
      })
    );
    event('checkout.session.completed', session());
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    const res = await hook();
    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ status: 'blocked' });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('still 200s but logs when the claim was lost before completion', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    from.mockImplementation(
      fromByTable({ stripe_events: [queryBuilder(), queryBuilder({ data: [] })] }) // update matched no row
    );
    event('invoice.upcoming', {});
    expect((await hook()).status).toBe(200);
    expect(log.mock.calls.some((c) => String(c[0]).includes('Lost event claim before completion'))).toBe(true);
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

describe('webhook claim and invoice regressions', () => {
  it.each([null, []])('does not process or release an unfinished claim when reclaim returns %j', async (data) => {
    const reclaim = queryBuilder({ data });
    from.mockImplementation(fromByTable({
      stripe_events: [
        queryBuilder({ error: { code: '23505' } }),
        queryBuilder({ data: { processed_at: null } }),
        reclaim,
      ],
    }));
    event('invoice.paid', { subscription: 'sub_1' });

    const response = await hook();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Event in progress' });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(from.mock.calls).toEqual(Array(3).fill(['stripe_events']));
    expect(reclaim.delete).not.toHaveBeenCalled();
  });

  it('uses a five-minute cutoff and only completes the reclaimed event owned by this attempt', async () => {
    const now = new Date('2026-11-14T12:00:00.000Z');
    const reclaim = queryBuilder({ data: [{ id: 'evt_1' }] });
    const done = queryBuilder({ data: [{ id: 'evt_1' }] });
    from.mockImplementation(fromByTable({
      stripe_events: [
        queryBuilder({ error: { code: '23505' } }),
        queryBuilder({ data: { processed_at: null } }),
        reclaim,
        done,
      ],
    }));
    event('invoice.upcoming', {});
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      expect((await hook()).status).toBe(200);
      expect(reclaim.lt).toHaveBeenCalledWith('created_at', '2026-11-14T11:55:00.000Z');
      expect(reclaim.eq).toHaveBeenCalledWith('id', 'evt_1');
      expect(reclaim.is).toHaveBeenCalledWith('processed_at', null);
      expect(reclaim.update).toHaveBeenCalledWith({
        created_at: now.toISOString(), attempt_id: expect.any(String),
      });
      const owner = reclaim.update.mock.calls[0][0].attempt_id;
      expect(done.update).toHaveBeenCalledWith({ processed_at: now.toISOString() });
      expect(done.eq.mock.calls).toEqual([['id', 'evt_1'], ['attempt_id', owner]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not process or delete another attempt’s claim when reclaim fails', async () => {
    const reclaim = queryBuilder({ error: { message: 'reclaim unavailable' } });
    from.mockImplementation(fromByTable({
      stripe_events: [
        queryBuilder({ error: { code: '23505' } }),
        queryBuilder({ data: { processed_at: null } }),
        reclaim,
      ],
    }));
    event('invoice.paid', { subscription: 'sub_1' });

    const response = await hook();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Webhook handler failed' });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(3);
    expect(reclaim.delete).not.toHaveBeenCalled();
  });

  it('releases a reclaimed claim using the new owner when processing fails', async () => {
    const claim = queryBuilder({ error: { code: '23505' } });
    const reclaim = queryBuilder({ data: [{ id: 'evt_1' }] });
    const release = queryBuilder();
    from.mockImplementation(fromByTable({
      stripe_events: [claim, queryBuilder({ data: { processed_at: null } }), reclaim, release],
    }));
    event('invoice.paid', { subscription: 'sub_1' });
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('Stripe unavailable'));

    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalledOnce();
    expect(release.eq.mock.calls).toEqual([
      ['id', 'evt_1'], ['attempt_id', reclaim.update.mock.calls[0][0].attempt_id],
    ]);
    expect(release.update).not.toHaveBeenCalled();
  });

  it('processes a redelivery after a failed attempt with a fresh owner', async () => {
    const firstClaim = queryBuilder();
    const release = queryBuilder();
    const retryClaim = queryBuilder();
    const done = queryBuilder();
    const update = queryBuilder();
    from.mockImplementation(fromByTable({
      stripe_events: [firstClaim, release, retryClaim, done],
      subscriptions: [update],
    }));
    event('invoice.paid', { subscription: 'sub_1' });
    stripe.subscriptions.retrieve
      .mockRejectedValueOnce(new Error('temporary Stripe failure'))
      .mockResolvedValueOnce(sub());

    expect((await hook()).status).toBe(400);
    expect((await hook()).status).toBe(200);
    const firstOwner = firstClaim.insert.mock.calls[0][0].attempt_id;
    const retryOwner = retryClaim.insert.mock.calls[0][0].attempt_id;
    expect(retryOwner).not.toBe(firstOwner);
    expect(release.eq).toHaveBeenCalledWith('attempt_id', firstOwner);
    expect(done.eq).toHaveBeenCalledWith('attempt_id', retryOwner);
    expect(update.update).toHaveBeenCalledOnce();
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2);
  });

  describe.each(['invoice.paid', 'invoice.payment_failed'])('%s payloads', (type) => {
    it.each([
      { subscription: { id: 'sub_1' } },
      { subscription: null, parent: { subscription_details: { subscription: 'sub_1' } } },
      { parent: { subscription_details: { subscription: { id: 'sub_1' } } } },
      { subscription: 'sub_1', parent: { subscription_details: { subscription: 'sub_other' } } },
    ])('syncs Stripe values for subscription reference %j', async (invoice) => {
      const update = queryBuilder();
      const done = queryBuilder();
      from.mockImplementation(fromByTable({ subscriptions: [update], stripe_events: [queryBuilder(), done] }));
      event(type, invoice);
      // Status must come from Stripe, even when it differs from the usual status for this event.
      const status = type === 'invoice.paid' ? 'trialing' : 'unpaid';
      stripe.subscriptions.retrieve.mockResolvedValue(sub({ status, cancel_at_period_end: true }));

      expect((await hook()).status).toBe(200);
      expect(stripe.subscriptions.retrieve).toHaveBeenCalledExactlyOnceWith('sub_1');
      expect(update.update).toHaveBeenCalledWith({
        status,
        cancel_at_period_end: true,
        current_period_end: new Date(PERIOD_END * 1000).toISOString(),
        updated_at: expect.any(String),
      });
      expect(update.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_1');
      expect(done.update).toHaveBeenCalledOnce();
      expect(done.update.mock.invocationCallOrder[0]).toBeGreaterThan(update.update.mock.invocationCallOrder[0]);
    });

    it.each([
      {},
      { subscription: null },
      { parent: null },
      { parent: { subscription_details: null } },
      { parent: { subscription_details: { subscription: null } } },
    ])('acknowledges a one-off invoice %j and marks its event processed', async (invoice) => {
      const done = queryBuilder();
      from.mockImplementation(fromByTable({ stripe_events: [queryBuilder(), done] }));
      event(type, invoice);

      const response = await hook();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
      expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalledWith('subscriptions');
      expect(done.update).toHaveBeenCalledWith({ processed_at: expect.any(String) });
    });
  });

  it.each(['client_reference_id', 'customer', 'subscription'])('releases incomplete checkout sessions missing %s', async (field) => {
    const release = queryBuilder();
    from.mockImplementation(fromByTable({
      stripe_events: [queryBuilder(), release], subscriptions: [queryBuilder({ data: null })],
    }));
    event('checkout.session.completed', session({ [field]: null }));

    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalledOnce();
    expect(release.update).not.toHaveBeenCalled();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('releases the checkout claim when cancellation of a duplicate subscription fails', async () => {
    const release = queryBuilder();
    from.mockImplementation(fromByTable({
      stripe_events: [queryBuilder(), release],
      subscriptions: [queryBuilder({ data: { stripe_subscription_id: 'sub_existing' } })],
    }));
    event('checkout.session.completed', session());
    stripe.subscriptions.cancel.mockRejectedValue(new Error('Stripe unavailable'));

    expect((await hook()).status).toBe(400);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith('sub_1');
    expect(release.delete).toHaveBeenCalledOnce();
    expect(release.update).not.toHaveBeenCalled();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    'customer.subscription.pending_update_applied',
    'customer.subscription.pending_update_expired',
    'customer.subscription.trial_will_end',
  ])('%s releases its claim when the subscription sync fails', async (type) => {
    const release = queryBuilder();
    from.mockImplementation(fromByTable({
      stripe_events: [queryBuilder(), release],
      subscriptions: [queryBuilder({ error: { message: 'database unavailable' } })],
    }));
    event(type, sub());

    expect((await hook()).status).toBe(400);
    expect(release.delete).toHaveBeenCalledOnce();
    expect(release.update).not.toHaveBeenCalled();
  });
});
