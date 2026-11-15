import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromByTable, queryBuilder } from '../helpers';

const from = vi.fn();
const getAuthenticatedUser = vi.fn();
const cancelSubscription = vi.fn();
const stripe = { subscriptions: { cancel: (...args: unknown[]) => cancelSubscription(...args) } };

vi.mock('@/utils/supabase-admin', () => ({ supabaseAdmin: { from: (...args: unknown[]) => from(...args) } }));
vi.mock('@/utils/supabase-server', () => ({
  getAuthenticatedUser: (...args: unknown[]) => getAuthenticatedUser(...args),
}));
vi.mock('@/utils/stripe-server', () => ({ getStripeClient: () => stripe }));

import { DELETE } from '@/app/api/user/delete/route';

const request = (userId = 'u1') =>
  new Request(`http://localhost/api/user/delete${userId ? `?userId=${userId}` : ''}`, {
    method: 'DELETE',
  }) as unknown as import('next/server').NextRequest;

describe('DELETE /api/user/delete', () => {
  beforeEach(() => {
    from.mockReset();
    getAuthenticatedUser.mockReset();
    cancelSubscription.mockReset();
    getAuthenticatedUser.mockResolvedValue({ id: 'u1' });
    cancelSubscription.mockResolvedValue({});
  });

  it('requires authentication and bearer-token support', async () => {
    getAuthenticatedUser.mockResolvedValue(null);

    const response = await DELETE(request());

    expect(response.status).toBe(401);
    expect(getAuthenticatedUser).toHaveBeenCalledWith({ allowBearerToken: true });
    expect(from).not.toHaveBeenCalled();
  });

  it('requires the matching user ID', async () => {
    expect((await DELETE(request(''))).status).toBe(400);
    expect((await DELETE(request('other'))).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('cancels active subscriptions and soft-deletes the user and subscriptions', async () => {
    const subscriptions = queryBuilder({
      data: [
        { stripe_subscription_id: 'sub_active', status: 'active' },
        { stripe_subscription_id: 'sub_trial', status: 'trialing' },
        { stripe_subscription_id: 'sub_paused', status: 'paused' },
        { stripe_subscription_id: null, status: 'active' },
      ],
    });
    const profileUpdate = queryBuilder();
    const subscriptionUpdate = queryBuilder();
    from.mockImplementation(
      fromByTable({
        subscriptions: [subscriptions, subscriptionUpdate],
        users: [profileUpdate],
      })
    );

    const response = await DELETE(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(cancelSubscription.mock.calls).toEqual([['sub_active'], ['sub_trial']]);
    expect(subscriptions.select).toHaveBeenCalledWith('stripe_subscription_id, status');
    expect(subscriptions.eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(profileUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_deleted: true, deleted_at: expect.any(String) })
    );
    expect(profileUpdate.eq).toHaveBeenCalledWith('id', 'u1');
    expect(subscriptionUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled', deleted_at: expect.any(String) })
    );
    expect(subscriptionUpdate.eq).toHaveBeenCalledWith('user_id', 'u1');
  });

  it('continues soft deletion if Stripe cancellation fails', async () => {
    cancelSubscription.mockRejectedValue(new Error('Stripe unavailable'));
    from.mockImplementation(
      fromByTable({
        subscriptions: [
          queryBuilder({ data: [{ stripe_subscription_id: 'sub_active', status: 'active' }] }),
          queryBuilder(),
        ],
        users: [queryBuilder()],
      })
    );

    const response = await DELETE(request());

    expect(response.status).toBe(200);
  });

  it('continues when subscription reads or updates fail', async () => {
    from.mockImplementation(
      fromByTable({
        subscriptions: [
          queryBuilder({ error: { message: 'read failed' } }),
          queryBuilder({ error: { message: 'update failed' } }),
        ],
        users: [queryBuilder()],
      })
    );

    const response = await DELETE(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });

  it('returns 500 when the profile update fails', async () => {
    from.mockImplementation(
      fromByTable({
        subscriptions: [queryBuilder({ data: [] })],
        users: [queryBuilder({ error: { message: 'write failed' } })],
      })
    );

    const response = await DELETE(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update profile' });
  });

  it('returns 500 when a dependency throws', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('auth service down'));

    const response = await DELETE(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to process account deletion' });
  });

  it('keeps structured profile errors in server logs and stops deletion', async () => {
    const failure = { message: 'private SQL', details: 'private schema', hint: 'private hint', code: 'XX000' };
    const subscriptionUpdate = queryBuilder();
    from.mockImplementation(fromByTable({
      subscriptions: [queryBuilder({ data: [] }), subscriptionUpdate],
      users: [queryBuilder({ error: failure })],
    }));

    const response = await DELETE(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update profile' });
    expect(console.error).toHaveBeenCalledWith('Profile update error:', failure);
    expect(subscriptionUpdate.update).not.toHaveBeenCalled();
  });

  it.each([{ message: 'private auth details', token: 'private-token' }, 'private failure', null])(
    'redacts non-Error exceptions and retains diagnostics (%j)', async (failure) => {
      getAuthenticatedUser.mockRejectedValue(failure);

      const response = await DELETE(request());

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to process account deletion' });
      expect(console.error).toHaveBeenCalledWith('Error in account soft-deletion:', failure);
      expect(from).not.toHaveBeenCalled();
    }
  );

});
