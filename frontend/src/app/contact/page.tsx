import Link from 'next/link';
export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      <h1 className="text-4xl font-bold mb-4 gradient-text">Contact</h1>
      <p className="text-gray-400 mb-8 text-center max-w-md">Questions, feedback, or enterprise inquiries? Reach out below.</p>
      <div className="border border-white/10 rounded-xl p-8 max-w-sm w-full bg-white/5 space-y-4">
        <p className="text-gray-400 text-sm text-center">Contact form coming soon.</p>
        <p className="text-center text-sm text-gray-500">For now, email us at <span className="text-violet-400">hello@arm101.ai</span></p>
      </div>
      <Link href="/" className="mt-8 text-xs text-gray-600 hover:text-gray-400">← Back to home</Link>
    </div>
  );
}
