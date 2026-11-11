import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { supabaseAdmin } from '@/utils/supabase-admin';
import { withCors } from '@/utils/cors';
import { getStripeClient, getStripeWebhookSecret } from '@/utils/stripe-server';

// Helper function for consistent logging
function logWebhookEvent(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] WEBHOOK: ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// Define interfaces for stored data
interface StoredSessionData {
  userId: string;
  customerId: string;
}

interface StoredSubscriptionData {
  id: string;
  customer: string;
}

interface SubscriptionLogData {
  id?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: number | string | null;
}

function getStripeSubscriptionLogData(subscription: Stripe.Subscription): SubscriptionLogData {
  return {
    id: subscription.id,
    stripeCustomerId:
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd: subscription.current_period_end,
  };
}

function getStoredSubscriptionLogData(subscription: Record<string, unknown>): SubscriptionLogData {
  return {
    id: typeof subscription.id === 'string' ? subscription.id : undefined,
    stripeSubscriptionId:
      typeof subscription.stripe_subscription_id === 'string'
        ? subscription.stripe_subscription_id
        : undefined,
    stripeCustomerId:
      typeof subscription.stripe_customer_id === 'string'
        ? subscription.stripe_customer_id
        : undefined,
    status: typeof subscription.status === 'string' ? subscription.status : undefined,
    cancelAtPeriodEnd:
      typeof subscription.cancel_at_period_end === 'boolean'
        ? subscription.cancel_at_period_end
        : undefined,
    currentPeriodEnd:
      typeof subscription.current_period_end === 'string' ||
      typeof subscription.current_period_end === 'number'
        ? subscription.current_period_end
        : null,
  };
}

function getErrorLogData(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  if (typeof error === 'object' && error !== null) {
    const message =
      'message' in error && typeof error.message === 'string' ? error.message : 'Unknown error';
    const name = 'name' in error && typeof error.name === 'string' ? error.name : 'Error';

    return { name, message };
  }

  return { message: String(error) };
}

// Store both checkout sessions and subscriptions temporarily
const checkoutSessionMap = new Map<string, StoredSessionData>();
const pendingSubscriptions = new Map<string, StoredSubscriptionData>();

// Need to disable body parsing for Stripe webhooks
export const config = {
  api: {
    bodyParser: false,
  },
};

async function checkExistingSubscription(customerId: string): Promise<boolean> {
  const { data: existingSubs } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .in('status', ['active', 'trialing'])
    .single();

  return !!existingSubs;
}

// Currently Handled Events:
// 1. checkout.session.completed - When a customer completes checkout
// 2. customer.subscription.created - When a new subscription is created
// 3. customer.subscription.updated - When a subscription is updated
// 4. customer.subscription.deleted - When a subscription is cancelled/deleted
// 5. customer.subscription.pending_update_applied - When a pending update is applied
// 6. customer.subscription.pending_update_expired - When a pending update expires
// 7. customer.subscription.trial_will_end - When a trial is about to end
// 8. invoice.paid - Refreshes subscription status/period from Stripe
// 9. invoice.payment_failed - Stores Stripe's real status (usually past_due)

// Other Important Events You Might Want to Handle:

// Payment Related:
// - invoice.upcoming - When an invoice is going to be created
// - payment_intent.succeeded - When a payment is successful
// - payment_intent.payment_failed - When a payment fails

// Customer Related:
// - customer.created - When a new customer is created
// - customer.updated - When customer details are updated
// - customer.deleted - When a customer is deleted

// Subscription Related:
// - customer.subscription.paused - When a subscription is paused
// - customer.subscription.resumed - When a subscription is resumed
// - customer.subscription.trial_will_end - 3 days before trial ends

// Checkout Related:
// - checkout.session.async_payment_succeeded - Async payment success
// - checkout.session.async_payment_failed - Async payment failure
// - checkout.session.expired - When checkout session expires

export const POST = withCors(async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  const stripe = getStripeClient();
  const webhookSecret = getStripeWebhookSecret();

  try {
    logWebhookEvent('Received webhook request');

    if (!sig) {
      logWebhookEvent('Missing stripe-signature header');
      return NextResponse.json(
        { error: 'Missing stripe-signature header' },
        { status: 400 }
      );
    }

    const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    logWebhookEvent(`Event received: ${event.type}`, { id: event.id });

    // Idempotency: claim the event id before processing. A duplicate delivery hits the
    // primary key and is acknowledged without being processed again.
    // ponytail: claim-then-process. If processing throws we delete the claim so Stripe's
    // retry can reprocess; a concurrent duplicate that arrives while the first attempt is
    // still running is acked and skipped, so it relies on that first attempt's retry.
    // Insert-after-success would avoid that window but lets parallel duplicates both run.
    const { error: claimError } = await supabaseAdmin
      .from('stripe_events')
      .insert({ id: event.id, type: event.type });

    if (claimError) {
      if (claimError.code === '23505') {
        logWebhookEvent('Duplicate event skipped', { id: event.id });
        return NextResponse.json({ received: true, duplicate: true });
      }
      throw claimError;
    }

    try {
      return await handleEvent(event);
    } catch (error) {
      await supabaseAdmin.from('stripe_events').delete().eq('id', event.id);
      throw error;
    }
  } catch (err) {
    logWebhookEvent('Webhook error', getErrorLogData(err));
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 400 }
    );
  }
});

async function handleEvent(event: Stripe.Event) {
  const stripe = getStripeClient();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        // Check for existing active subscription
        const hasActiveSubscription = await checkExistingSubscription(session.customer as string);
        
        if (hasActiveSubscription) {
          logWebhookEvent('Duplicate subscription attempt blocked', {
            customerId: session.customer,
            sessionId: session.id
          });
          
          // Cancel the new subscription immediately
          if (session.subscription) {
            await stripe.subscriptions.cancel(session.subscription as string);
          }
          
          return NextResponse.json({ 
            status: 'blocked',
            message: 'Customer already has an active subscription'
          });
        }

        logWebhookEvent('Processing checkout.session.completed', {
          sessionId: session.id,
          clientReferenceId: session.client_reference_id,
          customerId: session.customer,
          subscriptionId: session.subscription
        });

        if (!session.client_reference_id || !session.customer || !session.subscription) {
          logWebhookEvent('Missing required session data', {
            clientReferenceId: session.client_reference_id,
            customerId: session.customer,
            subscriptionId: session.subscription
          });
          return NextResponse.json({ error: 'Invalid session data' }, { status: 400 });
        }

        try {
          const subscription = await createSubscription(
            session.subscription as string,
            session.client_reference_id!,
            session.customer as string
          );
          logWebhookEvent(
            'Successfully created subscription',
            getStoredSubscriptionLogData(subscription)
          );
        } catch (error) {
          logWebhookEvent('Failed to create subscription', getErrorLogData(error));
          throw error;
        }
        break;
      }

      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        
        // Check if we have the session data already
        const sessionData = checkoutSessionMap.get(subscription.id);
        if (sessionData) {
          // We can create the subscription now
          await createSubscription(
            subscription.id,
            sessionData.userId,
            sessionData.customerId
          );
          checkoutSessionMap.delete(subscription.id);
        } else {
          // Store the subscription data until we get the session
          pendingSubscriptions.set(subscription.id, {
            id: subscription.id,
            customer: subscription.customer as string
          });
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.pending_update_applied':
      case 'customer.subscription.pending_update_expired':
      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
        
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: subscription.status,
            cancel_at_period_end: false,
            current_period_end: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
        
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId =
          typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;

        // One-off invoices have no subscription to sync.
        if (!subscriptionId) break;

        // Store Stripe's real status (e.g. past_due after a failed payment, active after paid).
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({
            status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscriptionId);

        if (error) throw error;
        break;
      }
    }

    return NextResponse.json({ received: true });
}

async function createSubscription(subscriptionId: string, userId: string, customerId: string) {
  const stripe = getStripeClient();
  logWebhookEvent('Starting createSubscription', { subscriptionId, userId, customerId });

  try {
    const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    logWebhookEvent('Retrieved Stripe subscription', getStripeSubscriptionLogData(stripeSubscription));

    const { data: existingData, error: checkError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('stripe_subscription_id', subscriptionId)
      .single();

    if (checkError) {
      logWebhookEvent('Error checking existing subscription', getErrorLogData(checkError));
    }

    if (existingData) {
      logWebhookEvent('Found existing subscription', getStoredSubscriptionLogData(existingData));
      const { error: updateError } = await supabaseAdmin
        .from('subscriptions')
        .update({
          status: stripeSubscription.status,
          current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
          cancel_at_period_end: stripeSubscription.cancel_at_period_end,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscriptionId)
        .select()
        .single();

      if (updateError) {
        logWebhookEvent('Error updating existing subscription', getErrorLogData(updateError));
        throw updateError;
      }
      return existingData;
    }

    logWebhookEvent('Creating new subscription record');
    const { data, error: insertError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: stripeSubscription.status,
        price_id: stripeSubscription.items.data[0]?.price.id,
        current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
        cancel_at_period_end: stripeSubscription.cancel_at_period_end,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      logWebhookEvent('Error inserting new subscription', getErrorLogData(insertError));
      throw insertError;
    }

    logWebhookEvent('Successfully created new subscription', getStoredSubscriptionLogData(data));
    return data;
  } catch (error) {
    logWebhookEvent('Error in createSubscription', getErrorLogData(error));
    throw error;
  }
} 