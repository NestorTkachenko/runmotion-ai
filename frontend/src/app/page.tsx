'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* ── Navigation ─────────────────────────────────────────────────────── */}
      <nav
        className={`fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-12 h-14 transition-all duration-300 ${
          scrolled ? 'bg-[#0a0a0a]/90 backdrop-blur border-b border-white/10' : ''
        }`}
      >
        <Link href="/" className="flex items-center gap-2 font-semibold text-base tracking-tight">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-xs font-bold">R</span>
          runmotion.ai
        </Link>

        <div className="hidden md:flex items-center gap-8 text-sm text-gray-400">
          <Link href="#features" className="hover:text-white transition-colors">Product</Link>
          <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
          <Link href="/how-it-works" className="hover:text-white transition-colors">Docs</Link>
          <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/signin" className="text-sm text-gray-400 hover:text-white transition-colors px-4 py-1.5">
            Sign in
          </Link>
          <Link
            href="/signin?mode=signup"
            className="text-sm bg-white text-black font-medium px-4 py-1.5 rounded-md hover:bg-gray-100 transition-colors"
          >
            Get started
          </Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center justify-center text-center px-6 pt-40 pb-28 overflow-hidden bg-grid">
        {/* Radial glow */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[600px] h-[400px] rounded-full bg-violet-600/15 blur-[120px]" />
        </div>

        {/* Badge */}
        <div className="relative mb-6 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-sm text-violet-300">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
          Now in early access — no fine-tuning required
        </div>

        {/* Headline */}
        <h1 className="relative max-w-3xl text-5xl md:text-7xl font-bold tracking-tight leading-tight gradient-text mb-6">
          Run physical AI<br />
          <span className="gradient-text-brand">from your browser</span>
        </h1>

        <p className="relative max-w-xl text-lg md:text-xl text-gray-400 mb-10 leading-relaxed">
          No installs, no code, no GPU needed.&nbsp;
          Connect your robot arm, pick a task, and let the AI do the rest.
          <span className="text-violet-400 font-medium"> Zero-shot — no dataset collection or fine-tuning required.</span>
        </p>

        {/* CTAs */}
        <div className="relative flex flex-col sm:flex-row items-center gap-4">
          <Link
            href="/signin?mode=signup"
            className="px-7 py-3 rounded-lg bg-white text-black font-semibold text-sm hover:bg-gray-100 transition-colors"
          >
            Start for free →
          </Link>
          <Link
            href="/how-it-works"
            className="px-7 py-3 rounded-lg border border-white/15 text-white text-sm font-medium hover:bg-white/5 transition-colors"
          >
            How it works
          </Link>
        </div>

        {/* Robot purchase nudge */}
        <div className="relative mt-5 flex items-center gap-2 text-sm text-gray-500">
          <span>Don&apos;t have an SO-ARM101 yet?</span>
          <a
            href="https://shop.wowrobo.com/products/so-arm101-diy-kit-assembled-version-1?variant=46588630630617"
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-400 hover:text-violet-300 underline underline-offset-2 transition-colors font-medium"
          >
            Get one for $259 →
          </a>
        </div>

        {/* Video placeholder */}
        <div className="relative mt-20 w-full max-w-4xl">
          <div className="aspect-video rounded-2xl border border-white/10 bg-white/5 backdrop-blur flex flex-col items-center justify-center glow-violet">
            <div className="w-16 h-16 rounded-full bg-white/10 border border-white/20 flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <p className="text-gray-500 text-sm">Demo video coming soon</p>
          </div>
        </div>
      </section>

      {/* ── No fine-tuning callout ────────────────────────────────────────── */}
      <section className="py-12 px-6 border-t border-white/10 bg-gradient-to-r from-violet-950/40 to-cyan-950/30">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 text-center md:text-left">
          <div>
            <div className="text-2xl font-bold text-white mb-1">No fine-tuning. No pretraining. No data collection.</div>
            <div className="text-gray-400 text-sm">
              Our models run zero-shot on your robot. Describe the task in plain English and the AI figures out the rest.
            </div>
          </div>
          <Link
            href="/signin?mode=signup"
            className="whitespace-nowrap px-6 py-3 rounded-lg bg-white text-black font-semibold text-sm hover:bg-gray-100 transition-colors shrink-0"
          >
            Try it free →
          </Link>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────────────── */}
      <section id="features" className="py-24 px-6 md:px-12 max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4 gradient-text">
          Everything you need
        </h2>
        <p className="text-center text-gray-400 mb-16 text-lg">
          From first plug-in to running inference in minutes.
        </p>

        <div className="grid md:grid-cols-3 gap-6">
          {[
            {
              icon: '🤖',
              title: 'Browser-native control',
              body: 'Direct USB serial connection via the Web Serial API. No drivers, no apps — just your browser.',
            },
            {
              icon: '⚡',
              title: 'Instant AI inference',
              body: 'GPU containers stay warm so your first inference takes seconds, not minutes. 50 action steps returned per request.',
            },
            {
              icon: '🔧',
              title: 'Guided 4-step setup',
              body: 'Motor IDs, arm calibration, camera assignment — all done in-browser with real-time feedback.',
            },
            {
              icon: '👥',
              title: 'Multi-user scaling',
              body: 'Each user gets their own inference session. Containers auto-scale to handle demand.',
            },
            {
              icon: '💳',
              title: 'Pay as you go',
              body: 'Start with $5 free credits. Inference costs $0.15/min, billed only while the arm is moving.',
            },
            {
              icon: '🧠',
              title: 'Zero-shot, no fine-tuning',
              body: 'Run AI policies out of the box — no dataset collection, no training runs, no pretraining on your robot. Just describe the task and go.',
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-white/10 bg-white/5 p-6 hover:border-white/20 hover:bg-white/[0.07] transition-all"
            >
              <div className="text-3xl mb-4">{f.icon}</div>
              <div className="font-semibold text-white mb-2">{f.title}</div>
              <div className="text-gray-400 text-sm leading-relaxed">{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Steps preview ────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 md:px-12 bg-white/[0.02] border-t border-white/10">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 gradient-text">Four steps to running AI</h2>
          <p className="text-gray-400 text-lg mb-16">Designed to get you from unboxing to inference in under 10 minutes.</p>
          <div className="grid md:grid-cols-4 gap-4">
            {['Motor Setup', 'Arm Calibration', 'Camera Setup', 'Run AI Policy'].map((label, i) => (
              <div key={label} className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full border-2 border-violet-500 flex items-center justify-center font-bold text-violet-400 text-xl">
                  {i + 1}
                </div>
                <div className="text-sm font-medium text-white">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA banner ───────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 text-center">
        <h2 className="text-3xl md:text-5xl font-bold gradient-text mb-4">
          Start running your arm today.
        </h2>
        <p className="text-gray-400 text-lg mb-8">$5 in free credits, no credit card required.</p>
        <Link
          href="/signin?mode=signup"
          className="inline-block px-10 py-3.5 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-500 text-white font-semibold text-sm hover:opacity-90 transition-opacity"
        >
          Get started free →
        </Link>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/10 py-10 px-6 md:px-12">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 text-sm text-gray-500">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded bg-gradient-to-br from-violet-500 to-cyan-500" />
            <span className="font-medium text-white">runmotion.ai</span>
          </div>
          <div className="flex gap-6">
            <Link href="/how-it-works" className="hover:text-white transition-colors">Docs</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
            <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
          </div>
          <div>© {new Date().getFullYear()} runmotion.ai. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
