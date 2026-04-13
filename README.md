# ARM101 — Cloud Inference Web Platform

Run physical AI inference from your browser with a guided 4-step setup.

```
Browser (feetech.js + cameras)
   ↕  WebSocket / Socket.io
EC2 / local Node.js backend
   ↕  TCP + msgpack
Modal GPU container (inference)
```

---

## Prerequisites

- **macOS / Linux** host for local dev
- **Node.js 18+**
- **Python 3.11+** with `modal` CLI installed (`pip install modal`)
- A **Feetech SO-101 arm** with USB serial controller
- Two USB cameras (top + wrist)
- A Modal account with an active HuggingFace secret named `huggingface-secret`

---

## 1 — Start locally (development)

### 1a. Download the model (one-time)

```bash
cd Website/modal_server
modal run server.py::download_model
```

This downloads `nuffnuff/pi05-so101-finetuned_1` and `google/paligemma-3b-pt-224`
into the `pi05-model-cache` Modal Volume.  Takes ~5 minutes with a fast connection.

### 1b. Start the Modal inference server

```bash
cd Website/modal_server
modal run server.py
```

Wait for output like:

```
  SERVER READY (multi-client)
  --server-address tcp.abc123.modal.run:9100
  max concurrent clients: 5
```

Copy the `--server-address` value (e.g. `tcp.abc123.modal.run:9100`).

### 1c. Configure the backend

```bash
cd Website/backend
cp .env.example .env
# Edit .env:
#   MODAL_ADDRESSES=tcp.abc123.modal.run:9100   ← paste your address
#   JWT_SECRET=any-long-random-string
```

### 1d. Start the backend

```bash
cd Website/backend
npm install
npm start
# Listening on http://localhost:3001
```

### 1e. Start the frontend

```bash
cd Website/frontend
npm install
npm run dev
# Open http://localhost:3000
```

### 1f. Use the app

1. Open `http://localhost:3000`, click **Get started**, create an account.
2. Follow the 4-step dashboard:
   - **Step 1** — Connect the serial controller, assign IDs 1–6 to each motor.
   - **Step 2** — Calibrate the arm (zero corrections + find limits).
   - **Step 3** — Assign cameras (top / wrist) and adjust rotation.
   - **Step 4** — Enter a task and click **Run Inference**.

> **Note on browser requirements:** Web Serial API requires Chromium-based browsers (Chrome, Edge, Arc).  Firefox does not support it yet.

---

## 2 — Environment variables reference

### Backend (`Website/backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend server port |
| `JWT_SECRET` | — | Secret for signing JWTs (**change in production**) |
| `MODAL_ADDRESSES` | — | Comma-separated `host:port` of Modal TCP servers |
| `CORS_ORIGINS` | `http://localhost:3000` | Allowed frontend origins |
| `MAX_CLIENTS_PER_CONTAINER` | `5` | Clients per Modal container before routing to next |
| `INITIAL_CREDITS_CENTS` | `500` | Starting credits for new accounts ($5.00) |

### Frontend (`Website/frontend/.env.local`)

Create this file for local overrides:
```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
```

For Vercel deployment, set `NEXT_PUBLIC_BACKEND_URL` to your EC2 backend URL.

---

## 3 — Scaling (multiple users)

The Modal server handles up to 5 concurrent inference sessions per container.
If more users connect, start additional Modal containers:

```bash
# Terminal 1
modal run modal_server/server.py
# → tcp.abc.modal.run:9100

# Terminal 2
modal run modal_server/server.py
# → tcp.def.modal.run:9100
```

Then add both to your backend `.env`:
```env
MODAL_ADDRESSES=tcp.abc.modal.run:9100,tcp.def.modal.run:9100
```

The backend automatically distributes users to containers with available capacity.

---

## 4 — Deploy to Vercel + EC2

### 4a. EC2 setup (Ubuntu 22.04 recommended)

```bash
# On your EC2 instance
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt-get install -y nodejs git

# Clone repo
git clone <your-repo> arm101 && cd arm101/Website/backend

# Install dependencies
npm install

# Copy and edit .env
cp .env.example .env
nano .env
# Set JWT_SECRET, MODAL_ADDRESSES, CORS_ORIGINS=https://your-vercel-app.vercel.app

# Start with PM2 for persistence
sudo npm install -g pm2
pm2 start server.js --name arm101-backend
pm2 save && pm2 startup
```

Open port 3001 (or your chosen port) in the EC2 security group.
Optionally place Nginx in front with SSL:

```nginx
server {
    listen 443 ssl;
    server_name api.arm101.ai;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 4b. Vercel deployment

```bash
cd Website/frontend

# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variable in Vercel dashboard:
# NEXT_PUBLIC_BACKEND_URL = https://api.arm101.ai   (or your EC2 address)
```

Or push to GitHub and connect the `Website/frontend` directory in Vercel's
"root directory" setting.

### 4c. Modal server — production

The Modal server runs the same way in production. Start one or more containers,
copy the `--server-address` values into the backend's `MODAL_ADDRESSES` env var
on EC2, then restart PM2:

```bash
pm2 restart arm101-backend
```

---

## 5 — Architecture notes

### Billing
- Credits are stored in memory (restart resets them).  
- For production: replace the in-memory `users` Map in `backend/server.js`
  with a Postgres/SQLite table.  Stripe integration for `POST /billing/add-credits`.

### Auth
- Simple JWT + bcrypt.  For production add email verification, rate limiting,
  and consider replacing with Auth0 / Clerk.

### Feetech.js
- Requires Chromium-based browser.
- Tested with feetech.js SDK from `npm install feetech.js` (bambot project).
- Motor positions are 0–4095 (12-bit).  The Modal postprocessor returns values
  in the same scale, so they can be passed directly to `syncWritePositions`.

### Action execution timing
- The control loop targets 30 Hz using `performance.now()` compensation.
- feetech.js `syncWritePositions` typically completes in <10 ms for 6 motors.
- Each observation is sent every 20 steps (~667 ms).  The robot briefly pauses
  during the ~250 ms inference latency — identical to `client.py` behaviour.

---

## 6 — Project structure

```
Website/
  frontend/          Next.js 14 + Tailwind (deploy to Vercel)
  backend/           Node.js + Socket.io bridge (deploy to EC2)
  modal_server/      Modal GPU inference server (run with `modal run`)
  README.md          This file
```

The existing `Cloud_Inference/` folder is unchanged and still works as a Python
CLI client for testing inference independently of the web platform.
