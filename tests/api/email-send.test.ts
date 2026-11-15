import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromByTable, jsonRequest, queryBuilder } from '../helpers';

const from = vi.fn();
const getUserById = vi.fn();
const sendTransactionalEmail = vi.fn();

vi.mock('@/utils/supabase-admin', () => ({
  supabaseAdmin: { from: (...a: unknown[]) => from(...a), auth: { admin: { getUserById: (...a: unknown[]) => getUserById(...a) } } },
}));
vi.mock('@/services/emailService', () => ({
  sendTransactionalEmail: (...a: unknown[]) => sendTransactionalEmail(...a),
}));

import { POST } from '@/app/api/email/send/route';

const call = (body: unknown, key: string | null = 'secret') =>
  POST(jsonRequest('http://localhost/api/email/send', body, key ? { 'x-api-key': key } : {}));

describe('POST /api/email/send', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_API_KEY', 'secret');
    from.mockReset();
    getUserById.mockReset();
    sendTransactionalEmail.mockReset();
    sendTransactionalEmail.mockResolvedValue({ success: true, emailId: 'em1' });
  });

  it('500s when INTERNAL_API_KEY is not configured', async () => {
    vi.stubEnv('INTERNAL_API_KEY', '');
    expect((await call({ type: 'welcome', to: 'a@b.co', data: {} })).status).toBe(500);
  });

  it('401s for missing or wrong API key', async () => {
    expect((await call({}, null)).status).toBe(401);
    expect((await call({}, 'wrong')).status).toBe(401); // length mismatch
    expect((await call({}, 'secreT')).status).toBe(401); // same length
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid type', { type: 'spam', to: 'a@b.co', data: {} }],
    ['missing type', { to: 'a@b.co', data: {} }],
    ['no to or userId', { type: 'welcome', data: {} }],
    ['missing data', { type: 'welcome', to: 'a@b.co' }],
    ['array data', { type: 'welcome', to: 'a@b.co', data: [] }],
  ])('400s on %s', async (_n, body) => {
    expect((await call(body)).status).toBe(400);
  });

  it('500s on malformed JSON without leaking the error', async () => {
    const res = await call('{not json');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to send email' });
  });

  it('sends directly to `to` without logging when no userId', async () => {
    const res = await call({ type: 'welcome', to: 'a@b.co', data: { firstName: 'A' } });
    expect(await res.json()).toEqual({ success: true, emailId: 'em1' });
    expect(sendTransactionalEmail).toHaveBeenCalledWith('welcome', 'a@b.co', { firstName: 'A' });
    expect(from).not.toHaveBeenCalled();
  });

  it('looks up email + first name from public.users and logs the send', async () => {
    const log = queryBuilder();
    from.mockImplementation(
      fromByTable({
        users: [queryBuilder({ data: { email: 'jane@x.co', full_name: 'Jane Doe' } })],
        user_email_log: [queryBuilder({ data: null }), log],
      })
    );
    const res = await call({ type: 'welcome', userId: 'u1', data: {} });
    expect(res.status).toBe(200);
    expect(sendTransactionalEmail).toHaveBeenCalledWith('welcome', 'jane@x.co', { firstName: 'Jane' });
    expect(log.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', email_type: 'welcome', email_address: 'jane@x.co', status: 'sent' })
    );
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('falls back to auth.users and derives name from metadata', async () => {
    from.mockImplementation(
      fromByTable({ users: [queryBuilder({ data: null })], user_email_log: [queryBuilder()] })
    );
    getUserById.mockResolvedValue({
      data: { user: { email: 'x@y.co', user_metadata: { name: 'Sam Lee' } } },
    });
    await call({ type: 'welcome', userId: 'u1', data: {} });
    expect(sendTransactionalEmail).toHaveBeenCalledWith('welcome', 'x@y.co', { firstName: 'Sam' });
  });

  it('uses raw_user_meta_data, then the email prefix, for firstName', async () => {
    from.mockImplementation(
      fromByTable({
        users: [queryBuilder({ data: { email: 'a@b.co', raw_user_meta_data: { full_name: 'Zed Q' } } })],
        user_email_log: [queryBuilder()],
      })
    );
    await call({ type: 'welcome', userId: 'u1', data: {} });
    expect(sendTransactionalEmail.mock.calls[0][2]).toEqual({ firstName: 'Zed' });

    sendTransactionalEmail.mockClear();
    from.mockImplementation(
      fromByTable({
        users: [queryBuilder({ data: { email: 'john.smith@b.co' } })],
        user_email_log: [queryBuilder()],
      })
    );
    await call({ type: 'welcome', userId: 'u1', data: {} });
    expect(sendTransactionalEmail.mock.calls[0][2]).toEqual({ firstName: 'John' });
  });

  it('404s when the user has no email anywhere', async () => {
    from.mockImplementation(fromByTable({ users: [queryBuilder({ data: null })] }));
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'nf' } });
    expect((await call({ type: 'welcome', userId: 'u1', data: {} })).status).toBe(404);
  });

  it('blocks duplicate sends', async () => {
    from.mockImplementation(
      fromByTable({ user_email_log: [queryBuilder({ data: { id: 1 } })] })
    );
    const res = await call({ type: 'welcome', to: 'a@b.co', userId: 'u1', data: {} });
    expect(await res.json()).toMatchObject({ success: false, duplicate: true });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('500s and logs a failed send', async () => {
    const log = queryBuilder();
    from.mockImplementation(fromByTable({ user_email_log: [queryBuilder(), log] }));
    sendTransactionalEmail.mockResolvedValue({ success: false, error: 'boom' });
    const res = await call({ type: 'cancellation', to: 'a@b.co', userId: 'u1', data: {} });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to send email', success: false });
    expect(log.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_message: 'boom' })
    );
  });

  it.each([null, '', 's', 'secret-extra', 'Secret', 'sécret', 'écret']) (
    'rejects API key %j before parsing the body or accessing dependencies',
    async (key) => {
      const request = jsonRequest('http://localhost/api/email/send', '{invalid', key ? { 'x-api-key': key } : {});
      const parse = vi.spyOn(request, 'json');

      const response = await POST(request);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
      expect(parse).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(sendTransactionalEmail).not.toHaveBeenCalled();
    }
  );

  it('accepts an exact key containing multibyte characters', async () => {
    vi.stubEnv('INTERNAL_API_KEY', 'sécret');
    const response = await call({ type: 'welcome', to: 'a@b.co', data: {} }, 'sécret');
    expect(response.status).toBe(200);
    expect(sendTransactionalEmail).toHaveBeenCalledOnce();
  });

  it.each([
    new Error('provider credential: private-token'),
    { message: 'provider credential: private-token', details: { token: 'private-token' } },
    'provider credential: private-token',
    null,
  ])('redacts thrown provider failures while retaining server diagnostics (%j)', async (failure) => {
    sendTransactionalEmail.mockRejectedValue(failure);

    const response = await call({ type: 'welcome', to: 'a@b.co', data: {} });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to send email' });
    expect(console.error).toHaveBeenCalledWith('[Email API] Error:', failure);
  });

  it.each(['provider credential: private-token', undefined])(
    'returns a generic provider rejection without a user log (%j)', async (error) => {
      sendTransactionalEmail.mockResolvedValue({ success: false, error });

      const response = await call({ type: 'welcome', to: 'a@b.co', data: {} });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to send email', success: false });
      expect(console.error).toHaveBeenCalledWith('Email send failed:', error);
      expect(from).not.toHaveBeenCalled();
    }
  );

});
