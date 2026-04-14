'use client';

import { useState } from 'react';
import Link from 'next/link';

const CATEGORIES = ['Feature Request', 'Bug Report', 'Partnership / Business', 'General Inquiry', 'Other'];

export default function ContactPage() {
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [message, setMessage]   = useState('');
  const [sending, setSending]   = useState(false);
  const [sent, setSent]         = useState(false);
  const [error, setError]       = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, category, message }),
      });
      if (!res.ok) throw new Error('Failed to send message.');
      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6 py-16">
      <h1 className="text-4xl font-bold mb-2 gradient-text">Contact Us</h1>
      <p className="text-gray-400 mb-10 text-center max-w-md">
        Have a suggestion, found a bug, or want to partner with us? Send us a message.
      </p>

      {sent ? (
        <div className="border border-green-500/30 rounded-xl p-8 max-w-sm w-full bg-green-500/10 text-center">
          <div className="text-2xl mb-3">✓</div>
          <p className="text-green-400 font-semibold mb-1">Message sent!</p>
          <p className="text-gray-400 text-sm">We&apos;ll get back to you at {email}.</p>
          <Link href="/" className="mt-6 inline-block text-xs text-gray-500 hover:text-gray-300">← Back to home</Link>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="border border-white/10 rounded-xl p-8 max-w-md w-full bg-white/5 space-y-5"
        >
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-[#111] border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Message</label>
            <textarea
              required
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              placeholder="Describe your feature request, bug, or question…"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors resize-none"
            />
          </div>

          {error && <p className="text-red-400 text-xs">{error}</p>}

          <button
            type="submit"
            disabled={sending}
            className="w-full py-2.5 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send Message'}
          </button>
        </form>
      )}

      <Link href="/" className="mt-8 text-xs text-gray-600 hover:text-gray-400">← Back to home</Link>
    </div>
  );
}

