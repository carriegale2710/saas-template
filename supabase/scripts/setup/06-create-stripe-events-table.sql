-- supabase/scripts/setup/06-create-stripe-events-table.sql
-- Records Stripe webhook event ids so retries/duplicate deliveries are only processed once.
-- Used by /api/stripe/webhook via the service role.
--
-- A row is inserted when processing starts (the "claim") and processed_at is set when it
-- finishes. A claim without processed_at that is older than a few minutes is treated as
-- abandoned (e.g. the function was killed mid-way) and can be retaken by a Stripe retry.

CREATE TABLE IF NOT EXISTS public.stripe_events (
    id TEXT PRIMARY KEY, -- Stripe event id (evt_...)
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- For databases that already ran an earlier version of this script.
ALTER TABLE public.stripe_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- RLS on with no policies: anon/authenticated get no access,
-- the service role bypasses RLS.
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.stripe_events IS 'Stripe webhook event ids for idempotency (service role only)';
