/**
 * Gladiators duel server: matchmaking plus a message relay between the two fighters of each pair.
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
 *   client → server  find {mode, code?, token?} · msg {m} · s {n, m} · rtc {answer | candidate} · ping
 *                    register / login {id, name, password} · resume {id, token} · logout {token}
 *                    save {id, token, progress} · spend {id, token, stat} · buy {id, token, item} · board {id}
 *   server → client  paired {host, foe} · fail {why} · msg {m} · s {n, m} · rtc {offer | candidate} · gone · pong
 *                    reply {id, ok, ...} (answers a request with an id) · profile {profile} (after a result is recorded)
 * Data channel frames are `s` frames only.
 *
 * Accounts (accounts.ts) are optional. The server settles each bout itself: whoever sends `dead`
 * lost it, their partner won. A logged-in winner gets the win's experience and money (career.ts);
 * the win and loss count toward the leaderboard only when both fighters are different accounts.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PeerConnection, DataChannel } from 'node-datachannel';
import * as accounts from './accounts.js';

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
/** Logins and sign-ups per address per minute (each costs a deliberately slow password hash). Generous, since a classroom shares one address; each account also locks after repeated wrong passwords. */
const AUTH_PER_MIN = 30;

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
  /** The account this connection is logged in as, if any. */
  account: string | null;
  /** The bout in progress, shared with the partner: decided once someone falls. */
  bout: { decided: boolean } | null;
  /** Has asked for a rematch since the last bout was decided. */
  again: boolean;
  ip: string;
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
  host.bout = guest.bout = { decided: false };
  host.again = guest.again = false;
  // the opponent's real account name, so nobody can fight under someone else's
  const nameOf = (c: Client) => (c.account ? accounts.getProfile(c.account)?.name ?? null : null);
  send(host, { op: 'paired', host: true, foe: nameOf(guest) });
  send(guest, { op: 'paired', host: false, foe: nameOf(host) });
}

/** `loser` says they fell: the bout is over. */
function settle(loser: Client) {
  const winner = loser.partner;
  if (!winner || !loser.bout || loser.bout.decided) return;
  loser.bout.decided = true;
  if (!winner.account || winner.account === loser.account) return; // a guest's win is theirs to count, locally
  accounts.awardWin(winner.account);
  if (loser.account) accounts.recordResult(winner.account, loser.account);
  for (const c of [winner, loser]) {
    const profile = c.account && accounts.getProfile(c.account);
    if (profile) send(c, { op: 'profile', profile: { ...profile, progress: undefined } });
  }
}

/** Both have asked to fight again after a decided bout: a fresh bout on the same pairing. */
function rematch(c: Client) {
  const p = c.partner;
  if (!p || !c.bout?.decided) return;
  c.again = true;
  if (p.again) {
    c.bout = p.bout = { decided: false };
    c.again = p.again = false;
  }
}

const authUse = new Map<string, { n: number; reset: number }>();
function authAllowed(ip: string) {
  const now = Date.now();
  let u = authUse.get(ip);
  if (!u || u.reset < now) authUse.set(ip, (u = { n: 0, reset: now + 60_000 }));
  return ++u.n <= AUTH_PER_MIN;
}

/** Account requests: each carries an `id`, echoed in the reply. */
async function accountOp(c: Client, f: { op?: unknown; [k: string]: unknown }) {
  const id = typeof f.id === 'number' ? f.id : 0;
  const reply = (r: object) => send(c, { op: 'reply', id, ...r });
  switch (f.op) {
    case 'register':
    case 'login': {
      if (!authAllowed(c.ip)) return reply({ ok: false, why: 'slow-down' });
      const inherit = { career: f.career, owned: f.owned, progress: f.progress };
      const r = await (f.op === 'register' ? accounts.register(f.name, f.password, inherit) : accounts.login(f.name, f.password));
      if (!r.ok) return reply(r);
      c.account = r.key;
      return reply({ ok: true, token: r.token, profile: r.profile });
    }
    case 'resume': {
      const key = accounts.session(f.token);
      const profile = key && accounts.getProfile(key);
      if (!key || !profile) return reply({ ok: false, why: 'expired' });
      c.account = key;
      return reply({ ok: true, profile });
    }
    case 'logout':
      accounts.logout(f.token);
      c.account = null;
      return;
    case 'save': {
      const key = accounts.session(f.token);
      return reply({ ok: !!key && accounts.saveProgress(key, f.progress) });
    }
    case 'spend': {
      const key = accounts.session(f.token);
      const career = key && accounts.spend(key, f.stat);
      return reply(career ? { ok: true, career } : { ok: false });
    }
    case 'buy': {
      const key = accounts.session(f.token);
      return reply(key ? accounts.buy(key, f.item) : { ok: false, why: 'expired' });
    }
    case 'board':
      return reply({ ok: true, top: accounts.leaderboard(10) });
  }
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
      if (f.token !== undefined) c.account = accounts.session(f.token);
      return find(c, f.mode, f.code);
    case 'register':
    case 'login':
    case 'resume':
    case 'logout':
    case 'save':
    case 'spend':
    case 'buy':
    case 'board':
      void accountOp(c, f).catch((e) => console.error('account request failed', e));
      return;
    case 'rtc':
      return rtc(c, f as Parameters<typeof rtc>[1]);
    case 's':
      // forwarded untouched: the receiving client checks every field
      if (c.partner && typeof f.n === 'number' && f.m && typeof f.m === 'object') sendState(c.partner, raw);
      return;
    case 'msg':
      if (c.partner && f.m && typeof f.m === 'object') {
        const t = (f.m as { t?: unknown }).t;
        if (t === 'dead') settle(c);
        else if (t === 'rematch') rematch(c);
        send(c.partner, { op: 'msg', m: f.m });
      }
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

wss.on('connection', (ws, req) => {
  // behind the box's proxy every connection comes from localhost: the real address is in X-Forwarded-For
  const local = /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress ?? '');
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = (local && forwarded) || req.socket.remoteAddress || '?';
  const c: Client = {
    ws, partner: null, host: false, code: null, pc: null, dc: null, heard: Date.now(), budget: MAX_RATE, closed: false,
    account: null, bout: null, again: false, ip,
  };
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

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    accounts.flush();
    process.exit(0);
  });

http.listen(PORT, () => console.log(`duel server on :${PORT} (ws), ${rtcLib ? `udp :${UDP_PORT}` : 'no udp: state over the WebSocket'}`));
