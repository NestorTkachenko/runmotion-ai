'use client';

import { useState, useEffect, useRef } from 'react';
import {
  MOTOR_IDS, MOTOR_LABELS,
  resetLimitsToFull,
  setTorqueAll,
} from '@/lib/feetech';
import type { ArmCalibration } from '@/app/dashboard/page';
import { apiGet, apiPost, apiDelete } from '@/lib/socket';

// getSDK must be called lazily in handlers
async function getSDK() {
  const m = await import('feetech.js');
  return m.scsServoSDK as any;
}

interface Props {
  sdkConnected: boolean;
  onComplete: (calib: ArmCalibration) => void;
}

type Phase = 'intro' | 'homing' | 'limits' | 'done';

const MIN_RANGE = 2000; // minimum acceptable range for most joints
const GRIPPER_ID = 6;   // gripper has less physical range — lower threshold
const GRIPPER_MIN_RANGE = 1000;

export default function Step2ArmCalib({ sdkConnected, onComplete }: Props) {
  const [phase, setPhase]             = useState<Phase>('intro');
  const [positions, setPositions]     = useState<Map<number, number>>(new Map());
  const [minPos, setMinPos]           = useState<Map<number, number>>(new Map());
  const [maxPos, setMaxPos]           = useState<Map<number, number>>(new Map());
  const [offsetTicks, setOffsetTicks] = useState<Map<number, number>>(new Map());
  const [monitoring, setMonitoring]   = useState(false);
  const [busy, setBusy]               = useState(false);
  const [log, setLog]                 = useState<string[]>([]);
  const intervalRef                   = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cloud calibration state
  const [token, setToken]             = useState('');
  const [savedCalibrations, setSavedCalibrations] = useState<Array<{ id: number; name: string; created_at: number }>>([]);
  const [saveName, setSaveName]       = useState('');
  const [saveLoading, setSaveLoading] = useState(false);

  const addLog = (msg: string) => setLog((l) => [msg, ...l].slice(0, 20));

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  useEffect(() => {
    const t = localStorage.getItem('arm101_token') || '';
    setToken(t);
    if (!t) return;
    apiGet<Array<{ id: number; name: string; created_at: number }>>('/calibrations', t)
      .then(setSavedCalibrations)
      .catch(() => {});
  }, []);

  async function handleCaptureOffset() {
    if (!sdkConnected) { addLog('Connect controller in Step 1 first.'); return; }
    setBusy(true);
    addLog('Disabling torque so arm can be moved freely…');
    try {
      await setTorqueAll(false);
      // Read current tick values — no EEPROM writes at all.
      // These ticks become the origin (0 degrees) for degree conversions.
      const sdk    = await getSDK();
      const posMap: Map<number, number> = await sdk.syncReadPositions(Array.from(MOTOR_IDS));
      const newOffsets = new Map<number, number>();
      for (const id of MOTOR_IDS) newOffsets.set(id, posMap.get(id) ?? 2048);
      setOffsetTicks(newOffsets);
      setPositions(new Map(posMap));
      addLog(`✓ Reference captured: [${MOTOR_IDS.map((id) => posMap.get(id) ?? 2048).join(', ')}]`);
      addLog('Now move each joint to its full range extremes.');
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
      offsetTicks: Object.fromEntries(offsetTicks),
      minTicks:    Object.fromEntries(minPos),
      maxTicks:    Object.fromEntries(maxPos),
    };
    onComplete(calib);
  }

  async function handleSaveCalibration() {
    if (!saveName.trim() || !token) return;
    setSaveLoading(true);
    const calibData: ArmCalibration = {
      offsetTicks: Object.fromEntries(offsetTicks),
      minTicks:    Object.fromEntries(minPos),
      maxTicks:    Object.fromEntries(maxPos),
    };
    try {
      const result = await apiPost<{ id: number; name: string; created_at: number }>(
        '/calibrations',
        { name: saveName.trim(), data: calibData },
      );
      setSavedCalibrations((prev) => [result, ...prev]);
      setSaveName('');
      addLog('✓ Calibration saved to cloud.');
    } catch (e: any) {
      addLog(`Save failed: ${e.message}`);
    } finally {
      setSaveLoading(false);
    }
  }

  async function handleLoadCalibration(id: number, name: string) {
    if (!token) return;
    try {
      const result = await apiGet<{ id: number; name: string; data: ArmCalibration }>(
        `/calibrations/${id}`, token,
      );
      const c = result.data;
      if (!c.offsetTicks) {
        addLog(`⚠ "${name}" was saved with the old format — please redo calibration.`);
        return;
      }
      setOffsetTicks(new Map(Object.entries(c.offsetTicks).map(([k, v]) => [+k, v as number])));
      setMinPos(new Map(Object.entries(c.minTicks).map(([k, v]) => [+k, v as number])));
      setMaxPos(new Map(Object.entries(c.maxTicks).map(([k, v]) => [+k, v as number])));
      setPhase('done');
      addLog(`✓ Loaded calibration "${name}".`);
    } catch (e: any) {
      addLog(`Load failed: ${e.message}`);
    }
  }

  async function handleDeleteCalibration(id: number) {
    if (!token) return;
    try {
      await apiDelete(`/calibrations/${id}`, token);
      setSavedCalibrations((prev) => prev.filter((c) => c.id !== id));
      addLog('Calibration deleted.');
    } catch (e: any) {
      addLog(`Delete failed: ${e.message}`);
    }
  }

  const rangeOK = (id: number) => ((maxPos.get(id) ?? 0) - (minPos.get(id) ?? 4095)) >= (id === GRIPPER_ID ? GRIPPER_MIN_RANGE : MIN_RANGE);
  const allRangesOK = MOTOR_IDS.every(rangeOK);

  return (
    <div className="max-w-2xl animate-fade-in">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-violet-600 mb-2">Step 2</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Arm Calibration</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          Calibrate each motor so the arm knows its reference position and movement range.
          This is a two-phase process: capture a reference pose, then discover limits.
        </p>
      </div>

      {/* Saved calibrations — load a previous one to skip re-calibrating */}
      {savedCalibrations.length > 0 && (phase === 'intro' || phase === 'homing') && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-6">
          <h3 className="font-semibold text-gray-800 text-sm mb-3">Load saved calibration</h3>
          <div className="space-y-2">
            {savedCalibrations.map((c) => (
              <div key={c.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium text-gray-800">{c.name}</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {new Date(c.created_at * 1000).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => handleLoadCalibration(c.id, c.name)}
                    className="text-xs text-violet-600 hover:text-violet-800 font-medium"
                  >
                    Load
                  </button>
                  <button
                    onClick={() => handleDeleteCalibration(c.id)}
                    className="text-xs text-red-400 hover:text-red-600 font-medium"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase: intro / homing */}
      {(phase === 'intro' || phase === 'homing') && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <h3 className="font-semibold text-gray-800 mb-2">Phase 1 — Capture reference position</h3>
          <ol className="text-sm text-gray-500 space-y-1 list-decimal list-inside mb-5">
            <li>Move the arm to its <strong>neutral / reference pose</strong> (the pose the model considers "zero degrees" for all joints).</li>
            <li>Click <strong>Capture Reference Position</strong>. Torque will be disabled so you can move the arm freely.</li>
            <li>Current servo ticks are recorded as the origin — no EEPROM writes at all.</li>
          </ol>
          <button
            onClick={handleCaptureOffset}
            disabled={busy || !sdkConnected}
            className="px-5 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {busy ? 'Capturing…' : 'Capture Reference Position'}
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
              <div className="text-green-700 text-xs mt-1">Reference ticks and range limits captured. No EEPROM writes — all transforms are in software.</div>
            </div>
          </div>

          {/* Summary */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-800">Calibration summary</div>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-5 py-2">Joint</th>
                  <th className="text-right px-3 py-2">Offset Tick</th>
                  <th className="text-right px-3 py-2">Min</th>
                  <th className="text-right px-3 py-2">Max</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {MOTOR_IDS.map((id) => (
                  <tr key={id}>
                    <td className="px-5 py-2 font-medium text-gray-700">{MOTOR_LABELS[id]}</td>
                    <td className="text-right px-3 py-2 font-mono text-gray-500">{offsetTicks.get(id) ?? '—'}</td>
                    <td className="text-right px-3 py-2 font-mono text-gray-500">{minPos.get(id) ?? 0}</td>
                    <td className="text-right px-3 py-2 font-mono text-gray-500">{maxPos.get(id) ?? 4095}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Save to cloud */}
          {token && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-3">Save calibration to cloud</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveCalibration()}
                  placeholder="e.g. Living room setup"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-violet-400 focus:outline-none"
                />
                <button
                  onClick={handleSaveCalibration}
                  disabled={!saveName.trim() || saveLoading}
                  className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
                >
                  {saveLoading ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}

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
