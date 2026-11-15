import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase-admin';
import { getAuthenticatedUser } from '@/utils/supabase-server';
import { getStripeClient } from '@/utils/stripe-server';
import { withCors } from '@/utils/cors';

export const POST = withCors(async function POST(request: NextRequest) {
  try {
    const stripe = getStripeClient();
    const user = await getAuthenticatedUser({ allowBearerToken: true });

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get the subscription ID from the request body
    const { subscriptionId } = await request.json();

    if (!subscriptionId) {
      return NextResponse.json(
        { error: 'Subscription ID is required' },
        { status: 400 }
      );
    }

    const { data: storedSubscription, error: subscriptionLookupError } = await supabaseAdmin
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_subscription_id', subscriptionId)
      .single();

    if (subscriptionLookupError && subscriptionLookupError.code !== 'PGRST116') {
      throw subscriptionLookupError;
    }

    if (!storedSubscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    if (storedSubscription.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // First, get the current subscription status
    const currentSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    
    // If subscription is already canceled, just return success
    if (currentSubscription.status === 'canceled') {
      return NextResponse.json({ status: 'success', alreadyCanceled: true });
    }

    // If subscription is active or trialing, cancel it
    if (['active', 'trialing'].includes(currentSubscription.status)) {
      const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
      });

      // Update the subscription in Supabase
      const { error: supabaseError } = await supabaseAdmin
        .from('subscriptions')
        .update({
          cancel_at_period_end: true,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscriptionId);

      if (supabaseError) {
        console.error('Supabase update error:', supabaseError);
        throw supabaseError;
      }

      return NextResponse.json({
        status: 'success',
        subscription: subscription
      });
    }

    return NextResponse.json(
      { error: 'Subscription cannot be canceled in its current state' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Subscription cancellation failed:', error);
    return NextResponse.json(
      { error: 'Failed to cancel subscription' },
      { status: 500 }
    );
  }
}); 