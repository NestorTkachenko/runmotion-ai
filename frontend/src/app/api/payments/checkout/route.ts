import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export async function POST(req: Request) {
  try {
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Missing STRIPE_SECRET_KEY' }, { status: 500 });
    }

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'https://api.runmotion.ai';
    let meRes: Response;
    try {
      meRes = await fetch(`${backendUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    } catch (e: any) {
      return NextResponse.json({ error: `Auth service unreachable: ${e?.message || 'network error'}` }, { status: 502 });
    }

    if (!meRes.ok) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let me: { email?: string } = {};
    try {
      me = (await meRes.json()) as { email?: string };
    } catch {
      return NextResponse.json({ error: 'Invalid auth response from backend' }, { status: 502 });
    }
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

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe checkout session URL missing' }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unable to start checkout.' }, { status: 500 });
  }
}
