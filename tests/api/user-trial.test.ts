import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromByTable, queryBuilder } from '../helpers';

const from = vi.fn();
const getAuthenticatedUser = vi.fn();

vi.mock('@/utils/supabase-admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }));
vi.mock('@/utils/supabase-server', () => ({ getAuthenticatedUser: (...a: unknown[]) => getAuthenticatedUser(...a) }));

import { POST } from '@/app/api/user/trial/route';

const call = () =>
  POST(new Request('http://localhost/api/user/trial', { method: 'POST' }) as unknown as import('next/server').NextRequest);

beforeEach(() => {
  from.mockReset();
  getAuthenticatedUser.mockReset();
  getAuthenticatedUser.mockResolvedValue({ id: 'u1' });
});

describe('POST /api/user/trial', () => {
  it('401s when unauthenticated and writes nothing', async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(getAuthenticatedUser).toHaveBeenCalledWith({ allowBearerToken: true });
    expect(from).not.toHaveBeenCalled();
  });

  it('creates a 48h trial for the caller without overwriting an existing one', async () => {
    const write = queryBuilder();
    const read = queryBuilder({ data: { trial_end_time: 'end', is_trial_used: false } });
    from.mockImplementation(fromByTable({ user_trials: [write, read] }));
    const before = Date.now();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trial_end_time: 'end', is_trial_used: false });

    const [row, opts] = write.upsert.mock.calls[0] as [
      { user_id: string; trial_end_time: string; is_trial_used: boolean },
      unknown,
    ];
    expect(row.user_id).toBe('u1');
    expect(row.is_trial_used).toBe(false);
    expect(Math.abs(new Date(row.trial_end_time).getTime() - before - 48 * 3_600_000)).toBeLessThan(60_000);
    expect(opts).toEqual({ onConflict: 'user_id', ignoreDuplicates: true });
    expect(read.eq).toHaveBeenCalledWith('user_id', 'u1');
  });

  it('500s on write or read errors', async () => {
    from.mockImplementation(fromByTable({ user_trials: [queryBuilder({ error: { message: 'w' } })] }));
    expect((await call()).status).toBe(500);

    from.mockImplementation(
      fromByTable({ user_trials: [queryBuilder(), queryBuilder({ data: null, error: { message: 'r' } })] })
    );
    expect((await call()).status).toBe(500);
  });
});
