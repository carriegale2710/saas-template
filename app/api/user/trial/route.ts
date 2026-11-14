import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase-admin';
import { getAuthenticatedUser } from '@/utils/supabase-server';
import { withCors } from '@/utils/cors';

const TRIAL_HOURS = 48;

// Starts the caller's trial if they have none. Never extends an existing trial.
// user_trials is service-role write only (see supabase/scripts/setup/05-lock-down-billing-rls.sql).
export const POST = withCors(async function POST() {
  const user = await getAuthenticatedUser({ allowBearerToken: true });
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { error: insertError } = await supabaseAdmin
    .from('user_trials')
    .upsert(
      {
        user_id: user.id,
        trial_end_time: new Date(Date.now() + TRIAL_HOURS * 3_600_000).toISOString(),
        is_trial_used: false,
      },
      { onConflict: 'user_id', ignoreDuplicates: true }
    );

  const { data: trial, error } = insertError
    ? { data: null, error: insertError }
    : await supabaseAdmin
        .from('user_trials')
        .select('trial_end_time, is_trial_used')
        .eq('user_id', user.id)
        .single();

  if (error || !trial) {
    console.error('Error starting trial:', error);
    return NextResponse.json({ error: 'Failed to start trial' }, { status: 500 });
  }

  return NextResponse.json(trial);
});
