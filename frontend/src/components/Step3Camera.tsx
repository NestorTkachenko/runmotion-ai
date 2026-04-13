'use client';

import { useState, useEffect, useRef } from 'react';
import type { CameraConfig } from '@/app/dashboard/page';

type Rotation = 0 | 90 | 180 | 270;
const ROTATIONS: Rotation[] = [0, 90, 180, 270];

interface Props {
  onComplete: (config: CameraConfig) => void;
}

export default function Step3Camera({ onComplete }: Props) {
  const [cameras,       setCameras]       = useState<MediaDeviceInfo[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [topDeviceId,   setTopDeviceId]   = useState('');
  const [wristDeviceId, setWristDeviceId] = useState('');
  const [topRot,        setTopRot]        = useState<Rotation>(0);
  const [wristRot,      setWristRot]      = useState<Rotation>(0);

  // Preview streams
  const topVideoRef   = useRef<HTMLVideoElement>(null);
  const wristVideoRef = useRef<HTMLVideoElement>(null);
  const topStreamRef   = useRef<MediaStream | null>(null);
  const wristStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      topStreamRef.current?.getTracks().forEach((t) => t.stop());
      wristStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Start/restart stream whenever the selected device changes.
  // useEffect runs after React has committed the DOM, so the <video> ref is valid.
  useEffect(() => {
    if (!topDeviceId) return;
    previewCamera(topDeviceId, topVideoRef.current, topStreamRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topDeviceId]);

  useEffect(() => {
    if (!wristDeviceId) return;
    previewCamera(wristDeviceId, wristVideoRef.current, wristStreamRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wristDeviceId]);

  async function listCameras() {
    setLoading(true);
    try {
      // Request permission first
      await navigator.mediaDevices.getUserMedia({ video: true });
      const devs = await navigator.mediaDevices.enumerateDevices();
      setCameras(devs.filter((d) => d.kind === 'videoinput'));
    } catch (e: any) {
      alert(`Camera access error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function previewCamera(
    deviceId: string,
    videoEl: HTMLVideoElement | null,
    streamRef: React.MutableRefObject<MediaStream | null>,
  ) {
    if (!videoEl || !deviceId) return;
    // Stop existing
    streamRef.current?.getTracks().forEach((t) => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: 640, height: 360 },
    });
    streamRef.current = stream;
    videoEl.srcObject = stream;
  }

  function handleSelectTop(deviceId: string) {
    setTopDeviceId(deviceId);
  }

  function handleSelectWrist(deviceId: string) {
    setWristDeviceId(deviceId);
  }

  function rotStyle(rot: Rotation) {
    const transforms: Record<Rotation, string> = {
      0:   'rotate(0deg)',
      90:  'rotate(90deg)',
      180: 'rotate(180deg)',
      270: 'rotate(270deg)',
    };
    return { transform: transforms[rot], transition: 'transform 0.3s' };
  }

  const canProceed = topDeviceId && wristDeviceId;

  function handleComplete() {
    if (!canProceed) return;
    // Stop previews; Step4 will restart them using the config
    topStreamRef.current?.getTracks().forEach((t) => t.stop());
    wristStreamRef.current?.getTracks().forEach((t) => t.stop());
    onComplete({ topDeviceId, wristDeviceId, topRotation: topRot, wristRotation: wristRot });
  }

  return (
    <div className="max-w-3xl animate-fade-in">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-violet-600 mb-2">Step 3</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Camera Setup</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          Identify your cameras and assign each one as the <strong>top camera</strong> or <strong>wrist camera</strong>.
          Adjust rotation so the image appears right-side-up. These settings are used during inference.
        </p>
      </div>

      {cameras.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <button
            onClick={listCameras}
            disabled={loading}
            className="px-5 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Requesting access…' : 'Open Camera Access'}
          </button>
          <p className="text-xs text-gray-400 mt-2">
            Your browser will ask for camera permission.
          </p>
        </div>
      ) : (
        <div className="mb-6 text-sm text-gray-500">
          Found <strong>{cameras.length}</strong> camera(s).{' '}
          <button onClick={listCameras} className="text-violet-600 hover:underline">Refresh</button>
        </div>
      )}

      {cameras.length > 0 && (
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Top camera */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <span className="font-semibold text-gray-800 text-sm">Top Camera</span>
            </div>
            <div className="p-4 space-y-3">
              <select
                value={topDeviceId}
                onChange={(e) => handleSelectTop(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700 focus:outline-none focus:border-violet-400"
              >
                <option value="">— Select camera —</option>
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Camera ${c.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>

              {topDeviceId && (
                <>
                  {/* Preview */}
                  <div className="relative overflow-hidden rounded-lg bg-black aspect-video">
                    <video
                      ref={topVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                      style={rotStyle(topRot)}
                    />
                  </div>
                  {/* Rotation */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1.5 block">Rotation</label>
                    <div className="flex gap-2">
                      {ROTATIONS.map((r) => (
                        <button
                          key={r}
                          onClick={() => setTopRot(r)}
                          className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                            topRot === r ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {r}°
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Wrist camera */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-orange-400" />
              <span className="font-semibold text-gray-800 text-sm">Wrist Camera</span>
            </div>
            <div className="p-4 space-y-3">
              <select
                value={wristDeviceId}
                onChange={(e) => handleSelectWrist(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700 focus:outline-none focus:border-violet-400"
              >
                <option value="">— Select camera —</option>
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Camera ${c.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>

              {wristDeviceId && (
                <>
                  <div className="relative overflow-hidden rounded-lg bg-black aspect-video">
                    <video
                      ref={wristVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                      style={rotStyle(wristRot)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1.5 block">Rotation</label>
                    <div className="flex gap-2">
                      {ROTATIONS.map((r) => (
                        <button
                          key={r}
                          onClick={() => setWristRot(r)}
                          className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                            wristRot === r ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {r}°
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {cameras.length > 0 && (
        <button
          onClick={handleComplete}
          disabled={!canProceed}
          className="w-full py-3 rounded-xl bg-violet-600 text-white font-semibold text-sm hover:bg-violet-700 transition-colors disabled:opacity-50"
        >
          {canProceed ? 'Save camera configuration → Continue to Run AI Policy' : 'Select both cameras to continue'}
        </button>
      )}
    </div>
  );
}
