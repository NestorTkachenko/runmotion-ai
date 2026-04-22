'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import type { CameraConfig } from '@/app/dashboard/page';
import { MOTOR_IDS, MOTOR_LABELS, writeAllPositions, readAllPositions, setTorqueAll, probeConnection, resetLimitsToFull } from '@/lib/feetech';
import type { ArmCalibration } from '@/app/dashboard/page';

const CONTROL_HZ  = 30;
const SEND_WIDTH  = 320;
const SEND_HEIGHT = 180;

// ── Unit conversion ───────────────────────────────────────────────────────────
// EEPROM homing (applyHomingCorrections in Step 2) ensures every motor reads
// ~2047 at neutral, so raw ticks are always positive and well within [0, 4095].
// Normalization matches LeRobot RANGE_M100_100 / RANGE_0_100:
//   Joints 1–5:  [-100, 100]  (0 = neutral/midpoint of calibrated range)
//   Gripper (6): [  0, 100]   (0 = min, 100 = max)

const GRIPPER_IDX = 5;  // index into MOTOR_IDS (motor ID 6)

type Calib = { offsetTicks?: Record<number, number>; minTicks: Record<number, number>; maxTicks: Record<number, number> } | null;

// ticks → model units
function ticksToModelUnits(ticks: number, motorIndex: number, calib: Calib): number {
  const id  = motorIndex + 1;
  const min = calib?.minTicks[id] ?? 0;
  const max = calib?.maxTicks[id] ?? 4095;
  const t   = Math.max(min, Math.min(max, ticks));
  if (motorIndex === GRIPPER_IDX)
    return ((t - min) / (max - min || 1)) * 100;
  return ((t - min) / (max - min || 1)) * 200 - 100;
}

// model units → servo ticks
function modelUnitsToTicks(val: number, motorIndex: number, calib: Calib): number {
  const id     = motorIndex + 1;
  const calMin = calib?.minTicks[id] ?? 0;
  const calMax = calib?.maxTicks[id] ?? 4095;
  const t = motorIndex === GRIPPER_IDX
    ? (val / 100) * (calMax - calMin) + calMin
    : ((val + 100) / 200) * (calMax - calMin) + calMin;
  return Math.round(Math.max(calMin, Math.min(calMax, t)));
}

type InferenceStatus =
  | 'idle'
  | 'connecting'
  | 'loading_policy'
  | 'ready'
  | 'running'
  | 'task_updated'
  | 'stopping'
  | 'at_capacity'
  | 'no_container'
  | 'error';

const STATUS_LABEL: Record<InferenceStatus, string> = {
  idle:          'Idle',
  connecting:    'Starting inference server…',
  loading_policy:'Loading AI policy onto GPU…',
  ready:         'Ready',
  running:       'Running inference',
  task_updated:  'Task updated',
  stopping:      'Stopping…',
  at_capacity:   'Server at capacity',
  no_container:  'No inference server available',
  error:         'Error',
};

const ETA_HINTS: Partial<Record<InferenceStatus, string>> = {
  connecting:    'First-time start: 1–2 minutes. Subsequent starts are faster.',
  loading_policy:'Loading model weights onto GPU… (~30 sec)',
};

interface Props {
  socket:          Socket | null;
  sdkConnected:    boolean;
  cameraConfig:    CameraConfig | null;
  armCalib:        ArmCalibration | null;
  credits:         number;        // in cents
  onCreditsChange: (c: number) => void;
  onDisconnect?:   () => void;
}

function rotCanvasCtx(
  ctx: CanvasRenderingContext2D,
  rot: 0 | 90 | 180 | 270,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
}

export default function Step4Inference({ socket, sdkConnected, cameraConfig, armCalib, credits, onCreditsChange, onDisconnect }: Props) {
  const [status,     setStatus]     = useState<InferenceStatus>('idle');
  const [statusMsg,  setStatusMsg]  = useState('');
  const [task,       setTask]       = useState('Pick up the black block and put it in the white cup');
  const [running,    setRunning]    = useState(false);
  const [showBestPractices, setShowBestPractices] = useState(false);

  // Camera streams
  const topVideoRef   = useRef<HTMLVideoElement>(null);
  const wristVideoRef = useRef<HTMLVideoElement>(null);
  const topStreamRef  = useRef<MediaStream | null>(null);
  const wristStreamRef= useRef<MediaStream | null>(null);
  // Off-screen capture canvases
  const topCapRef     = useRef<HTMLCanvasElement | null>(null);
  const wristCapRef   = useRef<HTMLCanvasElement | null>(null);

  // Inference control
  const runningRef        = useRef(false);
  const chunkBufferRef    = useRef<number[][]>([]);
  const chunkIndexRef     = useRef(0);
  const waitingChunkRef   = useRef(false);
  const controlTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskRef           = useRef(task);

  // ── Live connection probe ─────────────────────────────────────────────────
  // Web Serial has no disconnect event; we poll readPosition(1) every 2.5 s
  // when the inference loop isn't running so we don't pollute the bus.
  const [liveConnected, setLiveConnected] = useState<boolean>(sdkConnected);
  const probeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setLiveConnected(sdkConnected);
    if (probeIntervalRef.current) clearInterval(probeIntervalRef.current);
    if (!sdkConnected) return;

    async function probe() {
      if (runningRef.current) return; // skip during inference
      const ok = await probeConnection();
      setLiveConnected((prev) => {
        if (prev && !ok) {
          setStatusMsg('Robot disconnected. Check USB cable and reconnect in Step 1.');
          onDisconnect?.();
        }
        return ok;
      });
    }

    probe(); // immediate first probe
    probeIntervalRef.current = setInterval(probe, 2500);
    return () => {
      if (probeIntervalRef.current) clearInterval(probeIntervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkConnected]);

  // ── Init cameras from Step3 config ────────────────────────────────────────

  useEffect(() => {
    if (!cameraConfig) return;

    // Create off-screen capture canvases
    topCapRef.current   = document.createElement('canvas');
    wristCapRef.current = document.createElement('canvas');
    topCapRef.current.width   = SEND_WIDTH;
    topCapRef.current.height  = SEND_HEIGHT;
    wristCapRef.current.width  = SEND_WIDTH;
    wristCapRef.current.height = SEND_HEIGHT;

    async function startStreams() {
      const startStream = async (
        deviceId: string,
        videoEl: HTMLVideoElement | null,
        streamRef: React.MutableRefObject<MediaStream | null>,
      ) => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId }, width: 1280, height: 720 },
        });
        streamRef.current = stream;
        if (videoEl) { videoEl.srcObject = stream; }
      };

      try {
        await startStream(cameraConfig!.topDeviceId,   topVideoRef.current,   topStreamRef);
        await startStream(cameraConfig!.wristDeviceId, wristVideoRef.current, wristStreamRef);
      } catch (e: any) {
        setStatusMsg(`Camera error: ${e.message}`);
      }
    }
    startStreams();

    return () => {
      topStreamRef.current?.getTracks().forEach((t) => t.stop());
      wristStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [cameraConfig]);

  // ── Socket listeners ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    const onStatus = ({ status: s, message }: { status: string; message?: string }) => {
      setStatus(s as InferenceStatus);
      if (message) { setStatusMsg(message); }
      if (s === 'ready') {
        setRunning(true);
        runningRef.current = true;
        scheduleControlStep();
      }
    };

    const onChunk = ({ actions }: { actions: number[][] }) => {
      chunkBufferRef.current  = actions;
      chunkIndexRef.current   = 0;
      waitingChunkRef.current = false;
    };

    const onError = ({ message }: { message: string }) => {
      setStatus('error');
      setStatusMsg(message);
      stopLoop();
    };

    const onStopped = () => {
      setStatus('idle');
      setRunning(false);
      runningRef.current = false;
    };

    socket.on('inference_status', onStatus);
    socket.on('action_chunk',     onChunk);
    socket.on('inference_error',  onError);
    socket.on('inference_stopped', onStopped);

    return () => {
      socket.off('inference_status', onStatus);
      socket.off('action_chunk',     onChunk);
      socket.off('inference_error',  onError);
      socket.off('inference_stopped', onStopped);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  // ── Capture helpers ────────────────────────────────────────────────────────

  function captureFrame(
    videoEl: HTMLVideoElement | null,
    canvas: HTMLCanvasElement | null,
    rotation: 0 | 90 | 180 | 270,
  ): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      if (!videoEl || !canvas || videoEl.readyState < 2) return resolve(null);
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.clearRect(0, 0, SEND_WIDTH, SEND_HEIGHT);
      rotCanvasCtx(ctx, rotation, SEND_WIDTH, SEND_HEIGHT);
      ctx.drawImage(videoEl, 0, 0, SEND_WIDTH, SEND_HEIGHT);
      ctx.restore();
      canvas.toBlob(
        (blob) => { if (!blob) return resolve(null); blob.arrayBuffer().then(resolve); },
        'image/jpeg',
        0.8,
      );
    });
  }

  async function sendObservation() {
    if (!socket || !runningRef.current) return;

    try {
      const topBuf   = await captureFrame(topVideoRef.current,   topCapRef.current,   (cameraConfig?.topRotation   ?? 0) as 0 | 90 | 180 | 270);
      const wristBuf = await captureFrame(wristVideoRef.current, wristCapRef.current, (cameraConfig?.wristRotation ?? 0) as 0 | 90 | 180 | 270);
      if (!topBuf || !wristBuf) return;

      // Read servo positions (ticks) and convert to degrees for the model
      let state: number[] = new Array(6).fill(0);
      try {
        const ticks = await readAllPositions();
        state = ticks.map((t, i) => ticksToModelUnits(t, i, armCalib));
      } catch {}

      socket.emit('obs_frame', {
        ts:    Date.now() / 1000,
        state,
        task:  taskRef.current,
        top:   new Uint8Array(topBuf),
        wrist: new Uint8Array(wristBuf),
      });
    } catch (e: any) {
      setStatusMsg(`Observation send error: ${e.message}`);
    }
  }

  // ── Control loop ──────────────────────────────────────────────────────────
  // Pattern (mirrors client.py sequential mode):
  //   sendObs → wait for chunk → execute all 50 steps at 30 Hz → sendObs → …
  // The robot pauses during inference (~250 ms). No overlapping requests.

  const scheduleControlStep = useCallback(() => {
    const dt = 1000 / CONTROL_HZ;

    async function step() {
      if (!runningRef.current) return;

      const t0 = performance.now();

      if (waitingChunkRef.current) {
        // Still waiting for the server — just tick and check again
        const elapsed = performance.now() - t0;
        controlTimerRef.current = setTimeout(step, Math.max(0, dt - elapsed));
        return;
      }

      const buf = chunkBufferRef.current;
      const idx = chunkIndexRef.current;

      if (idx < buf.length) {
        // Execute next action: convert degrees → ticks and write to servos
        const action = buf[idx];
        chunkIndexRef.current = idx + 1;

        if (sdkConnected) {
          try {
            const ticks = action.slice(0, 6).map((d, i) => {
              const id     = i + 1;
              const calMin = armCalib?.minTicks[id] ?? 0;
              const calMax = armCalib?.maxTicks[id] ?? 4095;
              const t = i === GRIPPER_IDX
                ? (d / 100) * (calMax - calMin) + calMin
                : ((d + 100) / 200) * (calMax - calMin) + calMin;
              const servo = Math.round(Math.max(calMin, Math.min(calMax, t)));
              return servo;
            });
            await writeAllPositions(ticks);
          } catch (e: any) {
            stopOnError(`Robot disconnected: ${e.message}`);
            return;
          }
        }
      }

      // All steps in this chunk done — send next observation
      if (chunkIndexRef.current >= buf.length && buf.length > 0) {
        waitingChunkRef.current = true;
        chunkBufferRef.current  = [];
        chunkIndexRef.current   = 0;
        sendObservation();
      }

      const elapsed = performance.now() - t0;
      controlTimerRef.current = setTimeout(step, Math.max(0, dt - elapsed));
    }

    // Send first observation immediately; loop starts ticking in parallel waiting for the chunk
    waitingChunkRef.current = true;
    sendObservation();
    controlTimerRef.current = setTimeout(step, dt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkConnected, cameraConfig]);

  function stopLoop() {
    runningRef.current = false;
    if (controlTimerRef.current) { clearTimeout(controlTimerRef.current); controlTimerRef.current = null; }
    chunkBufferRef.current  = [];
    chunkIndexRef.current   = 0;
    waitingChunkRef.current = false;
  }

  function stopOnError(msg: string) {
    stopLoop();
    setRunning(false);
    setStatus('error');
    setStatusMsg(msg);
    socket?.emit('stop_inference');
  }

  // ── User actions ──────────────────────────────────────────────────────────

  // Test gripper: open → wait 1s → close → wait 1s → open (neutral)
  const [testBusy, setTestBusy] = useState(false);
  const [testLog,  setTestLog]  = useState('');

  async function handleTestGripper() {
    setTestBusy(true);
    setTestLog('');
    try {
      await resetLimitsToFull();

      await setTorqueAll(true);

      let currentTicks: number[] = new Array(6).fill(2048);
      try {
        currentTicks = await readAllPositions();
      } catch (e: any) {
        setTestLog(`Warning: ${e.message}`);
      }

      // 4. Move gripper to calibrated close/open limits.
      //    Use armCalib min/max if available, otherwise ±500 from neutral mid.
      const GRIPPER_ID      = 6;
      const calibMin        = armCalib?.minTicks[GRIPPER_ID];
      const calibMax        = armCalib?.maxTicks[GRIPPER_ID];
      const gripperCurrent  = currentTicks[5];
      const closeTarget     = calibMin  ?? Math.max(  0, gripperCurrent - 500);
      const openTarget      = calibMax  ?? Math.min(4095, gripperCurrent + 500);
      const neutralTarget   = calibMin != null && calibMax != null
        ? Math.round((calibMin + calibMax) / 2)
        : gripperCurrent;

      const write = async (gripperTicks: number, label: string) => {
        const positions = [...currentTicks];
        positions[5] = gripperTicks;
        await writeAllPositions(positions);
        setTestLog(label);
      };

      await write(closeTarget,  'Closing gripper…');
      await new Promise((r) => setTimeout(r, 1200));
      await write(openTarget,   'Opening gripper…');
      await new Promise((r) => setTimeout(r, 1200));
      await write(neutralTarget, 'Returning to neutral');
      setTestLog('✓ Done — gripper test complete.');
    } catch (e: any) {
      setTestLog(`Error: ${e.message}`);
    } finally {
      setTestBusy(false);
    }
  }

  async function handleStart() {
    if (!socket) { setStatusMsg('No socket connection.'); return; }
    if (!cameraConfig) { setStatusMsg('Complete camera setup (Step 3) first.'); return; }
    if (credits < 1) { setStatusMsg('Insufficient credits.'); return; }
    if (!liveConnected) { setStatusMsg('Robot not connected. Check USB cable and reconnect in Step 1.'); return; }
    if (!armCalib)       { setStatusMsg('Arm not calibrated. Complete Step 2 first.'); return; }

    try { await resetLimitsToFull(); } catch {}
    try {
      await setTorqueAll(true);
    } catch (e: any) {
      setStatusMsg(`Setup warning: ${e.message}`);
    }

    setStatus('connecting');
    setStatusMsg('Starting inference server...');
    chunkBufferRef.current  = [];
    chunkIndexRef.current   = 0;
    waitingChunkRef.current = false;
    taskRef.current         = task;

    socket.emit('start_inference', {
      task,
      actionsPerChunk:   50,
      inferenceEveryN:   20,
      numInferenceSteps: 5,
    });
  }

  function handleStop() {
    if (!socket) return;
    setStatus('stopping');
    stopLoop();
    socket.emit('stop_inference');
  }

  // If user navigates away from Step 4, always stop inference server-side.
  useEffect(() => {
    return () => {
      stopLoop();
      socket?.emit('stop_inference');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  function handleUpdateTask() {
    if (!socket) return;
    taskRef.current = task;
    socket.emit('update_task', { task });
    setStatus('task_updated');
    setStatusMsg(`Current task running: ${task}`);
  }

  const statusColor: Record<InferenceStatus, string> = {
    idle:          'text-gray-500',
    connecting:    'text-yellow-600',
    loading_policy:'text-yellow-600',
    ready:         'text-green-600',
    running:       'text-green-600',
    task_updated:  'text-blue-600',
    stopping:      'text-yellow-600',
    at_capacity:   'text-red-500',
    no_container:  'text-red-500',
    error:         'text-red-500',
  };
  const dotColor: Record<InferenceStatus, string> = {
    idle:          'bg-gray-300',
    connecting:    'bg-yellow-400 animate-pulse',
    loading_policy:'bg-yellow-400 animate-pulse',
    ready:         'bg-green-400',
    running:       'bg-green-500 animate-pulse',
    task_updated:  'bg-blue-400',
    stopping:      'bg-yellow-400 animate-pulse',
    at_capacity:   'bg-red-400',
    no_container:  'bg-red-400',
    error:         'bg-red-500',
  };

  return (
    <div className="max-w-3xl animate-fade-in">
      <div className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-widest text-violet-600 mb-2">Step 4</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Run AI Policy</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          Describe what you want in plain English, then let the AI control the arm.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Current policy: <span className="font-medium">Pi0.5_so101_finetuned</span> (more fine-tuned policies coming soon).
        </p>
      </div>

      {/* Status bar */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${dotColor[status]}`} />
          <div>
            <div className={`text-sm font-medium ${statusColor[status]}`}>{STATUS_LABEL[status]}</div>
            {ETA_HINTS[status] && <div className="text-xs text-gray-400">{ETA_HINTS[status]}</div>}
            {statusMsg && status !== 'running' && status !== 'idle' && (
              <div className="text-xs text-gray-400 truncate max-w-xs">{statusMsg}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-400">Robot</span>
          <span className={`w-2 h-2 rounded-full ${liveConnected ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-gray-400 ml-3">Cameras</span>
          <span className={`w-2 h-2 rounded-full ${cameraConfig ? 'bg-green-400' : 'bg-red-400'}`} />
        </div>
      </div>

      {/* First-time server start banner */}
      {(status === 'connecting' || status === 'loading_policy') && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
          <div className="flex items-start gap-3">
            <span className="text-blue-500 text-lg mt-0.5">⏳</span>
            <div>
              <div className="font-semibold text-blue-800 text-sm mb-1">Starting inference server — please wait 1–2 minutes</div>
              <div className="text-xs text-blue-600 leading-relaxed">
                The GPU container is spinning up. This only happens the first time (or after inactivity).
                Once warm, subsequent starts take just a few seconds. <strong>Don&apos;t close this tab.</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Calibration status */}
      {!armCalib ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-center gap-2 text-sm text-amber-800">
          <span>⚠</span>
          <span><strong>No calibration loaded.</strong> Complete Step 2 (Arm Calibration) before running inference — motor targets will be wrong without it.</span>
        </div>
      ) : (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 mb-4 flex items-center gap-2 text-sm text-green-800">
          <span>✓</span>
          <span>Calibration loaded — {Object.keys(armCalib.minTicks).length} joints, limits saved.</span>
        </div>
      )}

      {/* Motor test panel */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">Motor test</span>
          <span className="text-xs text-gray-400">Quickly verify the gripper responds</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleTestGripper}
            disabled={testBusy}
            className="px-4 py-2 rounded-lg bg-gray-800 text-white text-xs font-medium hover:bg-gray-900 transition-colors disabled:opacity-50"
          >
            {testBusy ? 'Testing…' : 'Test gripper open/close'}
          </button>
          {testLog && (
            <span className={`text-xs ${testLog.startsWith('Error') ? 'text-red-500' : testLog.startsWith('✓') ? 'text-green-600' : 'text-gray-500'}`}>
              {testLog}
            </span>
          )}
        </div>
      </div>

      {/* Camera previews */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        {(['top', 'wrist'] as const).map((which) => (
          <div key={which} className="bg-black rounded-xl overflow-hidden relative">
            <div className="absolute top-2 left-2 z-10 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full capitalize">
              {which} cam
            </div>
            <video
              ref={which === 'top' ? topVideoRef : wristVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full aspect-video object-cover"
              style={{
                transform: `rotate(${(which === 'top' ? cameraConfig?.topRotation : cameraConfig?.wristRotation) ?? 0}deg)`,
              }}
            />
            {!cameraConfig && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-xs">
                Configure cameras in Step 3
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Task + controls */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-4">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
          Task description
        </label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={2}
          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:border-violet-400 resize-none"
          placeholder="Describe what the arm should do…"
        />
        <p className="text-xs text-gray-500 mt-2">
          Say something like "Go to home" to have the robot go to its starting pose.
        </p>
        {running && (
          <p className="text-xs text-amber-700 mt-1">
            Edits in this box do not affect the robot until you click Update Task.
          </p>
        )}
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
          Current task running: <span className="font-medium">{running ? taskRef.current : 'Not running'}</span>
        </div>
        <div className="flex items-center gap-3 mt-3">
          {!running ? (
            <button
              onClick={handleStart}
              disabled={!cameraConfig || !socket || credits < 1 || status === 'connecting' || status === 'loading_policy'}
              className="px-6 py-2.5 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 transition-colors disabled:opacity-50"
            >
              {status === 'connecting' || status === 'loading_policy' ? 'Starting…' : 'Run Inference'}
            </button>
          ) : (
            <>
              <button
                onClick={handleStop}
                className="px-6 py-2.5 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors"
              >
                Stop
              </button>
              <button
                onClick={handleUpdateTask}
                className="px-4 py-2.5 rounded-lg border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Update Task
              </button>
            </>
          )}
          <button
            onClick={() => setShowBestPractices(true)}
            className="px-4 py-2.5 rounded-lg border border-violet-200 text-violet-700 text-sm font-medium hover:bg-violet-50 transition-colors"
          >
            Best Practices
          </button>
          <div className="ml-auto text-xs text-gray-400">
            {running && credits > 0 ? <><span className="text-green-600 font-medium">● Billing active</span> · $0.15/min</> : ''}
          </div>
        </div>
        {!cameraConfig && (
          <p className="text-xs text-red-500 mt-2">Complete camera setup (Step 3) to enable inference.</p>
        )}
        {!liveConnected && (
          <p className="text-xs text-red-500 mt-2">Robot not connected — check USB cable and reconnect in Step 1.</p>
        )}
      </div>

      {showBestPractices && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-900">Best Practices</h3>
              <button
                onClick={() => setShowBestPractices(false)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Close
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-2">
              <p>Keep people and fragile objects out of the robot workspace before running inference.</p>
              <p>Start with short, simple tasks and stop immediately if behavior looks unsafe.</p>
              <p>Keep one hand near the Stop button at all times while testing a new task.</p>
              <p>Use clear task wording and update only one objective at a time for predictable behavior.</p>
              <p>If the robot drifts or hesitates, stop, reset to a safe pose, and restart inference.</p>
                <p>Pi0.5_so101_finetuned is best for simple pick-and-place tasks. If you have a strong task-specific policy, please share it with us.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
