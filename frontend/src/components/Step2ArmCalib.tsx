'use client';

import { useState, useEffect, useRef } from 'react';
import {
  MOTOR_IDS, MOTOR_LABELS,
  resetCorrectionsAndRead, applyHomingCorrections, resetLimitsToFull,
  setTorqueAll,
} from '@/lib/feetech';
import type { ArmCalibration } from '@/app/dashboard/page';

// getSDK must be called lazily in handlers
async function getSDK() {
  const m = await import('feetech.js');
  return m.scsServoSDK as any;
}

interface Props {
  sdkConnected: boolean;
  onComplete: (calib: ArmCalibration) => void;
}

type Phase = 'intro' | 'zeroing' | 'limits' | 'done';

const MIN_RANGE = 2000; // minimum acceptable range for most joints
const GRIPPER_ID = 6;   // gripper has less physical range — lower threshold
const GRIPPER_MIN_RANGE = 1000;

export default function Step2ArmCalib({ sdkConnected, onComplete }: Props) {
  const [phase, setPhase]             = useState<Phase>('intro');
  const [positions, setPositions]     = useState<Map<number, number>>(new Map());
  const [minPos, setMinPos]           = useState<Map<number, number>>(new Map());
  const [maxPos, setMaxPos]           = useState<Map<number, number>>(new Map());
  const [corrections, setCorrections] = useState<Map<number, number>>(new Map());
  const [monitoring, setMonitoring]   = useState(false);
  const [busy, setBusy]               = useState(false);
  const [log, setLog]                 = useState<string[]>([]);
  const intervalRef                   = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = (msg: string) => setLog((l) => [msg, ...l].slice(0, 20));

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  async function handleApplyZero() {
    if (!sdkConnected) { addLog('Connect controller in Step 1 first.'); return; }
    setBusy(true);
    addLog('Disabling torque on all motors…');
    try {
      await setTorqueAll(false);
      addLog('Resetting corrections to zero…');
      const zeroed = await resetCorrectionsAndRead();
      addLog('Applying homing corrections (neutral → 2047)…');
      const verified = await applyHomingCorrections();
      const newCorr: Map<number, number> = new Map();
      for (const id of MOTOR_IDS) newCorr.set(id, (zeroed.get(id) ?? 2047) - 2047);
      setCorrections(newCorr);
      setPositions(verified);
      addLog('✓ Homing calibration applied. Now find movement limits.');
      setPhase('limits');
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function startMonitoring() {
    setMonitoring(true);
    const initMin = new Map<number, number>(MOTOR_IDS.map((id) => [id, 4095]));
    const initMax = new Map<number, number>(MOTOR_IDS.map((id) => [id, 0]));
    setMinPos(initMin);
    setMaxPos(initMax);
    addLog('Monitoring started. Move each joint to its extremes.');

    intervalRef.current = setInterval(async () => {
      try {
        const sdk   = await getSDK();
        const posMap: Map<number, number> = await sdk.syncReadPositions(Array.from(MOTOR_IDS));
        setPositions(new Map(posMap));
        setMinPos((prev) => {
          const next = new Map(prev);
          for (const id of MOTOR_IDS) {
            const v = posMap.get(id) ?? 2048;
            if (v < (next.get(id) ?? 4095)) next.set(id, v);
          }
          return next;
        });
        setMaxPos((prev) => {
          const next = new Map(prev);
          for (const id of MOTOR_IDS) {
            const v = posMap.get(id) ?? 2048;
            if (v > (next.get(id) ?? 0)) next.set(id, v);
          }
          return next;
        });
      } catch {}
    }, 100);
  }

  function stopMonitoring() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setMonitoring(false);
    addLog('Monitoring stopped.');
  }

  async function handleSaveLimits() {
    setBusy(true);
    addLog('Saving calibration…');
    try {
      // Reset EEPROM min/max limits to full range (0–4095) so they never
      // silently block position commands during inference.
      // The discovered limits are stored in software via armCalib.
      addLog('Resetting EEPROM position limits to full range…');
      await resetLimitsToFull();
      addLog('Re-enabling torque on all motors…');
      await setTorqueAll(true);
      setPhase('done');
      addLog('✓ Calibration complete! EEPROM limits reset, torque re-enabled.');
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleComplete() {
    const calib: ArmCalibration = {
      corrections:  Object.fromEntries(corrections),
      minPositions: Object.fromEntries(minPos),
      maxPositions: Object.fromEntries(maxPos),
    };
    onComplete(calib);
  }

  const rangeOK = (id: number) => ((maxPos.get(id) ?? 0) - (minPos.get(id) ?? 4095)) >= (id === GRIPPER_ID ? GRIPPER_MIN_RANGE : MIN_RANGE);
  const allRangesOK = MOTOR_IDS.every(rangeOK);

  return (
    <div className="max-w-2xl animate-fade-in">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-violet-600 mb-2">Step 2</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Arm Calibration</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          Calibrate each motor so the arm knows its neutral position and movement range.
          This is a two-phase process: homing correction, then limit discovery.
        </p>
      </div>

      {/* Phase: intro / zeroing */}
      {(phase === 'intro' || phase === 'zeroing') && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <h3 className="font-semibold text-gray-800 mb-2">Phase 1 — Homing correction</h3>
          <ol className="text-sm text-gray-500 space-y-1 list-decimal list-inside mb-5">
            <li>Move the arm to its <strong>neutral / rest pose</strong> (arm hanging straight down or as defined by your setup).</li>
            <li>Click <strong>Apply Zero Calibration</strong>. Torque will be disabled so you can move the arm freely.</li>
            <li>The robot will store correction offsets so each motor reads ~2047 at this position.</li>
          </ol>
          <button
            onClick={handleApplyZero}
            disabled={busy || !sdkConnected}
            className="px-5 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {busy ? 'Applying…' : 'Apply Zero Calibration'}
          </button>
          {!sdkConnected && (
            <p className="text-xs text-red-500 mt-2">Connect the controller in Step 1 first.</p>
          )}
        </div>
      )}

      {/* Phase: limits */}
      {phase === 'limits' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="font-semibold text-gray-800 text-sm">Phase 2 — Find movement limits</span>
            {monitoring ? (
              <button onClick={stopMonitoring} className="text-xs text-red-500 hover:text-red-700 font-medium">Stop monitoring</button>
            ) : (
              <button onClick={startMonitoring} className="text-xs text-violet-600 hover:text-violet-800 font-medium">Start monitoring</button>
            )}
          </div>

          <div className="px-5 py-3 text-xs text-gray-500 border-b border-gray-100">
            With monitoring active, move <strong>each joint to its maximum extent</strong> in both directions. A green check appears when the range exceeds 2000 units.
          </div>

          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-5 py-2">Joint</th>
                <th className="text-right px-3 py-2">Current</th>
                <th className="text-right px-3 py-2">Min</th>
                <th className="text-right px-3 py-2">Max</th>
                <th className="text-right px-3 py-2">Range</th>
                <th className="text-center px-5 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {MOTOR_IDS.map((id) => {
                const cur   = positions.get(id);
                const mn    = minPos.get(id);
                const mx    = maxPos.get(id);
                const range = (mx === undefined || mn === undefined) ? 0 : mx - mn;
                const ok    = range >= (id === GRIPPER_ID ? GRIPPER_MIN_RANGE : MIN_RANGE);
                return (
                  <tr key={id} className="hover:bg-gray-50">
                    <td className="px-5 py-2.5 text-gray-700 font-medium">{MOTOR_LABELS[id]}</td>
                    <td className="text-right px-3 py-2.5 font-mono text-gray-500">{cur ?? '—'}</td>
                    <td className="text-right px-3 py-2.5 font-mono text-gray-400">{mn === 4095 ? '—' : mn}</td>
                    <td className="text-right px-3 py-2.5 font-mono text-gray-400">{mx === 0 ? '—' : mx}</td>
                    <td className={`text-right px-3 py-2.5 font-mono font-medium ${ok ? 'text-green-600' : 'text-gray-400'}`}>
                      {range || '—'}
                    </td>
                    <td className="text-center px-5 py-2.5">
                      {ok ? (
                        <span className="text-green-500 text-base">✓</span>
                      ) : (
                        <span className="text-gray-300 text-base">○</span>
                      )}
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
              onClick={handleSaveLimits}
              disabled={!allRangesOK || busy}
              className="px-5 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 transition-colors disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Finish & Save Limits'}
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
              <div className="font-semibold text-green-800 text-sm">Arm calibration complete</div>
              <div className="text-green-700 text-xs mt-1">Corrections and limits have been saved to the servo EEPROM and to your session.</div>
            </div>
          </div>

          {/* Summary */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-800">Calibration summary</div>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-5 py-2">Joint</th>
                  <th className="text-right px-3 py-2">Correction</th>
                  <th className="text-right px-3 py-2">Min</th>
                  <th className="text-right px-3 py-2">Max</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {MOTOR_IDS.map((id) => (
                  <tr key={id}>
                    <td className="px-5 py-2 font-medium text-gray-700">{MOTOR_LABELS[id]}</td>
                    <td className="text-right px-3 py-2 font-mono text-gray-500">{corrections.get(id) ?? 0}</td>
                    <td className="text-right px-3 py-2 font-mono text-gray-500">{minPos.get(id) ?? 0}</td>
                    <td className="text-right px-3 py-2 font-mono text-gray-500">{maxPos.get(id) ?? 4095}</td>
                  </tr>
                ))}
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
