'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GoogleLogin } from '@react-oauth/google';
import { apiPost } from '@/lib/socket';

function SignInContent() {
  const router   = useRouter();
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('runmotion_token')) {
      router.replace('/dashboard');
    }
  }, [router]);

  async function handleGoogleSuccess(credentialResponse: { credential?: string }) {
    if (!credentialResponse.credential) return;
    setError('');
    setLoading(true);
    try {
      const data = await apiPost<{ token: string; credits: number; email: string }>(
        '/auth/google',
        { credential: credentialResponse.credential },
      );
      localStorage.setItem('runmotion_token', data.token);
      localStorage.setItem('runmotion_email', data.email);
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
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-sm font-bold">R</span>
        runmotion.ai
      </Link>

      {/* Card */}
      <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-2xl p-8">
        <h2 className="text-xl font-bold text-white text-center mb-2">Welcome</h2>
        <p className="text-gray-400 text-sm text-center mb-8">
          Sign in or create an account to get started.<br />
          <span className="text-violet-400 text-xs">Starts with $5.00 free credits. No credit card required.</span>
        </p>

        {error && (
          <div className="text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2 mb-4 text-center">
            {error}
          </div>
        )}

        <div className={`flex justify-center ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
          <GoogleLogin
            onSuccess={handleGoogleSuccess}
            onError={() => setError('Google sign-in failed. Please try again.')}
            theme="filled_black"
            shape="rectangular"
            width="300"
            text="continue_with"
          />
        </div>

        {loading && (
          <p className="text-center text-xs text-gray-500 mt-4">Signing you in…</p>
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

