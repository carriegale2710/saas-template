import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #28: users must not be able to write their own billing rows.
const read = (f: string) => readFileSync(path.resolve(__dirname, '../..', f), 'utf8');

describe('billing RLS', () => {
  it('initial schema grants users only SELECT on billing tables', () => {
    const policies = read('initial_supabase_table_schema.sql').match(/CREATE POLICY[\s\S]*?;/gi) ?? [];
    for (const table of ['subscriptions', 'user_trials']) {
      const userPolicies = policies.filter(
        (p) => p.includes(`public.${table}`) && !/TO service_role/i.test(p)
      );
      expect(userPolicies).toHaveLength(1);
      expect(userPolicies[0]).toMatch(/FOR SELECT/i);
    }
  });

  it('migration drops the user INSERT/UPDATE policies', () => {
    const sql = read('supabase/scripts/setup/05-lock-down-billing-rls.sql');
    for (const policy of [
      '"Users can update their own trials" ON public.user_trials',
      '"Users can insert their own trials" ON public.user_trials',
      '"Users can update their own subscriptions" ON public.subscriptions',
      '"Users can insert their own subscriptions" ON public.subscriptions',
    ]) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${policy}`);
    }
  });
});
