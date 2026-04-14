/**
 * socket.ts  —  Socket.io client singleton for ARM101
 *
 * Usage:
 *   import { getSocket, connectSocket, disconnectSocket } from '@/lib/socket';
 *
 *   const socket = await connectSocket(token);
 *   socket.emit('start_inference', { task: '...', actionsPerChunk: 50 });
 *   socket.on('action_chunk', ({ actions }) => { ... });
 */

'use client';

import { io, Socket } from 'socket.io-client';

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || 'https://api.runmotion.ai';

let _socket: Socket | null = null;

export function getSocket(): Socket | null {
  return _socket;
}

export function connectSocket(token: string): Socket {
  if (_socket && _socket.connected) return _socket;

  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }

  _socket = io(BACKEND_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });

  _socket.on('connect', () => {
    console.log('[socket] connected', _socket?.id);
  });

  _socket.on('connect_error', (err) => {
    console.error('[socket] connect error:', err.message);
  });

  _socket.on('disconnect', (reason) => {
    console.warn('[socket] disconnected:', reason);
  });

  return _socket;
}

export function disconnectSocket(): void {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}

/** Helper: POST to backend auth endpoints */
export async function apiPost<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export async function apiDelete<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}
