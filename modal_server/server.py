"""Multi-client cloud inference server — runs on Modal GPU.

Changes from Cloud_Inference/server.py:
  - Handles up to MAX_CONCURRENT_CLIENTS concurrent TCP connections via threading
  - Model pre-loaded on container startup (via @modal.enter equivalent pattern)
    so the first user gets near-instant "ready" response
  - Rejects connections beyond capacity with {"type": "at_capacity"} message
  - Single policy is shared (thread-safe) across all sessions

Protocol (same as original):
  client → server: msgpack {type:"init", pretrained, actions_per_chunk, inference_every_n, ...}
  server → client: msgpack {type:"ready"}  |  {type:"at_capacity"}
  client → server: msgpack {type:"obs", ts, state, task, top(JPEG), wrist(JPEG)}
  server → client: msgpack {type:"chunk", obs_ts, actions, t_recv, t_infer, t_resp}

Usage:
  modal run modal_server/server.py          # start server, prints --server-address
  modal run modal_server/server.py::download_model  # one-time model download
"""

from __future__ import annotations

import io
import os
import socket
import struct
import threading
import time
from pathlib import Path

import modal

# ── Constants ──────────────────────────────────────────────────────────────────

VOLUME_NAME    = "pi05-model-cache"
CACHE_MOUNT    = "/root/pi05_cache"
SERVER_PORT    = 9100

MAX_CONCURRENT_CLIENTS  = 5      # per container; EC2 backend starts a 2nd container if full
DEFAULT_PRETRAINED       = "nuffnuff/pi05-so101-finetuned_1"
DEFAULT_TOKENIZER        = "google/paligemma-3b-pt-224"
DEFAULT_ACTIONS_PER_CHUNK  = 50
DEFAULT_INFERENCE_EVERY_N  = 20
DEFAULT_NUM_INFERENCE_STEPS = 5

# ── Modal image (same as original) ────────────────────────────────────────────

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git", "ca-certificates")
    .pip_install(
        "torch==2.4.1+cu124",
        "torchvision==0.19.1+cu124",
        "torchaudio==2.4.1+cu124",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "torchcodec==0.10.0",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .run_commands("pip install --no-deps lerobot==0.4.4")
    .pip_install(
        "msgpack>=1.1.0",
        "huggingface-hub==0.35.3",
        "numpy==2.2.6",
        "opencv-python-headless==4.12.0.88",
        "git+https://github.com/huggingface/transformers.git"
        "@dcddb970176382c0fcf4521b0c0e6fc15894dfe0",
        "draccus==0.10.0",
        "accelerate",
        "av>=15.0.0,<16.0.0",
        "datasets",
        "deepdiff>=7.0.1,<9.0.0",
        "diffusers>=0.27.2,<0.36.0",
        "einops",
        "gymnasium>=1.1.1,<2.0.0",
        "imageio",
        "jsonlines",
        "packaging>=24.2,<26.0",
        "pyserial",
        "termcolor",
        "wandb>=0.24.0,<0.25.0",
        "setuptools>=71.0.0,<81.0.0",
        "grpcio==1.78.0",
    )
)

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
app    = modal.App("cloud-inference-web", image=image)


# ── Wire helpers ───────────────────────────────────────────────────────────────

def _send_frame(sock: socket.socket, data: bytes) -> None:
    sock.sendall(struct.pack(">I", len(data)) + data)


def _recv_frame(sock: socket.socket) -> bytes:
    header = _recv_exactly(sock, 4)
    length = struct.unpack(">I", header)[0]
    return _recv_exactly(sock, length)


def _recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("connection closed mid-frame")
        buf.extend(chunk)
    return bytes(buf)


# ── Model download helper ──────────────────────────────────────────────────────

@app.function(
    volumes={CACHE_MOUNT: volume},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=3600,
)
def download_model(
    pretrained_name_or_path: str = DEFAULT_PRETRAINED,
    tokenizer_name: str = DEFAULT_TOKENIZER,
):
    from huggingface_hub import snapshot_download

    hf_token = os.environ.get("HUGGINGFACE_TOKEN")
    hub_dir  = os.path.join(CACHE_MOUNT, "hf", "hub")
    os.makedirs(hub_dir, exist_ok=True)

    for repo_id in (pretrained_name_or_path, tokenizer_name):
        print(f"Downloading {repo_id} ...", flush=True)
        snapshot_download(repo_id, cache_dir=hub_dir, token=hf_token)
        print(f"  Done: {repo_id}", flush=True)

    volume.commit()
    print("Done — weights saved to Volume.", flush=True)


# ── Multi-client inference server ─────────────────────────────────────────────

@app.function(
    gpu="A10G",
    region="us-east",
    volumes={CACHE_MOUNT: volume},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    min_containers=1,         # keep one warm container ready at all times
    scaledown_window=300,     # scale down after 5 min idle
    timeout=7200,
)
def run_server():
    """
    Long-running TCP server that:
    1. Pre-loads the default model before accepting any connections
    2. Handles up to MAX_CONCURRENT_CLIENTS simultaneous connections via threads
    3. Returns "at_capacity" to clients that arrive when all slots are taken
    """
    import cv2
    import msgpack
    import numpy as np
    import torch

    # ── HF cache ────────────────────────────────────────────────────────────────
    hf_cache = os.path.join(CACHE_MOUNT, "hf")
    os.environ["HF_HOME"]                = hf_cache
    os.environ["HUGGINGFACE_HUB_CACHE"]  = os.path.join(hf_cache, "hub")
    os.environ["HF_HUB_OFFLINE"]         = "1"
    os.environ["TRANSFORMERS_OFFLINE"]   = "1"

    hub_dir = Path(CACHE_MOUNT) / "hf" / "hub"

    def resolve_snapshot(repo_id: str) -> str:
        hub_name      = "models--" + repo_id.replace("/", "--")
        snapshot_root = hub_dir / hub_name / "snapshots"
        if snapshot_root.exists():
            snaps = sorted(p for p in snapshot_root.iterdir() if p.is_dir())
            if snaps:
                return str(snaps[-1])
        return repo_id

    # ── Shared policy cache (accessed from all client threads) ─────────────────
    _policy_cache: dict = {}   # key → (policy, preprocessor, postprocessor)
    _policy_lock  = threading.Lock()

    def _load_policy(pretrained: str, num_steps: int):
        from lerobot.policies.pi05.modeling_pi05 import PI05Policy
        from lerobot.policies.factory import make_pre_post_processors

        resolved       = resolve_snapshot(pretrained)
        tokenizer_path = resolve_snapshot(DEFAULT_TOKENIZER)
        key            = resolved

        with _policy_lock:
            if key in _policy_cache:
                return key  # already loaded

            print(f"[server] Loading policy from {resolved} ...", flush=True)
            t0  = time.perf_counter()
            pol = PI05Policy.from_pretrained(resolved)
            pol.to("cuda")
            pol.eval()
            pol.model.config.num_inference_steps = num_steps

            preprocessor, postprocessor = make_pre_post_processors(
                pol.config,
                pretrained_path=resolved,
                preprocessor_overrides={
                    "device_processor": {"device": "cuda"},
                    "tokenizer_processor": {"tokenizer_name": tokenizer_path},
                },
                postprocessor_overrides={
                    "device_processor": {"device": "cuda"},
                },
            )
            _policy_cache[key] = (pol, preprocessor, postprocessor)
            print(f"[server] Policy loaded in {time.perf_counter()-t0:.1f}s", flush=True)
            return key

    # ── Pre-load the default model before accepting connections ─────────────────
    print("[server] Pre-loading default model (warm-up)...", flush=True)
    _load_policy(DEFAULT_PRETRAINED, DEFAULT_NUM_INFERENCE_STEPS)
    print("[server] Model warm and ready.", flush=True)

    # ── Client handler ──────────────────────────────────────────────────────────

    def _handle_client(conn: socket.socket, addr):
        """Runs in its own thread. Processes init + obs messages for one connection."""
        policy_key: str | None = None
        actions_per_chunk      = DEFAULT_ACTIONS_PER_CHUNK
        inference_every_n      = DEFAULT_INFERENCE_EVERY_N

        def decode_image(jpg_bytes: bytes) -> torch.Tensor:
            arr = np.frombuffer(jpg_bytes, dtype=np.uint8)
            bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            t   = torch.from_numpy(rgb).permute(2, 0, 1).float() / 255.0
            return t.unsqueeze(0).to("cuda")

        try:
            while True:
                raw  = _recv_frame(conn)
                msg  = msgpack.unpackb(raw, raw=False)
                mtype = msg.get("type")

                if mtype == "init":
                    pretrained       = msg.get("pretrained", DEFAULT_PRETRAINED)
                    actions_per_chunk = int(msg.get("actions_per_chunk", DEFAULT_ACTIONS_PER_CHUNK))
                    num_steps        = int(msg.get("num_inference_steps", DEFAULT_NUM_INFERENCE_STEPS))
                    inference_every_n = int(msg.get("inference_every_n", DEFAULT_INFERENCE_EVERY_N))

                    # Load policy (cache hit if same as default)
                    policy_key = _load_policy(pretrained, num_steps)

                    _send_frame(conn, msgpack.packb({"type": "ready"}))
                    print(f"[server] {addr} ready (policy_key={policy_key[-16:]})", flush=True)
                    continue

                if mtype == "obs":
                    if policy_key is None:
                        # Client skipped init — use default
                        policy_key = _load_policy(DEFAULT_PRETRAINED, DEFAULT_NUM_INFERENCE_STEPS)

                    t_recv       = time.perf_counter()
                    obs_ts       = float(msg["ts"])
                    t_send_c     = float(msg.get("t_send", obs_ts))
                    state        = list(msg["state"])
                    top_jpg      = bytes(msg["top"])
                    wrist_jpg    = bytes(msg["wrist"])

                    top_tensor   = decode_image(top_jpg)
                    wrist_tensor = decode_image(wrist_jpg)
                    state_tensor = torch.tensor(state, dtype=torch.float32, device="cuda").unsqueeze(0)

                    batch = {
                        "observation.state":        state_tensor,
                        "observation.images.top":   top_tensor,
                        "observation.images.wrist": wrist_tensor,
                        "task": msg.get("task", ""),
                    }

                    with _policy_lock:
                        pol, preprocessor, postprocessor = _policy_cache[policy_key]

                    t_infer_start = time.perf_counter()
                    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        batch = preprocessor(batch)
                        chunk = pol.predict_action_chunk(batch)
                        chunk = chunk[:, :actions_per_chunk, :]
                    t_infer_done  = time.perf_counter()

                    with torch.inference_mode():
                        B, T, D = chunk.shape
                        flat     = chunk.reshape(B * T, D)
                        flat     = postprocessor(flat)
                        chunk    = flat.reshape(B, T, D).squeeze(0)

                    chunk_cpu = chunk.detach().cpu().float().numpy()

                    t_resp = time.perf_counter()
                    _send_frame(conn, msgpack.packb({
                        "type":    "chunk",
                        "obs_ts":  obs_ts,
                        "t_send":  t_send_c,
                        "t_recv":  t_recv,
                        "t_infer": t_infer_done,
                        "t_resp":  t_resp,
                        "actions": chunk_cpu.tolist(),
                    }))

                    infer_ms = (t_infer_done - t_infer_start) * 1000
                    print(
                        f"[server] {addr} chunk infer={infer_ms:.0f}ms "
                        f"shape={len(chunk_cpu)}x{len(chunk_cpu[0])}",
                        flush=True,
                    )
                    continue

                print(f"[server] {addr} unknown message: {mtype}", flush=True)

        except ConnectionError as e:
            print(f"[server] {addr} disconnected: {e}", flush=True)
        except Exception as e:
            import traceback
            print(f"[server] {addr} error: {e}", flush=True)
            traceback.print_exc()
        finally:
            conn.close()

    # ── TCP listener with thread-per-client ────────────────────────────────────
    capacity_sem = threading.Semaphore(MAX_CONCURRENT_CLIENTS)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", SERVER_PORT))
    srv.listen(50)
    print(f"[server] Listening on 0.0.0.0:{SERVER_PORT}", flush=True)

    with modal.forward(SERVER_PORT, unencrypted=True) as tunnel:
        host, port = tunnel.tcp_socket
        sep = "=" * 60
        print(f"\n{sep}", flush=True)
        print("  SERVER READY (multi-client)", flush=True)
        print(f"  --server-address {host}:{port}", flush=True)
        print(f"  max concurrent clients: {MAX_CONCURRENT_CLIENTS}", flush=True)
        print(f"{sep}\n", flush=True)

        while True:
            conn, addr = srv.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

            if not capacity_sem.acquire(blocking=False):
                # All slots taken — reject gracefully
                try:
                    _send_frame(conn, msgpack.packb({"type": "at_capacity"}))
                except Exception:
                    pass
                conn.close()
                print(f"[server] Rejected {addr} — at capacity", flush=True)
                continue

            print(f"[server] Accepted {addr}", flush=True)

            def _thread_wrapper(c, a, sem):
                try:
                    _handle_client(c, a)
                finally:
                    sem.release()

            t = threading.Thread(target=_thread_wrapper, args=(conn, addr, capacity_sem), daemon=True)
            t.start()


# ── Local entrypoint ──────────────────────────────────────────────────────────

@app.local_entrypoint()
def main():
    run_server.remote()
