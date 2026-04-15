import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export async function POST(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Missing STRIPE_SECRET_KEY' }, { status: 500 });
  }

  if (!process.env.STRIPE_PRICE_ID_CREDITS) {
    return NextResponse.json({ error: 'Missing STRIPE_PRICE_ID_CREDITS' }, { status: 500 });
  }

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'https://api.runmotion.ai';
  const meRes = await fetch(`${backendUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!meRes.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const me = (await meRes.json()) as { email?: string };
  const email = me.email || undefined;

  const hdrs = headers();
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    hdrs.get('origin') ||
    'https://www.runmotion.ai';

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price: process.env.STRIPE_PRICE_ID_CREDITS,
        quantity: 1,
      },
    ],
    success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/billing/cancel`,
    customer_email: email,
    metadata: {
      email: email || '',
      source: 'dashboard_add_credits',
    },
  });

  return NextResponse.json({ url: session.url });
}
