import { vi } from 'vitest';

type Result = { data?: unknown; error?: unknown };

/**
 * Chainable, awaitable stand-in for a Supabase query builder.
 * Every chain method returns the builder; awaiting (or .single()/.maybeSingle())
 * resolves to `result`.
 */
export function queryBuilder(result: Result = { data: null, error: null }) {
  const builder: Record<string, unknown> = {};
  const resolved = Promise.resolve({ data: null, error: null, ...result });
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'is', 'lt', 'order', 'limit',
  ]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.single = vi.fn(() => resolved);
  builder.maybeSingle = vi.fn(() => resolved);
  builder.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    resolved.then(res, rej);
  return builder as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;
}

/** Build a `from()` mock that returns queued builders per table (last one repeats). */
export function fromByTable(tables: Record<string, ReturnType<typeof queryBuilder>[]>) {
  const idx: Record<string, number> = {};
  return vi.fn((table: string) => {
    const list = tables[table] ?? [queryBuilder()];
    const i = idx[table] ?? 0;
    idx[table] = i + 1;
    return list[Math.min(i, list.length - 1)];
  });
}

export function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
