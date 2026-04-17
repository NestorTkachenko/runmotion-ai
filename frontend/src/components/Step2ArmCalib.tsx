'use client';

import { useState, useEffect, useRef } from 'react';
import {
  MOTOR_IDS, MOTOR_LABELS, getSDK,
  setTorqueAll, applyHomingCorrections, resetLimitsToFull,
} from '@/lib/feetech';
import type { ArmCalibration } from '@/app/dashboard/page';

interface Props {
  sdkConnected: boolean;
  onComplete: (calib: ArmCalibration) => void;
}

type Phase = 'intro' | 'limits' | 'done';

const MIN_RANGE         = 2000;
const GRIPPER_ID        = 6;
const GRIPPER_MIN_RANGE = 1000;
const STORAGE_KEY       = 'arm_calibration_v2';  // v2 = EEPROM-homed

export default function Step2ArmCalib({ sdkConnected, onComplete }: Props) {
  const [phase,        setPhase]        = useState<Phase>('intro');
  const [positions,    setPositions]    = useState<Map<number, number>>(new Map());
  const [minPos,       setMinPos]       = useState<Map<number, number>>(new Map());
  const [maxPos,       setMaxPos]       = useState<Map<number, number>>(new Map());
  const [monitoring,   setMonitoring]   = useState(false);
  const [busy,         setBusy]         = useState(false);
  const [log,          setLog]          = useState<string[]>([]);
  const [savedCalib,   setSavedCalib]   = useState<ArmCalibration | null>(null);
  const [midConfirmed, setMidConfirmed] = useState(false);
  const intervalRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const minRef          = useRef<Map<number, number>>(new Map());
  const maxRef          = useRef<Map<number, number>>(new Map());

  const addLog = (msg: string) => setLog(l => [msg, ...l].slice(0, 20));

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSavedCalib(JSON.parse(raw));
    } catch {}
    return () => {
      if (intervalRef.current)     clearInterval(intervalRef.current);
    };
  }, []);

  async function handleSetNeutral() {
    if (!sdkConnected) { addLog('Connect controller in Step 1 first.'); return; }
    setBusy(true);
    try {
      addLog('Disabling torque…');
      await setTorqueAll(false);
      addLog('Resetting EEPROM position limits to full range…');
      await resetLimitsToFull();
      addLog('Writing EEPROM homing corrections (neutral → 2047)…');
      const verified = await applyHomingCorrections();
      const center = new Map(MOTOR_IDS.map(id => [id, verified.get(id) ?? 2047]));
      addLog(`✓ Neutral set. Readings: [${MOTOR_IDS.map(id => center.get(id)).join(', ')}]`);
      addLog('Now sweep each joint to its full range extremes.');
      minRef.current = new Map(center);
      maxRef.current = new Map(center);
      setPositions(new Map(center));
      setMinPos(new Map(center));
      setMaxPos(new Map(center));
      setPhase('limits');
      startMonitoring();
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function startMonitoring() {
    setMonitoring(true);
    addLog('Monitoring started. Move each joint to its extremes.');
    intervalRef.current = setInterval(async () => {
      try {
        const sdk    = await getSDK();
        const posMap: Map<number, number> = await sdk.syncReadPositions(Array.from(MOTOR_IDS));
        setPositions(new Map(posMap));
        for (const id of MOTOR_IDS) {
          const t = posMap.get(id) ?? 2047;
          if (t < (minRef.current.get(id) ?? 4095)) minRef.current.set(id, t);
          if (t > (maxRef.current.get(id) ?? 0))    maxRef.current.set(id, t);
        }
        setMinPos(new Map(minRef.current));
        setMaxPos(new Map(maxRef.current));
      } catch {}
    }, 100);
  }

  function stopMonitoring() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setMonitoring(false);
    addLog('Monitoring stopped.');
  }

  async function handleFinish() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setMonitoring(false);
    setBusy(true);
    try {
      await setTorqueAll(true);
      const calib: ArmCalibration = {
        minTicks: Object.fromEntries(minRef.current),
        maxTicks: Object.fromEntries(maxRef.current),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(calib));
      setSavedCalib(calib);
      setMinPos(new Map(minRef.current));
      setMaxPos(new Map(maxRef.current));
      setPhase('done');
      addLog('✓ Calibration saved locally. Torque re-enabled.');
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleLoadSaved() {
    if (!savedCalib) return;
    const mn = new Map(Object.entries(savedCalib.minTicks).map(([k, v]) => [+k, v as number]));
    const mx = new Map(Object.entries(savedCalib.maxTicks).map(([k, v]) => [+k, v as number]));
    minRef.current = mn;
    maxRef.current = mx;
    setMinPos(mn);
    setMaxPos(mx);
    setPhase('done');
    addLog('✓ Loaded saved calibration.');
  }

  function handleComplete() {
    onComplete({ minTicks: Object.fromEntries(minPos), maxTicks: Object.fromEntries(maxPos) });
  }

  const rangeOK     = (id: number) => ((maxPos.get(id) ?? 0) - (minPos.get(id) ?? 4095)) >= (id === GRIPPER_ID ? GRIPPER_MIN_RANGE : MIN_RANGE);
  const allRangesOK = MOTOR_IDS.every(rangeOK);

  return (
    <div className="max-w-2xl animate-fade-in">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-violet-600 mb-2">Step 2</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Arm Calibration</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          Set the arm&apos;s neutral pose (EEPROM homing → every motor reads ~2047 at neutral),
          then sweep each joint to record its full range.
        </p>
      </div>

      {/* Load saved calibration (single slot) */}
      {savedCalib && phase === 'intro' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-800">Saved calibration found</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {Object.entries(savedCalib.minTicks).map(([id, mn]) =>
                `${MOTOR_LABELS[+id]}: [${mn}–${savedCalib.maxTicks[+id]}]`
              ).join('  ')}
            </div>
          </div>
          <button
            onClick={handleLoadSaved}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors ml-4 shrink-0"
          >
            Load &amp; Skip
          </button>
        </div>
      )}

      {/* Phase: intro */}
      {phase === 'intro' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <h3 className="font-semibold text-gray-800 mb-3">Phase 1 — Set neutral position</h3>

          {/* Mid-position warning */}
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-5">
            <div className="font-semibold text-amber-800 mb-2">⚠ Position the arm at MID-RANGE before continuing</div>
            <ul className="text-sm text-amber-700 space-y-1 list-disc list-inside mb-3">
              <li>All joints must be roughly <strong>halfway between their physical stop limits</strong></li>
              <li>The arm should be in an upright, relaxed, mid-range pose</li>
              <li><strong>Do NOT start near a hard stop</strong> — motors cannot sweep the full range from there</li>
            </ul>
            <label className="flex items-center gap-2 text-sm font-medium text-amber-800 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={midConfirmed}
                onChange={(e) => setMidConfirmed(e.target.checked)}
                className="w-4 h-4 accent-amber-600"
              />
              I have placed the arm at mid-range on all joints
            </label>
          </div>

          <ol className="text-sm text-gray-500 space-y-1.5 list-decimal list-inside mb-5">
            <li>Move the arm to its <strong>neutral pose</strong> — mid-range on all joints, away from hard stops.</li>
            <li>Click <strong>Set Neutral</strong>. EEPROM homing corrections are written so every motor reads ~2047 at this pose.</li>
            <li>Torque will be disabled so you can sweep joints freely in the next step.</li>
          </ol>
          <button
            onClick={handleSetNeutral}
            disabled={busy || !sdkConnected || !midConfirmed}
            className="px-5 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {busy ? 'Setting…' : 'Set Neutral Position'}
          </button>
          {!sdkConnected && (
            <p className="text-xs text-red-500 mt-2">Connect the controller in Step 1 first.</p>
          )}
          {sdkConnected && !midConfirmed && (
            <p className="text-xs text-amber-600 mt-2">Check the box above to confirm arm position before proceeding.</p>
          )}
        </div>
      )}

      {/* Phase: limits */}
      {phase === 'limits' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="font-semibold text-gray-800 text-sm">Phase 2 — Sweep joint limits</span>
            {monitoring ? (
              <button onClick={stopMonitoring} className="text-xs text-red-500 hover:text-red-700 font-medium">Pause</button>
            ) : (
              <button onClick={startMonitoring} className="text-xs text-violet-600 hover:text-violet-800 font-medium">Resume</button>
            )}
          </div>
          <div className="px-5 py-3 text-xs text-gray-500 border-b border-gray-100">
            Move <strong>each joint to its maximum extent</strong> in both directions. Green ✓ when range ≥ {MIN_RANGE} ticks.
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-5 py-2">Joint</th>
                <th className="text-right px-3 py-2">Current</th>
                <th className="text-right px-3 py-2">Min</th>
                <th className="text-right px-3 py-2">Max</th>
                <th className="text-right px-3 py-2">Range</th>
                <th className="text-center px-5 py-2">OK</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {MOTOR_IDS.map((id) => {
                const cur   = positions.get(id);
                const mn    = minPos.get(id);
                const mx    = maxPos.get(id);
                const range = (mx !== undefined && mn !== undefined) ? mx - mn : 0;
                const ok    = range >= (id === GRIPPER_ID ? GRIPPER_MIN_RANGE : MIN_RANGE);
                return (
                  <tr key={id} className="hover:bg-gray-50">
                    <td className="px-5 py-2.5 text-gray-700 font-medium">{MOTOR_LABELS[id]}</td>
                    <td className="text-right px-3 py-2.5 font-mono text-gray-500">{cur ?? '—'}</td>
                    <td className="text-right px-3 py-2.5 font-mono text-gray-400">{mn ?? '—'}</td>
                    <td className="text-right px-3 py-2.5 font-mono text-gray-400">{mx ?? '—'}</td>
                    <td className={`text-right px-3 py-2.5 font-mono font-medium ${ok ? 'text-green-600' : 'text-gray-400'}`}>{range || '—'}</td>
                    <td className="text-center px-5 py-2.5">
                      {ok ? <span className="text-green-500 text-base">✓</span> : <span className="text-gray-300 text-base">○</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {allRangesOK ? '✓ All joints have sufficient range.' : `${MOTOR_IDS.filter(rangeOK).length}/6 joints ready.`}
            </span>
            <button
              onClick={handleFinish}
              disabled={!allRangesOK || busy}
              className="px-5 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 transition-colors disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Finish & Save'}
            </button>
          </div>
        </div>
      )}

      {/* Phase: done */}
      {phase === 'done' && (
        <>
          <div className="bg-green-50 border border-green-200 rounded-xl p-5 mb-6 flex items-start gap-3">
            <span className="text-green-500 text-xl">✓</span>
            <div>
              <div className="font-semibold text-green-800 text-sm">Calibration complete</div>
              <div className="text-green-700 text-xs mt-1">
                EEPROM neutral = 2047. Limits saved locally (1 slot).
                Arm joints → [−100, 100], gripper → [0, 100%].
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-800">Calibration summary</div>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-5 py-2">Joint</th>
                  <th className="text-right px-3 py-2">Min tick</th>
                  <th className="text-right px-3 py-2">Max tick</th>
                  <th className="text-right px-3 py-2">Range</th>
                  <th className="text-right px-5 py-2">Center</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {MOTOR_IDS.map((id) => {
                  const mn = minPos.get(id) ?? 0;
                  const mx = maxPos.get(id) ?? 4095;
                  return (
                    <tr key={id}>
                      <td className="px-5 py-2 font-medium text-gray-700">{MOTOR_LABELS[id]}</td>
                      <td className="text-right px-3 py-2 font-mono text-gray-500">{mn}</td>
                      <td className="text-right px-3 py-2 font-mono text-gray-500">{mx}</td>
                      <td className="text-right px-3 py-2 font-mono text-gray-500">{mx - mn}</td>
                      <td className="text-right px-5 py-2 font-mono text-gray-400">{Math.round((mn + mx) / 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button
            onClick={handleComplete}
            className="w-full py-3 rounded-xl bg-violet-600 text-white font-semibold text-sm hover:bg-violet-700 transition-colors"
          >
            Arm calibration complete → Continue to Camera Setup
          </button>
        </>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div className="mt-6 bg-gray-900 text-green-400 rounded-xl p-4 font-mono text-xs space-y-1 max-h-36 overflow-y-auto">
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
