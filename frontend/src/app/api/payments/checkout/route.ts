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
  const creditPackUsd = Number(process.env.STRIPE_CREDIT_PACK_USD || '20');
  const unitAmount = Number.isFinite(creditPackUsd) && creditPackUsd > 0
    ? Math.round(creditPackUsd * 100)
    : 2000;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'runmotion.ai credits',
            description: `$${(unitAmount / 100).toFixed(2)} credit top-up`,
          },
          unit_amount: unitAmount,
        },
        quantity: 1,
      },
    ],
    success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/billing/cancel`,
    customer_email: email,
    metadata: {
      email: email || '',
      source: 'dashboard_add_credits',
      amount_cents: String(unitAmount),
    },
  });

  return NextResponse.json({ url: session.url });
}
