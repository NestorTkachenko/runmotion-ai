'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { apiPost } from '@/lib/socket';

function SignInContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode]         = useState<'signin' | 'signup'>(
    searchParams.get('mode') === 'signup' ? 'signup' : 'signin',
  );
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    // If already logged in, redirect to dashboard
    if (typeof window !== 'undefined' && localStorage.getItem('arm101_token')) {
      router.replace('/dashboard');
    }
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const path = mode === 'signup' ? '/auth/signup' : '/auth/login';
      const data = await apiPost<{ token: string; credits: number }>(path, { email, password });
      localStorage.setItem('arm101_token', data.token);
      localStorage.setItem('arm101_email', email);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2 mb-10 text-white font-semibold text-lg">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-sm font-bold">A</span>
        ARM101
      </Link>

      {/* Card */}
      <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-2xl p-8">
        {/* Tabs */}
        <div className="flex rounded-lg overflow-hidden border border-white/10 mb-6">
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(''); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                mode === m ? 'bg-white text-black' : 'text-gray-400 hover:text-white'
              }`}
            >
              {m === 'signin' ? 'Sign In' : 'Sign Up'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none transition-colors"
            />
          </div>

          {error && (
            <div className="text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-white text-black font-semibold text-sm hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (mode === 'signup' ? 'Creating account...' : 'Signing in...') : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </button>
        </form>

        {mode === 'signup' && (
          <p className="text-center text-xs text-gray-500 mt-4">
            Starts with $5.00 free credits. No credit card required.
          </p>
        )}
      </div>

      <Link href="/" className="mt-6 text-xs text-gray-600 hover:text-gray-400 transition-colors">
        ← Back to home
      </Link>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center text-sm text-gray-400">
          Loading sign in...
        </div>
      }
    >
      <SignInContent />
    </Suspense>
  );
}
