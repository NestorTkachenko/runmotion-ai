/**
 * ARM101 WebSocket Bridge Server
 *
 * Responsibilities:
 *  - Auth (sign-up / sign-in)  with JWT + bcrypt
 *  - Per-user session state (credits, task, calibration, arm config)
 *  - Routing WebSocket clients to available Modal TCP containers
 *  - Bridging: WebSocket obs_frame  → Modal TCP  → WebSocket action_chunk
 *  - Billing timer: $0.15/min deducted while inference is running
 *    (loading / startup time is NOT billed)
 *  - Auto-start a second Modal container if all slots are full
 *    (prints instructions — actual Modal launch must be done manually in first version)
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const { Server }  = require('socket.io');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const net       = require('net');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
const { encode: msgpackEncode, decode: msgpackDecode } = require('@msgpack/msgpack');
const { v4: uuidv4 } = require('uuid');
const { DatabaseSync } = require('node:sqlite');
const { OAuth2Client } = require('google-auth-library');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT              = parseInt(process.env.PORT || '3001', 10);
const JWT_SECRET        = process.env.JWT_SECRET || 'change-in-production';
const CORS_ORIGINS      = (process.env.CORS_ORIGINS || 'https://runmotion.ai,https://www.runmotion.ai,http://localhost:3000').split(',');
const INITIAL_CREDITS   = parseInt(process.env.INITIAL_CREDITS_CENTS || '500', 10); // cents
const MAX_PER_CONTAINER = parseInt(process.env.MAX_CLIENTS_PER_CONTAINER || '5', 10);
const SCALE_UP_THRESHOLD = parseInt(process.env.MODAL_SCALE_UP_THRESHOLD || '4', 10);
const MODAL_MAX_CONTAINERS = parseInt(process.env.MODAL_MAX_CONTAINERS || '3', 10);
const MODAL_AUTO_SCALE = (process.env.MODAL_AUTO_SCALE || 'true').toLowerCase() !== 'false';
const MODAL_CLI_BIN = process.env.MODAL_CLI_BIN || 'modal';
const MODAL_SERVER_ENTRYPOINT = process.env.MODAL_SERVER_ENTRYPOINT || 'modal_server/server.py';
const MODAL_LAUNCH_WORKDIR = process.env.MODAL_LAUNCH_WORKDIR
  ? path.resolve(__dirname, process.env.MODAL_LAUNCH_WORKDIR)
  : path.resolve(__dirname, '..');
const MODAL_LAUNCH_TIMEOUT_MS = parseInt(process.env.MODAL_LAUNCH_TIMEOUT_MS || '180000', 10);
const MODAL_LAUNCH_COOLDOWN_MS = parseInt(process.env.MODAL_LAUNCH_COOLDOWN_MS || '45000', 10);
// Billing: $0.15 / min = 0.25 cents/sec
const BILLING_RATE_CENTS_PER_SEC = 0.15 / 60 * 100;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '386895169996-dik1r8cmiv7gonhhs6s56rsu5lishj3q.apps.googleusercontent.com';

// Parse Modal addresses from env: "addr1,addr2"
const MODAL_ADDRESSES = (process.env.MODAL_ADDRESSES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ── SQLite persistent store ───────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'db.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email           TEXT PRIMARY KEY,
    hashed_password TEXT,
    credits         REAL NOT NULL,
    provider        TEXT NOT NULL DEFAULT 'email',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS calibrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const dbGetUser           = db.prepare('SELECT * FROM users WHERE email = ?');
const dbCreateUser        = db.prepare('INSERT INTO users (email, hashed_password, credits, provider) VALUES (?, ?, ?, ?)');
const dbUpdateCredits     = db.prepare('UPDATE users SET credits = ? WHERE email = ?');
const dbGetCalibrations   = db.prepare('SELECT id, name, created_at FROM calibrations WHERE email = ? ORDER BY created_at DESC');
const dbGetCalibration    = db.prepare('SELECT * FROM calibrations WHERE id = ? AND email = ?');
const dbSaveCalibration   = db.prepare('INSERT INTO calibrations (email, name, data) VALUES (?, ?, ?)');
const dbDeleteCalibration = db.prepare('DELETE FROM calibrations WHERE id = ? AND email = ?');

const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/**
 * @type {Map<string, {
 *   email: string,
 *   credits: number,
 *   socketId: string|null,
 *   task: string,
 *   inferenceActive: boolean,
 *   billingStartTime: number|null,
 *   billingInterval: NodeJS.Timeout|null,
 *   billTick: number,
 *   modalClient: ModalClient|null,
 *   armCalibration: object|null,
 *   cameraConfig: object|null,
 * }>}
 */
const sessions = new Map();

// Track active client count per Modal address
const modalSlots = new Map(); // address → count
const launchedModalProcs = new Map(); // address → child process
let launchInFlight = null;
let lastModalLaunchAt = 0;

function addModalAddress(address, source = 'env') {
  if (!address) return;
  if (!modalSlots.has(address)) {
    modalSlots.set(address, 0);
    console.log(`[modal] registered ${address} (source=${source})`);
  }
}

// Initialise slot counters from .env addresses (optional)
for (const addr of MODAL_ADDRESSES) addModalAddress(addr, 'env');

// ── Express app ───────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth endpoints ─────────────────────────────────────────────────────────────

app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (dbGetUser.get(email)) return res.status(409).json({ error: 'email already registered' });

  const hashedPassword = await bcrypt.hash(password, 10);
  dbCreateUser.run(email, hashedPassword, INITIAL_CREDITS, 'email');

  const token = jwt.sign({ userId: email }, JWT_SECRET, { expiresIn: '7d' });
  return res.json({ token, credits: INITIAL_CREDITS });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = dbGetUser.get(email);
  if (!user || !user.hashed_password) return res.status(401).json({ error: 'invalid credentials' });

  const ok = await bcrypt.compare(password, user.hashed_password);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });

  const token = jwt.sign({ userId: email }, JWT_SECRET, { expiresIn: '7d' });
  return res.json({ token, credits: user.credits });
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const tok = authHeader.replace(/^Bearer\s+/i, '');
  if (!tok) return res.status(401).json({ error: 'missing token' });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    req.userId = payload.userId;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

app.get('/auth/me', authMiddleware, (req, res) => {
  const session = sessions.get(req.userId);
  const credits = session ? session.credits : (dbGetUser.get(req.userId)?.credits ?? 0);
  return res.json({ email: req.userId, credits });
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

app.post('/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'credential required' });
  if (!googleOAuthClient) {
    return res.status(503).json({ error: 'Google auth not configured on this server' });
  }
  try {
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const gPayload = ticket.getPayload();
    if (!gPayload?.email) return res.status(400).json({ error: 'No email in Google token' });

    const email = gPayload.email;
    let user = dbGetUser.get(email);
    if (!user) {
      dbCreateUser.run(email, null, INITIAL_CREDITS, 'google');
      user = dbGetUser.get(email);
    }

    const token = jwt.sign({ userId: email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, credits: user.credits, email });
  } catch (e) {
    console.error('[auth/google] error:', e.message);
    return res.status(401).json({ error: 'Invalid Google token' });
  }
});

// ── Calibrations ──────────────────────────────────────────────────────────────

app.get('/calibrations', authMiddleware, (req, res) => {
  const rows = dbGetCalibrations.all(req.userId);
  res.json(rows);
});

app.post('/calibrations', authMiddleware, (req, res) => {
  const { name, data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  const result = dbSaveCalibration.run(req.userId, name, JSON.stringify(data));
  res.json({ id: result.lastInsertRowid, name, created_at: Math.floor(Date.now() / 1000) });
});

app.get('/calibrations/:id', authMiddleware, (req, res) => {
  const row = dbGetCalibration.get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

app.delete('/calibrations/:id', authMiddleware, (req, res) => {
  const result = dbDeleteCalibration.run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── Socket.io ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 20 * 1024 * 1024, // 20 MB for camera frames
});

// Auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('authentication required'));
  try {
    const payload  = jwt.verify(token, JWT_SECRET);
    socket.userId  = payload.userId;
    return next();
  } catch {
    return next(new Error('invalid token'));
  }
});

// ── Modal connection pool helpers ─────────────────────────────────────────────

/**
 * Find a Modal address that still has capacity.
 * @returns {string|null}
 */
function findAvailableModalAddress() {
  let bestAddr = null;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const [addr, count] of modalSlots.entries()) {
    if (count < MAX_PER_CONTAINER && count < bestCount) {
      bestAddr = addr;
      bestCount = count;
    }
  }
  return bestAddr;
}

function parseModalAddressFromLine(line) {
  const m = line.match(/--server-address\s+([^\s]+)/);
  return m ? m[1].trim() : null;
}

function attachLineReader(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    while (true) {
      const idx = buf.indexOf('\n');
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  });
}

async function launchModalContainer(reason = 'scale-up') {
  if (!MODAL_AUTO_SCALE) return null;
  if (launchInFlight) return launchInFlight;
  if (modalSlots.size >= MODAL_MAX_CONTAINERS) return null;

  const now = Date.now();
  if (now - lastModalLaunchAt < MODAL_LAUNCH_COOLDOWN_MS) return null;
  lastModalLaunchAt = now;

  launchInFlight = new Promise((resolve, reject) => {
    const args = ['run', MODAL_SERVER_ENTRYPOINT];
    console.log(`[modal] launching container (${reason}) with: ${MODAL_CLI_BIN} ${args.join(' ')}`);

    const child = spawn(MODAL_CLI_BIN, args, {
      cwd: MODAL_LAUNCH_WORKDIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolvedAddress = null;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`Timed out waiting for Modal server address after ${MODAL_LAUNCH_TIMEOUT_MS}ms`));
    }, MODAL_LAUNCH_TIMEOUT_MS);

    const handleLine = (line, source) => {
      console.log(`[modal:${source}] ${line}`);
      const addr = parseModalAddressFromLine(line);
      if (!addr || settled) return;
      resolvedAddress = addr;
      settled = true;
      clearTimeout(timeout);
      addModalAddress(addr, 'auto');
      launchedModalProcs.set(addr, child);
      resolve(addr);
    };

    attachLineReader(child.stdout, (line) => handleLine(line, 'stdout'));
    attachLineReader(child.stderr, (line) => handleLine(line, 'stderr'));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (resolvedAddress) {
        launchedModalProcs.delete(resolvedAddress);
        modalSlots.delete(resolvedAddress);
        console.warn(`[modal] server ${resolvedAddress} exited (code=${code}, signal=${signal})`);
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Modal process exited before announcing address (code=${code}, signal=${signal})`));
      }
    });
  });

  try {
    return await launchInFlight;
  } finally {
    launchInFlight = null;
  }
}

function maybeScaleUp(reason = 'threshold') {
  if (!MODAL_AUTO_SCALE) return;
  if (launchInFlight) return;
  if (modalSlots.size >= MODAL_MAX_CONTAINERS) return;

  if (modalSlots.size === 0) {
    launchModalContainer('bootstrap').catch((e) => console.error(`[modal] bootstrap launch failed: ${e.message}`));
    return;
  }

  const allNearFull = [...modalSlots.values()].every((count) => count >= SCALE_UP_THRESHOLD);
  if (allNearFull) {
    launchModalContainer(reason).catch((e) => console.error(`[modal] scale-up failed: ${e.message}`));
  }
}

async function getModalAddressForNewSession() {
  let addr = findAvailableModalAddress();
  if (addr) {
    maybeScaleUp('preemptive');
    return addr;
  }
  addr = await launchModalContainer('no-capacity');
  if (addr) return addr;
  return findAvailableModalAddress();
}

/**
 * Build a length-prefixed msgpack frame (same protocol as Python server).
 */
function buildFrame(obj) {
  const packed = msgpackEncode(obj);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(packed.length, 0);
  return Buffer.concat([header, Buffer.from(packed)]);
}

/**
 * ModalClient wraps a single TCP connection to a Modal container.
 * It reads length-prefixed msgpack frames and emits events.
 */
class ModalClient {
  constructor(address, onChunk, onError) {
    const [host, portStr] = address.split(':');
    this.address = address;
    this._buf    = Buffer.alloc(0);

    this.socket = net.createConnection({ host, port: parseInt(portStr, 10) });
    this.socket.setNoDelay(true);

    this.socket.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk]);
      while (this._buf.length >= 4) {
        const len = this._buf.readUInt32BE(0);
        if (this._buf.length < 4 + len) break;
        const frame = this._buf.slice(4, 4 + len);
        this._buf   = this._buf.slice(4 + len);
        try {
          const msg = msgpackDecode(frame);
          onChunk(msg);
        } catch (e) {
          console.error('[modal] decode error:', e.message);
        }
      }
    });

    this.socket.on('error', onError);
    this.socket.on('close', () => onError(new Error('TCP connection closed')));
  }

  send(obj) {
    if (this.socket.writable) {
      this.socket.write(buildFrame(obj));
    }
  }

  destroy() {
    try { this.socket.destroy(); } catch {}
  }
}

// ── Billing helpers ───────────────────────────────────────────────────────────

function startBilling(session, socket) {
  if (session.billingInterval) return; // already running
  session.billingStartTime = Date.now();
  session.billingInterval  = setInterval(() => {
    const deduct = BILLING_RATE_CENTS_PER_SEC;
    session.credits = Math.max(0, session.credits - deduct);
    session.billTick = (session.billTick || 0) + 1;
    // Persist to DB every 10 seconds to avoid excessive writes
    if (session.billTick % 10 === 0) {
      dbUpdateCredits.run(session.credits, session.email);
    }

    socket.emit('credits_update', { credits: parseFloat(session.credits.toFixed(2)) });

    if (session.credits <= 0) {
      socket.emit('inference_error', { message: 'Out of credits. Please add credits to continue.' });
      stopInference(session, socket);
    }
  }, 1000); // tick every second
}

function stopBilling(session) {
  if (session.billingInterval) {
    clearInterval(session.billingInterval);
    session.billingInterval  = null;
    session.billingStartTime = null;
  }
}

function stopInference(session, socket) {
  stopBilling(session);
  // Persist final credits to DB so balance survives server restarts
  dbUpdateCredits.run(session.credits, session.email);
  if (session.modalClient) {
    const addr = session.modalClient.address;
    session.modalClient.destroy();
    session.modalClient = null;
    // Free slot
    const cur = modalSlots.get(addr) || 0;
    modalSlots.set(addr, Math.max(0, cur - 1));
  }
  session.inferenceActive = false;
  socket.emit('inference_stopped', {});
}

// ── Socket.io event handlers ────────────────────────────────────────────────

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`[ws] ${userId} connected (${socket.id})`);

  // Get or create session (credits loaded from DB so balance survives server restarts)
  if (!sessions.has(userId)) {
    const user = dbGetUser.get(userId);
    sessions.set(userId, {
      email: userId, credits: user ? user.credits : INITIAL_CREDITS, socketId: socket.id,
      task: '', inferenceActive: false, billingStartTime: null, billingInterval: null,
      billTick: 0, modalClient: null, armCalibration: null, cameraConfig: null,
    });
  }
  const session      = sessions.get(userId);
  session.socketId   = socket.id;

  // Send current credits on connect
  socket.emit('credits_update', { credits: parseFloat(session.credits.toFixed(2)) });

  // ── Save session data ──────────────────────────────────────────────────────

  socket.on('save_arm_calibration', (calibData) => {
    session.armCalibration = calibData;
    console.log(`[ws] ${userId} saved arm calibration`);
  });

  socket.on('save_camera_config', (cameraConfig) => {
    session.cameraConfig = cameraConfig;
    console.log(`[ws] ${userId} saved camera config`);
  });

  // ── Start inference ────────────────────────────────────────────────────────

  socket.on('start_inference', async ({ task, actionsPerChunk = 50, inferenceEveryN = 20, numInferenceSteps = 5 }) => {
    try {
    if (session.inferenceActive) {
      socket.emit('inference_error', { message: 'Already running inference.' });
      return;
    }
    if (session.credits < BILLING_RATE_CENTS_PER_SEC) {
      socket.emit('inference_error', { message: 'Insufficient credits.' });
      return;
    }

    const modalAddr = await getModalAddressForNewSession();
    if (!modalAddr) {
      const hint = MODAL_AUTO_SCALE
        ? 'No Modal server available and auto-launch failed. Check backend logs for modal CLI errors.'
        : 'No Modal server available. Configure MODAL_ADDRESSES or enable MODAL_AUTO_SCALE=true.';
      socket.emit('inference_status', { status: 'no_container', message: hint });
      return;
    }

    socket.emit('inference_status', { status: 'connecting', message: 'Connecting to inference server...' });

    const client = new ModalClient(
      modalAddr,
      // onChunk
      (msg) => {
        if (msg.type === 'ready') {
          session.inferenceActive = true;
          modalSlots.set(modalAddr, (modalSlots.get(modalAddr) || 0) + 1);
          maybeScaleUp('post-assignment');
          socket.emit('inference_status', { status: 'ready', message: 'Ready. Send observations to start.' });
          // Start billing AFTER ready (don't charge for startup)
          startBilling(session, socket);
          return;
        }
        if (msg.type === 'at_capacity') {
          modalSlots.set(modalAddr, MAX_PER_CONTAINER);
          maybeScaleUp('at-capacity');
          socket.emit('inference_status', { status: 'at_capacity', message: 'Inference server is at capacity. Try again in a moment.' });
          client.destroy();
          return;
        }
        if (msg.type === 'chunk') {
          socket.volatile.emit('action_chunk', {
            actions:    msg.actions,
            tInfer:     msg.t_infer,
            tRecv:      msg.t_recv,
            tResp:      msg.t_resp,
          });
        }
      },
      // onError
      (err) => {
        console.error(`[modal] ${userId} error:`, err.message);
        socket.emit('inference_error', { message: `Modal connection error: ${err.message}` });
        stopInference(session, socket);
      },
    );

    session.modalClient = client;
    session.task        = task;

    // Wait for TCP to open, then send init
    client.socket.once('connect', () => {
      socket.emit('inference_status', { status: 'loading_policy', message: 'Loading AI policy... (may take ~5s on warm container)' });
      client.send({
        type:                'init',
        pretrained:          'nuffnuff/pi05-so101-finetuned_1',
        actions_per_chunk:   actionsPerChunk,
        num_inference_steps: numInferenceSteps,
        inference_every_n:   inferenceEveryN,
      });
    });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[modal] start_inference error for ${userId}: ${message}`);
      socket.emit('inference_error', { message: `Failed to start inference: ${message}` });
    }
  });

  // ── Observation frame ─────────────────────────────────────────────────────

  socket.on('obs_frame', (data) => {
    if (!session.inferenceActive || !session.modalClient) return;

    const { ts, state, task, top, wrist } = data;
    session.task = task || session.task;

    session.modalClient.send({
      type:   'obs',
      ts:     ts || Date.now() / 1000,
      t_send: Date.now() / 1000,
      step:   0,
      state:  Array.from(state),
      task:   session.task,
      top:    top   instanceof Uint8Array ? top   : new Uint8Array(top),
      wrist:  wrist instanceof Uint8Array ? wrist : new Uint8Array(wrist),
    });
  });

  // ── Update task ───────────────────────────────────────────────────────────

  socket.on('update_task', ({ task }) => {
    session.task = task;
    socket.emit('inference_status', { status: 'task_updated', message: `Task updated: "${task}"` });
  });

  // ── Stop inference ────────────────────────────────────────────────────────

  socket.on('stop_inference', () => {
    if (!session.inferenceActive) return;
    stopInference(session, socket);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[ws] ${userId} disconnected`);
    session.socketId = null;
    // Keep session alive for reconnect; stop inference & billing cleanly
    if (session.inferenceActive) {
      stopInference(session, socket);
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] ARM101 backend listening on http://localhost:${PORT}`);
  console.log(`[server] autoscale=${MODAL_AUTO_SCALE} maxContainers=${MODAL_MAX_CONTAINERS} maxPerContainer=${MAX_PER_CONTAINER} scaleThreshold=${SCALE_UP_THRESHOLD}`);
  if (MODAL_ADDRESSES.length > 0) {
    console.log(`[server] Modal addresses: ${MODAL_ADDRESSES.join(', ')}`);
  } else {
    console.log('[server] No static MODAL_ADDRESSES configured (auto-launch mode).');
  }

  if (MODAL_AUTO_SCALE) {
    maybeScaleUp('startup');
  }
});
