/**
 * feetech.ts  —  Lazy-loaded wrapper around the feetech.js SDK
 *
 * The SDK uses the Web Serial API, which is browser-only.  We import it
 * dynamically so Next.js SSR does not crash.
 *
 * Usage:
 *   const sdk = await getSDK();
 *   await sdk.connect();                        // opens port picker dialog
 *   const positions = await sdk.syncReadPositions([1,2,3,4,5,6]);
 *   await sdk.syncWritePositions({1:2048,2:2048,...});
 *   await sdk.setServoId(1, 3);                 // reassign motor ID
 *   await sdk.disconnect();
 *
 * NOTE: servo positions are 0–4095 (12-bit).  After lerobot postprocessing
 * the action values should already be in this range, so they can be passed
 * directly to syncWritePositions.
 */

'use client';

// Motor layout for SO-101 (matches lerobot's action_features order)
export const MOTOR_IDS = [1, 2, 3, 4, 5, 6] as const;
export const MOTOR_NAMES: Record<number, string> = {
  1: 'shoulder_pan',
  2: 'shoulder_lift',
  3: 'elbow_flex',
  4: 'wrist_flex',
  5: 'wrist_roll',
  6: 'gripper',
};
export const MOTOR_LABELS: Record<number, string> = {
  1: 'Shoulder Pan',
  2: 'Shoulder Lift',
  3: 'Elbow Flex',
  4: 'Wrist Flex',
  5: 'Wrist Roll',
  6: 'Gripper',
};

// Singleton promise so we only import once
let _sdkPromise: Promise<any> | null = null;

export async function getSDK(): Promise<any> {
  if (_sdkPromise) return _sdkPromise;
  _sdkPromise = import('feetech.js').then((m) => m.scsServoSDK);
  return _sdkPromise;
}

/** Connect to the Feetech controller via Web Serial (triggers browser dialog). */
export async function sdkConnect(): Promise<void> {
  const sdk = await getSDK();
  await sdk.connect();
}

export async function sdkDisconnect(): Promise<void> {
  const sdk = await getSDK();
  await sdk.disconnect();
}

/**
 * Scan servo IDs in [minId, maxId] range.  Returns list of found IDs.
 */
export async function scanServos(minId = 0, maxId = 20): Promise<number[]> {
  const sdk   = await getSDK();
  const found: number[] = [];
  for (let id = minId; id <= maxId; id++) {
    try {
      const pos = await sdk.readPosition(id);
      if (pos !== undefined && pos !== null) found.push(id);
    } catch {
      // Not present — skip
    }
  }
  return found;
}

/** Reassign a servo's ID from currentId → newId. */
export async function setServoId(currentId: number, newId: number): Promise<void> {
  const sdk = await getSDK();
  await sdk.setServoId(currentId, newId);
}

/**
 * Read positions of all 6 arm motors.
 * Returns an array of 6 values in ID order: [id1_pos, id2_pos, ..., id6_pos]
 */
export async function readAllPositions(): Promise<number[]> {
  const sdk = await getSDK();
  const map: Map<number, number> = await sdk.syncReadPositions(MOTOR_IDS as unknown as number[]);
  return MOTOR_IDS.map((id) => map.get(id) ?? 2048);
}

/**
 * Write positions to all 6 arm motors simultaneously.
 * @param positions 6 values matching MOTOR_IDS order
 */
export async function writeAllPositions(positions: number[]): Promise<void> {
  const sdk = await getSDK();
  const posMap: Record<number, number> = {};
  MOTOR_IDS.forEach((id, i) => {
    posMap[id] = Math.round(Math.max(0, Math.min(4095, positions[i])));
  });
  await sdk.syncWritePositions(posMap);
}

/**
 * Lightweight connection probe — reads position of motor 1.
 * Returns true if the serial port is open and the servo responds.
 * Returns false if not yet connected or if the port has been closed/unplugged.
 */
export async function probeConnection(): Promise<boolean> {
  // If SDK was never imported there's no connection
  if (!_sdkPromise) return false;
  try {
    const sdk = await _sdkPromise;
    // Check internal portHandler state first (fast, no I/O)
    if (!sdk.portHandler?.isOpen) return false;
    // Actually perform an I/O read to confirm the cable is still live
    await sdk.readPosition(1);
    return true;
  } catch {
    return false;
  }
}

/** Enable / disable torque on all motors. */
export async function setTorqueAll(enable: boolean): Promise<void> {
  const sdk = await getSDK();
  for (const id of MOTOR_IDS) {
    await sdk.writeTorqueEnable(id, enable);
  }
}

// ── Arm calibration helpers (mirrors bambot's Calibrate.tsx logic) ─────────────

/**
 * Phase 1: zero out all position corrections so we see raw servo values.
 * Returns actual physical positions after zeroing.
 */
export async function resetCorrectionsAndRead(): Promise<Map<number, number>> {
  const sdk = await getSDK();
  const zeros: Record<number, number> = {};
  for (const id of MOTOR_IDS) zeros[id] = 0;
  await sdk.syncWritePosCorrection(zeros);
  return sdk.syncReadPositions(MOTOR_IDS as unknown as number[]);
}

/**
 * Phase 2: apply homing corrections so that the neutral pose reads ~2047.
 * Saves corrections = (physicalPos - 2047) to each servo EEPROM.
 */
export async function applyHomingCorrections(): Promise<Map<number, number>> {
  const sdk = await getSDK();
  const zeroed = await resetCorrectionsAndRead();
  const corrections: Record<number, number> = {};
  for (const id of MOTOR_IDS) {
    corrections[id] = (zeroed.get(id) ?? 2047) - 2047;
  }
  await sdk.syncWritePosCorrection(corrections);
  // Verify
  return sdk.syncReadPositions(MOTOR_IDS as unknown as number[]);
}

/**
 * Write discovered min/max limits to servo EEPROM.
 */
export async function saveLimits(
  minPositions: Map<number, number>,
  maxPositions: Map<number, number>,
): Promise<void> {
  const sdk = await getSDK();
  const minObj: Record<number, number> = {};
  const maxObj: Record<number, number> = {};
  for (const id of MOTOR_IDS) {
    minObj[id] = minPositions.get(id) ?? 0;
    maxObj[id] = maxPositions.get(id) ?? 4095;
  }
  await sdk.syncWriteMinPosLimits(minObj);
  await sdk.syncWriteMaxPosLimits(maxObj);
}

/**
 * Reset every motor's EEPROM min/max position limits back to the full
 * hardware range (0–4095).  Call this before running inference so that
 * previously-saved narrow calibration limits can never silently block a
 * position command.  Software bounds checking in armCalib handles safety.
 */
export async function resetLimitsToFull(): Promise<void> {
  const sdk = await getSDK();
  const fullMin: Record<number, number> = {};
  const fullMax: Record<number, number> = {};
  for (const id of MOTOR_IDS) {
    fullMin[id] = 0;
    fullMax[id] = 4095;
  }
  await sdk.syncWriteMinPosLimits(fullMin);
  await sdk.syncWriteMaxPosLimits(fullMax);
}
