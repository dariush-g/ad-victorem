/**
 * Ad Victorem duel server: matchmaking plus a message relay between the two fighters of each pair.
 *
 * The server does not simulate the fight. Each client stays the authority over its own fighter
 * (see multiplayer.md); the server only pairs players and forwards what one says to the other.
 *
 * Each client holds:
 *  - one WebSocket (TCP), for matchmaking, WebRTC signalling and every ordered game event;
 *  - one WebRTC data channel to this server, unordered and without retransmits (SCTP over DTLS over
 *    UDP), for the many-times-a-second fighter state. A lost state packet is simply replaced by the next.
 * If the data channel never opens (UDP blocked), or UDP is switched off (no UDP_PORT), state goes
 * over the WebSocket instead.
 *
 * WebSocket frames are JSON objects with an `op`:
 *   client → server  find {mode, code?} · msg {m} · s {n, m} · rtc {answer | candidate} · ping
 *   server → client  paired {host} · fail {why} · msg {m} · s {n, m} · rtc {offer | candidate} · gone · pong
 * Data channel frames are `s` frames only.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PeerConnection, DataChannel } from 'node-datachannel';

const PORT = Number(process.env.PORT ?? 8080);
/**
 * The one UDP port every data channel shares (ICE UDP mux). It must be reachable through the
 * firewall. Unset: no data channels, and state goes over the WebSocket like everything else.
 */
const UDP_PORT = Number(process.env.UDP_PORT ?? 0);
const rtcLib = UDP_PORT > 0 ? await import('node-datachannel') : null;
/** Browsers this server talks to: the game's own pages, plus local dev. Empty: allow any origin. */
const ORIGINS = (process.env.ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

/** Largest frame accepted from a client, and how many frames a second it may send before being cut off. */
const MAX_FRAME = 2000, MAX_RATE = 120;
/** A client that has said nothing (not even a ping) for this long is dropped. */
const SILENT_MS = 20000;
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;

interface Client {
  ws: WebSocket;
  partner: Client | null;
  host: boolean;
  /** Friend code this client is waiting on as host, if any. */
  code: string | null;
  pc: PeerConnection | null;
  dc: DataChannel | null;
  heard: number;
  /** Frames this second, for the rate limit. */
  budget: number;
  closed: boolean;
}

/** At most one player waits in the open queue at a time; friend hosts wait by code. */
let queued: Client | null = null;
const rooms = new Map<string, Client>();

function send(c: Client, frame: object) {
  if (!c.closed && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(frame));
}

/** State: over the data channel when it is up, otherwise over the WebSocket. */
function sendState(c: Client, raw: string) {
  if (c.closed) return;
  if (c.dc?.isOpen()) {
    try {
      if (c.dc.sendMessage(raw)) return;
    } catch {}
  }
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(raw);
}

function pair(host: Client, guest: Client) {
  host.partner = guest;
  guest.partner = host;
  host.host = true;
  guest.host = false;
  send(host, { op: 'paired', host: true });
  send(guest, { op: 'paired', host: false });
}

function unlist(c: Client) {
  if (queued === c) queued = null;
  if (c.code && rooms.get(c.code) === c) rooms.delete(c.code);
  c.code = null;
}

function drop(c: Client) {
  if (c.closed) return;
  c.closed = true;
  unlist(c);
  const p = c.partner;
  c.partner = null;
  if (p && p.partner === c) {
    p.partner = null;
    send(p, { op: 'gone' });
  }
  try {
    c.dc?.close();
    c.pc?.close();
  } catch {}
  c.dc = c.pc = null;
  try {
    c.ws.terminate();
  } catch {}
}

function find(c: Client, mode: unknown, code: unknown) {
  if (c.partner || c.code || queued === c) return; // one search per connection
  if (mode === 'queue') {
    if (queued && !queued.closed) {
      const host = queued;
      queued = null;
      pair(host, c);
    } else queued = c;
  } else if (mode === 'host' && typeof code === 'string' && CODE.test(code)) {
    if (rooms.has(code)) return send(c, { op: 'fail', why: 'taken' });
    rooms.set(code, c);
    c.code = code;
  } else if (mode === 'join' && typeof code === 'string' && CODE.test(code)) {
    const host = rooms.get(code);
    if (!host || host.closed) return send(c, { op: 'fail', why: 'missing' });
    unlist(host);
    pair(host, c);
  }
}

/** Open the UDP side: this server offers a data channel, the browser answers over the WebSocket. */
function startRtc(c: Client) {
  if (!rtcLib) return;
  const pc = (c.pc = new rtcLib.PeerConnection('client', {
    iceServers: [],
    enableIceUdpMux: true,
    portRangeBegin: UDP_PORT,
    portRangeEnd: UDP_PORT,
    maxMessageSize: MAX_FRAME * 2,
  }));
  pc.onLocalDescription((sdp, type) => send(c, { op: 'rtc', offer: { sdp, type } }));
  pc.onLocalCandidate((candidate, mid) => send(c, { op: 'rtc', candidate: { candidate: candidate.replace(/^a=/, ''), sdpMid: mid } }));
  const dc = (c.dc = pc.createDataChannel('state', { unordered: true, maxRetransmits: 0 }));
  dc.onMessage((raw) => {
    if (typeof raw === 'string') receive(c, raw, true);
  });
}

function rtc(c: Client, f: { answer?: { sdp?: unknown }; candidate?: { candidate?: unknown; sdpMid?: unknown } }) {
  if (!c.pc) return;
  try {
    if (f.answer && typeof f.answer.sdp === 'string') c.pc.setRemoteDescription(f.answer.sdp, 'answer');
    else if (f.candidate && typeof f.candidate.candidate === 'string' && f.candidate.candidate)
      c.pc.addRemoteCandidate(f.candidate.candidate, typeof f.candidate.sdpMid === 'string' ? f.candidate.sdpMid : '0');
  } catch {}
}

/** One frame from a client, by WebSocket or (state only) by data channel. */
function receive(c: Client, raw: string, viaUdp: boolean) {
  if (c.closed) return;
  if (raw.length > MAX_FRAME || --c.budget < 0) return drop(c);
  let f: { op?: unknown; [k: string]: unknown };
  try {
    f = JSON.parse(raw);
  } catch {
    return drop(c);
  }
  if (!f || typeof f !== 'object') return drop(c);
  c.heard = Date.now();
  if (viaUdp && f.op !== 's') return;
  switch (f.op) {
    case 'ping':
      return send(c, { op: 'pong' });
    case 'find':
      return find(c, f.mode, f.code);
    case 'rtc':
      return rtc(c, f as Parameters<typeof rtc>[1]);
    case 's':
      // forwarded untouched: the receiving client checks every field
      if (c.partner && typeof f.n === 'number' && f.m && typeof f.m === 'object') sendState(c.partner, raw);
      return;
    case 'msg':
      if (c.partner && f.m && typeof f.m === 'object') send(c.partner, { op: 'msg', m: f.m });
      return;
  }
}

const http = createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
  res.end(req.url === '/health' ? 'ok' : 'not found');
});
const wss = new WebSocketServer({
  server: http,
  maxPayload: MAX_FRAME,
  verifyClient: ({ origin }: { origin: string }) => ORIGINS.length === 0 || ORIGINS.includes(origin),
});

wss.on('connection', (ws) => {
  const c: Client = { ws, partner: null, host: false, code: null, pc: null, dc: null, heard: Date.now(), budget: MAX_RATE, closed: false };
  clients.add(c);
  ws.on('message', (data, binary) => {
    if (!binary) receive(c, data.toString(), false);
  });
  ws.on('close', () => {
    drop(c);
    clients.delete(c);
  });
  ws.on('error', () => drop(c));
  try {
    startRtc(c);
  } catch (e) {
    console.error('rtc setup failed', e); // the client falls back to the WebSocket for state
  }
});

const clients = new Set<Client>();
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    c.budget = MAX_RATE;
    if (now - c.heard > SILENT_MS) drop(c);
  }
}, 1000);

http.listen(PORT, () => console.log(`duel server on :${PORT} (ws), ${rtcLib ? `udp :${UDP_PORT}` : 'no udp: state over the WebSocket'}`));
