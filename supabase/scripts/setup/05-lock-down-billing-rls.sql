-- supabase/scripts/setup/05-lock-down-billing-rls.sql
-- Removes user INSERT/UPDATE policies on subscriptions and user_trials (issue #28).
-- With them, anyone holding the anon key could set status = 'active' or extend a trial.
-- Users keep SELECT on their own rows. All writes go through the service role
-- (Stripe routes/webhook and /api/user/trial).
--
-- Safe to re-run.

DROP POLICY IF EXISTS "Users can update their own trials" ON public.user_trials;
DROP POLICY IF EXISTS "Users can insert their own trials" ON public.user_trials;

DROP POLICY IF EXISTS "Users can update their own subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Users can insert their own subscriptions" ON public.subscriptions;
