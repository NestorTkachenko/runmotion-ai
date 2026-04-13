import Link from 'next/link';
export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      <h1 className="text-4xl font-bold mb-4 gradient-text">Pricing</h1>
      <p className="text-gray-400 mb-4 text-center max-w-lg">Simple, usage-based pricing.</p>
      <div className="border border-white/10 rounded-xl p-8 max-w-sm w-full bg-white/5 text-center mb-8">
        <div className="text-5xl font-bold mb-2">$0.15</div>
        <div className="text-gray-400 mb-4">per minute of inference</div>
        <div className="text-sm text-gray-500">Billed only while the arm is moving.<br/>Loading times are free.</div>
      </div>
      <div className="text-sm text-gray-500 mb-8">New accounts start with <span className="text-white">$5.00 free credits</span> — no card needed.</div>
      <Link href="/signin?mode=signup" className="px-6 py-2.5 rounded-lg bg-white text-black font-semibold text-sm hover:bg-gray-100 transition-colors mb-4">Get started free</Link>
      <Link href="/" className="text-xs text-gray-600 hover:text-gray-400">← Back to home</Link>
    </div>
  );
}
