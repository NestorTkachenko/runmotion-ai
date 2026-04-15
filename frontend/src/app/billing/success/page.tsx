import Link from 'next/link';

export default function BillingSuccessPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      <div className="max-w-md w-full border border-green-400/20 bg-green-400/10 rounded-2xl p-8 text-center">
        <div className="text-3xl mb-3">✅</div>
        <h1 className="text-2xl font-bold mb-2">Payment received</h1>
        <p className="text-sm text-green-100/90 leading-relaxed mb-6">
          Thanks. Your payment was successful. Credits should appear shortly once billing confirmation completes.
        </p>
        <Link
          href="/dashboard"
          className="inline-block px-5 py-2.5 rounded-lg bg-white text-black text-sm font-semibold hover:bg-gray-100 transition-colors"
        >
          Return to dashboard
        </Link>
      </div>
    </div>
  );
}
