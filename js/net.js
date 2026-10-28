// Online play over PeerJS (WebRTC data channel, public PeerJS broker for signaling only).
// This module only moves messages. The host's Game checks every move with rules.js.

import { NET } from './config.js';

const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
let peerLib = null;

function loadPeerJs() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (peerLib) return peerLib;
  peerLib = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.async = true;
    const timer = setTimeout(() => reject(new Error('load-fail')), 12000);
    s.onload = () => {
      clearTimeout(timer);
      window.Peer ? resolve(window.Peer) : reject(new Error('load-fail'));
    };
    s.onerror = () => {
      clearTimeout(timer);
      peerLib = null;
      s.remove();
      reject(new Error('load-fail'));
    };
    document.head.appendChild(s);
  });
  return peerLib;
}

export function makeCode() {
  let c = '';
  const a = NET.codeAlphabet;
  const rnd = crypto.getRandomValues(new Uint32Array(NET.codeLength));
  for (const r of rnd) c += a[r % a.length];
  return c;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class OnlineSession {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.code = null;
    this.handlers = {};
    this.lastSeen = 0;
    this.hb = null;
    this.closed = false;
    this.unstable = false;
  }

  on(ev, fn) {
    this.handlers[ev] = fn;
    return this;
  }

  emit(ev, ...args) {
    this.handlers[ev]?.(...args);
  }

  async host() {
    this.role = 'host';
    const Peer = await loadPeerJs();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode();
      try {
        await this.openPeer(Peer, NET.peerPrefix + code);
        this.code = code;
        this.peer.on('connection', (c) => this.acceptConnection(c));
        return code;
      } catch (err) {
        if (err.type !== 'unavailable-id') throw err;
      }
    }
    throw Object.assign(new Error('no-id'), { type: 'unavailable-id' });
  }

  async join(code) {
    this.role = 'guest';
    this.code = code;
    const Peer = await loadPeerJs();
    await this.openPeer(Peer);
    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(NET.peerPrefix + code, { reliable: true, serialization: 'json' });
      const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { type: 'peer-unavailable' })), 15000);
      this.peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          clearTimeout(timer);
          reject(err);
        }
      });
      this.attach(conn, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  openPeer(Peer, id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
      let opened = false;
      peer.on('open', () => {
        opened = true;
        this.peer = peer;
        resolve();
      });
      peer.on('error', (err) => {
        if (!opened) {
          peer.destroy();
          reject(err);
        } else if (err.type !== 'peer-unavailable') {
          console.warn('peer error', err.type, err);
          if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) this.emit('status', 'unstable');
        }
      });
      // Losing the broker does not drop an open data channel; try to get it back quietly.
      peer.on('disconnected', () => {
        if (!this.closed && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
      });
    });
  }

  acceptConnection(conn) {
    if (this.conn && this.conn.open) {
      conn.on('open', () => {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 300);
      });
      return;
    }
    this.attach(conn);
  }

  attach(conn, onOpen) {
    this.conn = conn;
    conn.on('open', () => {
      this.lastSeen = Date.now();
      this.startHeartbeat();
      this.emit('status', 'connected');
      onOpen?.();
      this.emit('connected');
    });
    conn.on('data', (msg) => {
      this.lastSeen = Date.now();
      if (this.unstable) {
        this.unstable = false;
        this.emit('status', 'connected');
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') return;
      if (msg.t === 'bye') {
        this.handleLeft();
        return;
      }
      this.emit('message', msg);
    });
    conn.on('close', () => this.handleLeft());
    conn.on('error', (err) => console.warn('conn error', err));
  }

  startHeartbeat() {
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (!this.conn?.open) return;
      this.send({ t: 'ping' });
      const quiet = Date.now() - this.lastSeen;
      if (quiet > NET.timeoutMs) this.handleLeft();
      else if (quiet > NET.heartbeatMs * 2.2 && !this.unstable) {
        this.unstable = true;
        this.emit('status', 'unstable');
      }
    }, NET.heartbeatMs);
  }

  handleLeft() {
    if (this.closed) return;
    clearInterval(this.hb);
    if (this.role === 'host' && this.peer && !this.peer.destroyed) {
      // Keep the room open so a fresh opponent could join later; the game itself ends.
      this.conn = null;
    }
    this.emit('left');
  }

  send(msg) {
    if (this.conn?.open) {
      try {
        this.conn.send(msg);
      } catch (err) {
        console.warn('send failed', err);
      }
    }
  }

  close() {
    if (this.closed) return;
    this.send({ t: 'bye' });
    this.closed = true;
    clearInterval(this.hb);
    setTimeout(() => {
      try {
        this.conn?.close();
      } catch {}
      try {
        this.peer?.destroy();
      } catch {}
    }, 120);
  }
}
