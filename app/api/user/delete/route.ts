import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase-admin';
import { getAuthenticatedUser } from '@/utils/supabase-server';
import { getStripeClient } from '@/utils/stripe-server';
import { withCors } from '@/utils/cors';

export const DELETE = withCors(async function DELETE(request: NextRequest) {
  try {
    const stripe = getStripeClient();
    const user = await getAuthenticatedUser({ allowBearerToken: true });

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }

    if (userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    console.log('Starting account soft-deletion for user:', userId);

    // 1. Cancel Stripe subscriptions if they exist
    const { data: subscriptionsData, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_subscription_id, status')
      .eq('user_id', userId);

    if (subError) {
      console.error('Subscription fetch error:', subError);
    } else if (subscriptionsData) {
      for (const sub of subscriptionsData) {
        if (sub.stripe_subscription_id && (sub.status === 'active' || sub.status === 'trialing')) {
          try {
            await stripe.subscriptions.cancel(sub.stripe_subscription_id);
            console.log('Stripe subscription cancelled:', sub.stripe_subscription_id);
          } catch (stripeError) {
            console.error('Stripe cancellation error:', stripeError);
          }
        }
      }
    }

    // 2. Soft delete the profile
    const { error: profileError } = await supabaseAdmin
      .from('users')
      .update({ 
        deleted_at: new Date().toISOString(),
        is_deleted: true
      })
      .eq('id', userId);

    if (profileError) {
      console.error('Profile update error:', profileError);
      return NextResponse.json(
        { error: 'Failed to update profile' },
        { status: 500 }
      );
    }

    // 3. Mark subscriptions as canceled
    const { error: subscriptionUpdateError } = await supabaseAdmin
      .from('subscriptions')
      .update({
        deleted_at: new Date().toISOString(),
        status: 'canceled'
      })
      .eq('user_id', userId);

    if (subscriptionUpdateError) {
      console.error('Subscription update error:', subscriptionUpdateError);
    }

    console.log('Account soft-deletion completed successfully');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in account soft-deletion:', error);
    return NextResponse.json(
      { error: 'Failed to process account deletion' },
      { status: 500 }
    );
  }
}); 