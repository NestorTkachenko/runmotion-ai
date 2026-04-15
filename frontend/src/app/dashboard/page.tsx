'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter }  from 'next/navigation';
import { connectSocket, getSocket, apiGet } from '@/lib/socket';
import { Socket } from 'socket.io-client';
import Step1Motors    from '@/components/Step1Motors';
import Step2ArmCalib  from '@/components/Step2ArmCalib';
import Step3Camera    from '@/components/Step3Camera';
import Step4Inference from '@/components/Step4Inference';

export type StepNum = 1 | 2 | 3 | 4;

export interface CameraConfig {
  topDeviceId:    string;
  wristDeviceId:  string;
  topRotation:    0 | 90 | 180 | 270;
  wristRotation:  0 | 90 | 180 | 270;
}

export interface ArmCalibration {
  /** Legacy field — no longer written; kept optional for backward compat. */
  offsetTicks?: Record<number, number>;
  /** Physical minimum tick for each motor (recorded by sweeping to limit). */
  minTicks:    Record<number, number>;
  /** Physical maximum tick for each motor (recorded by sweeping to limit). */
  maxTicks:    Record<number, number>;
}

const STEP_LABELS: Record<StepNum, string> = {
  1: 'Motor Setup',
  2: 'Arm Calibration',
  3: 'Camera Setup',
  4: 'Run AI Policy',
};

export default function DashboardPage() {
  const router = useRouter();
  const MIN_TOP_UP_USD = 5;

  // Auth & credits
  const [email, setEmail]       = useState('');
  const [credits, setCredits]   = useState<number>(0);
  const [addingCredits, setAddingCredits] = useState(false);
  const [billingError, setBillingError]   = useState('');
  const [addCreditsUsd, setAddCreditsUsd] = useState<string>('20');
  const [showTopUpModal, setShowTopUpModal] = useState(false);

  // Step navigation
  const [activeStep, setActiveStep]   = useState<StepNum>(1);
  const [completedSteps, setCompleted] = useState<Set<StepNum>>(new Set());

  // Shared state passed to steps
  const [sdkConnected, setSdkConnected] = useState(false);
  const [armCalib, setArmCalib]         = useState<ArmCalibration | null>(null);
  const [cameraConfig, setCameraConfig] = useState<CameraConfig | null>(null);

  // Socket
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('runmotion_token') : null;
    if (!token) { router.replace('/signin'); return; }

    const storedEmail = localStorage.getItem('runmotion_email') || '';
    setEmail(storedEmail);

    // Connect socket
    const sock = connectSocket(token);
    socketRef.current = sock;

    sock.on('credits_update', ({ credits: c }) => setCredits(c));

    // Fetch initial credits from REST (in case socket missed it)
    apiGet<{ email: string; credits: number }>('/auth/me', token)
      .then((d) => { setCredits(d.credits); setEmail(d.email); })
      .catch(() => {});

    return () => {
      sock.off('credits_update');
    };
  }, [router]);

  const markComplete = useCallback((step: StepNum) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      next.add(step);
      return next;
    });
    if (step < 4) setActiveStep((step + 1) as StepNum);
  }, []);

  function signOut() {
    localStorage.removeItem('runmotion_token');
    localStorage.removeItem('runmotion_email');
    socketRef.current?.disconnect();
    router.replace('/signin');
  }

  async function handleAddCredits(amountUsd: number) {
    const token = typeof window !== 'undefined' ? localStorage.getItem('runmotion_token') : null;
    if (!token) {
      router.replace('/signin');
      return;
    }

    const requestedUsd = Number(amountUsd);
    if (!Number.isFinite(requestedUsd) || requestedUsd < MIN_TOP_UP_USD) {
      setBillingError(`Minimum top-up is $${MIN_TOP_UP_USD}.`);
      return;
    }

    setAddingCredits(true);
    setBillingError('');
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amountUsd: requestedUsd }),
      });
      let data = null;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } catch (err) {
        // Ignore JSON parse errors, data remains null
      }
      if (!res.ok || !data?.url) {
        const httpHint = ` (HTTP ${res.status})`;
        throw new Error(data?.error || `Unable to start checkout.${httpHint}`);
      }
      setShowTopUpModal(false);
      window.location.href = data.url as string;
    } catch (e: any) {
      setBillingError(e.message || 'Unable to start checkout.');
      setAddingCredits(false);
    }
  }

  function openTopUpModal() {
    setBillingError('');
    setShowTopUpModal(true);
  }

  function closeTopUpModal() {
    if (addingCredits) return;
    setBillingError('');
    setShowTopUpModal(false);
  }

  return (
    <div className="min-h-screen dashboard-body flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="h-14 border-b border-gray-200 bg-white flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-2 font-semibold text-gray-900">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center text-xs font-bold text-white">R</span>
          runmotion.ai
        </div>
        <div className="flex items-center gap-4">
          {/* Credits badge */}
          <div className="flex items-center gap-2 bg-gray-100 rounded-full px-3.5 py-1 text-sm">
            <span className="text-gray-500">Credits</span>
            <span className="font-semibold text-gray-900">${(credits / 100).toFixed(2)}</span>
            <button
              onClick={openTopUpModal}
              disabled={addingCredits}
              className="text-violet-600 font-medium hover:text-violet-800 transition-colors text-xs ml-1 disabled:opacity-50"
            >
              Add credits →
            </button>
          </div>
          {/* User */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-400 to-cyan-400 flex items-center justify-center text-white text-xs font-bold">
              {email.charAt(0).toUpperCase()}
            </div>
            <span className="text-sm text-gray-600 hidden sm:block">{email}</span>
          </div>
          <button
            onClick={signOut}
            className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="w-60 border-r border-gray-200 bg-white flex flex-col shrink-0 py-6 px-4 gap-1">
          {([1, 2, 3, 4] as StepNum[]).map((step) => {
            const done    = completedSteps.has(step);
            const active  = activeStep === step;
            return (
              <button
                key={step}
                onClick={() => setActiveStep(step)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  active  ? 'bg-violet-50 text-violet-700'
                  : done   ? 'text-gray-600 hover:bg-gray-50'
                           : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {/* Step indicator */}
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  done   ? 'bg-green-500 text-white'
                  : active ? 'bg-violet-600 text-white'
                           : 'border-2 border-gray-300 text-gray-400'
                }`}>
                  {done ? '✓' : step}
                </div>
                <div>
                  <div className={`text-sm font-medium ${active ? 'text-violet-700' : ''}`}>
                    {STEP_LABELS[step]}
                  </div>
                  {done && <div className="text-[11px] text-green-600">Complete</div>}
                </div>
              </button>
            );
          })}
        </aside>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-6 md:p-10">
          {activeStep === 1 && (
            <Step1Motors
              onComplete={() => { setSdkConnected(true); markComplete(1); }}
              sdkConnected={sdkConnected}
            />
          )}
          {activeStep === 2 && (
            <Step2ArmCalib
              sdkConnected={sdkConnected}
              onComplete={(calib) => {
                setArmCalib(calib);
                socketRef.current?.emit('save_arm_calibration', calib);
                markComplete(2);
              }}
            />
          )}
          {activeStep === 3 && (
            <Step3Camera
              onComplete={(cfg) => {
                setCameraConfig(cfg);
                socketRef.current?.emit('save_camera_config', cfg);
                markComplete(3);
              }}
            />
          )}
          {activeStep === 4 && (
            <Step4Inference
              socket={socketRef.current}
              sdkConnected={sdkConnected}
              cameraConfig={cameraConfig}
              armCalib={armCalib}
              credits={credits}
              onCreditsChange={setCredits}
              onDisconnect={() => setSdkConnected(false)}
            />
          )}
        </main>
      </div>

      {showTopUpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close top-up dialog"
            onClick={closeTopUpModal}
            className="absolute inset-0 bg-black/40"
          />
          <div className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-2xl p-6 animate-fade-in">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Add Credits</h3>
              <p className="text-sm text-gray-500 mt-1">Choose how much to top up. Minimum is $5.</p>
            </div>

            <div className="grid grid-cols-5 gap-2 mb-4">
              {[5, 10, 20, 50, 100].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setAddCreditsUsd(String(amt))}
                  className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                    Number(addCreditsUsd) === amt
                      ? 'border-violet-500 bg-violet-50 text-violet-700'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  ${amt}
                </button>
              ))}
            </div>

            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Custom amount (USD)
            </label>
            <input
              type="number"
              min={MIN_TOP_UP_USD}
              step="1"
              value={addCreditsUsd}
              onChange={(e) => setAddCreditsUsd(e.target.value)}
              disabled={addingCredits}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-violet-400"
            />

            {billingError && (
              <div className="text-xs text-red-500 mt-2">{billingError}</div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeTopUpModal}
                disabled={addingCredits}
                className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleAddCredits(Number(addCreditsUsd))}
                disabled={addingCredits}
                className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50"
              >
                {addingCredits ? 'Opening checkout…' : 'Continue to checkout'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
