import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export async function POST(req: Request) {
  try {
    const MIN_TOP_UP_USD = 5;
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim().replace(/^['\"]|['\"]$/g, '');
    if (!stripeKey) {
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

    const stripe = new Stripe(stripeKey, {
      maxNetworkRetries: 2,
      timeout: 20000,
    });

    let requestedAmountUsd: number | null = null;
    try {
      const rawBody = await req.text();
      if (rawBody) {
        const parsed = JSON.parse(rawBody) as { amountUsd?: number };
        const amt = Number(parsed.amountUsd);
        if (Number.isFinite(amt)) requestedAmountUsd = amt;
      }
    } catch {
      // If body is invalid/empty, we'll fall back to env default.
    }

    const defaultCreditPackUsd = Number(process.env.STRIPE_CREDIT_PACK_USD || '20');
    const baseAmountUsd = requestedAmountUsd ?? (Number.isFinite(defaultCreditPackUsd) ? defaultCreditPackUsd : 20);
    const normalizedAmountUsd = Math.max(MIN_TOP_UP_USD, baseAmountUsd);
    const unitAmount = Math.round(normalizedAmountUsd * 100);

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
        amount_usd: normalizedAmountUsd.toFixed(2),
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe checkout session URL missing' }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    const stripeType = e?.type as string | undefined;
    const stripeCode = e?.code as string | undefined;

    if (stripeType === 'StripeAuthenticationError') {
      return NextResponse.json(
        { error: 'Stripe authentication failed. Verify STRIPE_SECRET_KEY in Vercel production env.' },
        { status: 500 },
      );
    }

    if (stripeType === 'StripeConnectionError') {
      return NextResponse.json(
        { error: `Stripe connection error: ${e?.message || 'network issue contacting Stripe'}` },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { error: e?.message || `Unable to start checkout${stripeCode ? ` (${stripeCode})` : ''}.` },
      { status: 500 },
    );
  }
}
