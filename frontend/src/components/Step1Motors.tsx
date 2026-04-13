'use client';

import { useState, useCallback } from 'react';
import { sdkConnect, scanServos, setServoId as setId, MOTOR_IDS, MOTOR_LABELS } from '@/lib/feetech';

interface Props {
  sdkConnected: boolean;
  onComplete: () => void;
}

const TARGET_IDS = [1, 2, 3, 4, 5, 6] as const;

type MotorStatus = 'pending' | 'found' | 'set';

interface MotorEntry {
  targetId:    number;
  label:       string;
  status:      MotorStatus;
  foundAt?:    number;   // temp ID it was discovered at
}

export default function Step1Motors({ sdkConnected, onComplete }: Props) {
  const [connected, setConnected]     = useState(sdkConnected);
  const [connecting, setConnecting]   = useState(false);
  const [motors, setMotors]           = useState<MotorEntry[]>(
    TARGET_IDS.map((id) => ({ targetId: id, label: MOTOR_LABELS[id], status: 'pending' })),
  );
  const [scanning, setScanning]       = useState(false);
  const [scanResult, setScanResult]   = useState<number[]>([]);
  const [assigningId, setAssigningId] = useState<number | null>(null); // targetId being assigned
  const [tempId, setTempId]           = useState<number | null>(null); // found ID to reassign
  const [log, setLog]                 = useState<string[]>([]);
  const [verifying, setVerifying]     = useState(false);
  const [allVerified, setAllVerified] = useState(false);

  const addLog = (msg: string) => setLog((l) => [msg, ...l].slice(0, 20));

  async function handleConnect() {
    setConnecting(true);
    try {
      await sdkConnect();
      setConnected(true);
      addLog('Controller connected via Web Serial.');
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setConnecting(false);
    }
  }

  async function handleScan() {
    setScanning(true);
    setScanResult([]);
    addLog('Scanning IDs 0–20...');
    try {
      const found = await scanServos(0, 20);
      setScanResult(found);
      addLog(`Found motors at IDs: ${found.length ? found.join(', ') : 'none'}`);
    } catch (e: any) {
      addLog(`Scan error: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleSetId(targetId: number, fromId: number) {
    setAssigningId(targetId);
    addLog(`Setting motor ${fromId} → ID ${targetId} (${MOTOR_LABELS[targetId]})…`);
    try {
      await setId(fromId, targetId);
      setMotors((prev) =>
        prev.map((m) =>
          m.targetId === targetId ? { ...m, status: 'set', foundAt: fromId } : m,
        ),
      );
      addLog(`✓ Motor set to ID ${targetId} (${MOTOR_LABELS[targetId]})`);
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setAssigningId(null);
    }
  }

  async function handleVerifyAll() {
    setVerifying(true);
    addLog('Verifying all 6 motors are connected...');
    try {
      const found = await scanServos(1, 6);
      if (found.length === 6) {
        setAllVerified(true);
        addLog('✓ All 6 motors verified! You can proceed.');
        setMotors((prev) => prev.map((m) => ({ ...m, status: 'set' })));
      } else {
        const missing = TARGET_IDS.filter((id) => !found.includes(id));
        addLog(`⚠ Missing IDs: ${missing.join(', ')}. Check connections and try again.`);
      }
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setVerifying(false);
    }
  }

  const allSet     = motors.every((m) => m.status === 'set');
  const setCount   = motors.filter((m) => m.status === 'set').length;

  return (
    <div className="max-w-2xl animate-fade-in">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-violet-600 mb-2">Step 1</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Motor Setup</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          Assign IDs 1–6 to each servo motor. Plug in <strong>one motor at a time</strong> while all others are disconnected.
          The motor will be scanned, assigned its target ID, then you can attach the next motor.
        </p>
      </div>

      {/* Connect */}
      {!connected && (
        <div className="card mb-6 p-6 bg-white border border-gray-200 rounded-xl shadow-sm">
          <h2 className="font-semibold text-gray-800 mb-1">Connect controller</h2>
          <p className="text-xs text-gray-500 mb-4">Click below and select the USB serial port for your Feetech controller.</p>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-5 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {connecting ? 'Opening port…' : 'Connect Controller'}
          </button>
        </div>
      )}

      {connected && (
        <>
          {/* Motor status table */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="font-semibold text-gray-800 text-sm">Motor Status</span>
              <span className="text-xs text-gray-500">{setCount}/6 configured</span>
            </div>
            <div className="divide-y divide-gray-100">
              {motors.map((m) => (
                <div key={m.targetId} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      m.status === 'set' ? 'bg-green-500' : 'bg-gray-300'
                    }`} />
                    <span className="text-sm text-gray-700 font-medium">ID {m.targetId}</span>
                    <span className="text-xs text-gray-400">{m.label}</span>
                  </div>
                  {m.status === 'set' ? (
                    <span className="text-xs text-green-600 font-medium">✓ Set</span>
                  ) : (
                    <span className="text-xs text-gray-400">Pending</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Scan + assign */}
          {!allSet && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 p-5">
              <h3 className="font-semibold text-gray-800 text-sm mb-1">Assign next motor</h3>
              <p className="text-xs text-gray-500 mb-4">
                Plug in <strong>one motor</strong> only, then scan to find its current ID.
                Select which joint it is and click Set ID.
              </p>
              <div className="flex gap-3 mb-4">
                <button
                  onClick={handleScan}
                  disabled={scanning}
                  className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200 transition-colors disabled:opacity-50"
                >
                  {scanning ? 'Scanning…' : 'Scan for Motor'}
                </button>
              </div>

              {scanResult.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 mb-2">
                    Found motor at ID(s): <strong>{scanResult.join(', ')}</strong>.
                    Select the joint and assign it.
                  </p>
                  {scanResult.map((foundId) => (
                    <div key={foundId} className="flex flex-wrap gap-2">
                      {motors
                        .filter((m) => m.status !== 'set')
                        .map((m) => (
                          <button
                            key={m.targetId}
                            disabled={assigningId !== null}
                            onClick={() => handleSetId(m.targetId, foundId)}
                            className="px-3 py-1.5 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 text-xs hover:bg-violet-100 transition-colors disabled:opacity-50"
                          >
                            {assigningId === m.targetId ? 'Setting…' : `→ ID ${m.targetId}: ${m.label}`}
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Verify all */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-6 p-5">
            <h3 className="font-semibold text-gray-800 text-sm mb-1">Verify all 6 motors</h3>
            <p className="text-xs text-gray-500 mb-4">
              Connect all 6 motors to the controller, then click Verify to confirm IDs 1–6 all respond.
            </p>
            <button
              onClick={handleVerifyAll}
              disabled={verifying}
              className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 transition-colors disabled:opacity-50"
            >
              {verifying ? 'Verifying…' : 'Verify All Motors'}
            </button>
          </div>

          {allVerified && (
            <button
              onClick={onComplete}
              className="w-full py-3 rounded-xl bg-violet-600 text-white font-semibold text-sm hover:bg-violet-700 transition-colors"
            >
              Motor setup complete → Continue to Arm Calibration
            </button>
          )}
        </>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div className="mt-6 bg-gray-900 text-green-400 rounded-xl p-4 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
