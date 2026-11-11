-- supabase/scripts/setup/06-create-stripe-events-table.sql
-- Records processed Stripe webhook event ids so retries/duplicate deliveries
-- are only processed once. Used by /api/stripe/webhook via the service role.

CREATE TABLE IF NOT EXISTS public.stripe_events (
    id TEXT PRIMARY KEY, -- Stripe event id (evt_...)
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS on with no policies: anon/authenticated get no access,
-- the service role bypasses RLS.
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.stripe_events IS 'Processed Stripe webhook event ids for idempotency (service role only)';
