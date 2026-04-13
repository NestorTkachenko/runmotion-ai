import Link from 'next/link';
export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      <h1 className="text-4xl font-bold mb-4 gradient-text">How It Works</h1>
      <p className="text-gray-400 mb-8 text-center max-w-lg">Documentation coming soon. For now, check the README in the repository for setup instructions.</p>
      <Link href="/" className="text-violet-400 hover:underline">← Back to home</Link>
    </div>
  );
}
