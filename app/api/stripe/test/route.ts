import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getStripeClient } from '@/utils/stripe-server';
import { withCors } from '@/utils/cors';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const GET = withCors(async function GET(request: NextRequest) {
  try {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const stripe = getStripeClient();
    console.log('Testing Stripe connection...');
    
    // Just verify the connection works
    await stripe.balance.retrieve();
    console.log('Stripe connection successful');
    
    return NextResponse.json({ 
      status: 'success',
      message: 'Stripe connection successful'
    });
  } catch (error) {
    console.error('Stripe test failed:', error);
    return NextResponse.json({ 
      status: 'error',
      message: 'Stripe connection failed'
    }, { status: 500 });
  }
}); 