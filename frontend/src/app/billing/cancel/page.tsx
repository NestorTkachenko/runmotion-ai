import Link from 'next/link';

export default function BillingCancelPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      <div className="max-w-md w-full border border-white/10 bg-white/5 rounded-2xl p-8 text-center">
        <div className="text-3xl mb-3">ℹ️</div>
        <h1 className="text-2xl font-bold mb-2">Checkout canceled</h1>
        <p className="text-sm text-gray-300 leading-relaxed mb-6">
          No payment was processed. You can return anytime and try adding credits again.
        </p>
        <Link
          href="/dashboard"
          className="inline-block px-5 py-2.5 rounded-lg bg-white text-black text-sm font-semibold hover:bg-gray-100 transition-colors"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
