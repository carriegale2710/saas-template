// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fromByTable, queryBuilder } from '../helpers';

const from = vi.fn();
let authUser: { id: string } | null = { id: 'u1' };
const session = { access_token: 'tok' };

vi.mock('@/utils/supabase', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: authUser, session }) }));

import { useTrialStatus } from '@/hooks/useTrialStatus';

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function run() {
  const hook = renderHook(() => useTrialStatus());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook.result.current;
}

describe('useTrialStatus', () => {
  beforeEach(() => {
    from.mockReset();
    authUser = { id: 'u1' };
    vi.unstubAllGlobals();
  });

  it('is not in trial without a user', async () => {
    authUser = null;
    expect(await run()).toEqual({ isInTrial: false, trialEndTime: null, isLoading: false });
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['active', 'trialing'])('is not in trial with a %s subscription', async (status) => {
    from.mockImplementation(fromByTable({ subscriptions: [queryBuilder({ data: { status } })] }));
    const r = await run();
    expect(r.isInTrial).toBe(false);
    expect(from).not.toHaveBeenCalledWith('user_trials');
  });

  it('is in trial with an unexpired, unused trial', async () => {
    const end = hours(10);
    from.mockImplementation(
      fromByTable({
        subscriptions: [queryBuilder({ data: null })],
        user_trials: [queryBuilder({ data: { trial_end_time: end, is_trial_used: false } })],
      })
    );
    expect(await run()).toMatchObject({ isInTrial: true, trialEndTime: end });
  });

  it('is not in trial when expired or already used', async () => {
    from.mockImplementation(
      fromByTable({
        subscriptions: [queryBuilder({ data: null })],
        user_trials: [queryBuilder({ data: { trial_end_time: hours(-1), is_trial_used: false } })],
      })
    );
    expect((await run()).isInTrial).toBe(false);

    from.mockImplementation(
      fromByTable({
        subscriptions: [queryBuilder({ data: null })],
        user_trials: [queryBuilder({ data: { trial_end_time: hours(10), is_trial_used: true } })],
      })
    );
    expect((await run()).isInTrial).toBe(false);
  });

  it('starts a trial via the server route when none exists (no client write)', async () => {
    const end = hours(48);
    const fetchMock = vi.fn(async () => Response.json({ trial_end_time: end, is_trial_used: false }));
    vi.stubGlobal('fetch', fetchMock);
    const trials = queryBuilder({ data: null });
    from.mockImplementation(
      fromByTable({ subscriptions: [queryBuilder({ data: null })], user_trials: [trials] })
    );
    expect(await run()).toMatchObject({ isInTrial: true, trialEndTime: end });
    expect(fetchMock).toHaveBeenCalledWith('/api/user/trial', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(trials.upsert).not.toHaveBeenCalled();
    expect(trials.insert).not.toHaveBeenCalled();
    expect(trials.update).not.toHaveBeenCalled();
  });

  it('falls back safely on query or insert errors', async () => {
    from.mockImplementation(
      fromByTable({
        subscriptions: [queryBuilder({ data: null })],
        user_trials: [queryBuilder({ data: null, error: { code: 'XX', message: 'db' } })],
      })
    );
    expect(await run()).toEqual({ isInTrial: false, trialEndTime: null, isLoading: false });

    from.mockImplementation(
      fromByTable({
        subscriptions: [queryBuilder({ data: null })],
        user_trials: [queryBuilder({ data: null })],
      })
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    expect((await run()).isInTrial).toBe(false);
  });
});
