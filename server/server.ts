/**
 * Gladiators match server: matchmaking plus a message relay between the fighters of each match.
 *
 * Two kinds of match:
 *  - free-for-all (the open queue): up to four fighters. A lobby starts by itself once four are in,
 *    or earlier once at least two are in and every one of them has voted to start;
 *  - duel (friend codes): one host waits on a code, one friend joins it, and the two may rematch.
 *
 * The server does not simulate the fight. Each client stays the authority over its own fighter
 * (see multiplayer.md); the server only groups players and forwards what each says to the others.
 * Every fighter in a match has a seat (0..3), which is also the gate they enter from.
 *
 * Each client holds:
 *  - one WebSocket (TCP), for matchmaking, WebRTC signalling and every ordered game event;
 *  - one WebRTC data channel to this server, unordered and without retransmits (SCTP over DTLS over
 *    UDP), for the many-times-a-second fighter state. A lost state packet is simply replaced by the next.
 * If the data channel never opens (UDP blocked), or UDP is switched off (no UDP_PORT), state goes
 * over the WebSocket instead.
 *
 * WebSocket frames are JSON objects with an `op`:
 *   client → server  find {mode, code?, token?, name?} · vote {on} · msg {m, to?} · s {n, m} · rtc {answer | candidate} · ping
 *                    register / login {id, name, password} · resume {id, token} · logout {token}
 *                    save {id, token, progress} · spend {id, token, stat} · buy {id, token, item} · board {id}
 *   server → client  lobby {seat, players} · start {seat, mode, players} · fail {why} · msg {m, from} · s {n, m, from}
 *                    left {seat} · rtc {offer | candidate} · pong
 *                    reply {id, ok, ...} (answers a request with an id) · profile {profile} (after a result is recorded)
 * Data channel frames are `s` frames only.
 *
 * `players` is [{seat, name, vote?}]. A `msg` with `to` goes only to that seat; otherwise to every other
 * fighter in the match.
 *
 * Accounts (accounts.ts) are optional. The server settles each bout itself: whoever sends `dead` (or
 * leaves mid-bout) is out, and the last fighter standing wins. A logged-in winner gets the win (on the
 * leaderboard) and its experience and money (career.ts) if at least one other fighter fell, guest or
 * not; each account that fell (not fled) records a loss. `dead` names the seat that dealt the last
 * blow (`by`): a logged-in slayer gets a kill's experience and money.
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

/** Fighters in a free-for-all, at most (one per gate). */
const FFA_SIZE = 4;
/** Longest name shown for a guest (accounts use their username). */
const NAME_LENGTH = 16;
/** Largest frame accepted from a client, and how many frames a second it may send before being cut off. */
const MAX_FRAME = 2000, MAX_RATE = 120;
/** A client that has said nothing (not even a ping) for this long is dropped. */
const SILENT_MS = 20000;
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
/** Logins and sign-ups per address per minute (each costs a deliberately slow password hash). Generous, since a classroom shares one address; each account also locks after repeated wrong passwords. */
const AUTH_PER_MIN = 30;

interface Match {
  mode: 'ffa' | 'duel';
  /** Fighters by seat; a seat empties when its fighter leaves. */
  seats: (Client | null)[];
  /** The fight is on (a free-for-all lobby is not started until it fills or everyone votes). */
  started: boolean;
  /** The bout in progress: who is still standing, and who fell in it (fleeing is not falling). */
  alive: Set<Client>;
  fallen: Client[];
  decided: boolean;
}

interface Client {
  ws: WebSocket;
  match: Match | null;
  seat: number;
  /** Shown to the others: the account name, or the name a guest typed. */
  name: string;
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
  /** In a lobby: has voted to start without waiting for it to fill. */
  vote: boolean;
  /** In a duel: has asked for a rematch since the last bout was decided. */
  again: boolean;
  ip: string;
}

/** The free-for-all lobby filling up right now, if any; friend-code hosts wait by code. */
let lobby: Match | null = null;
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

const members = (m: Match) => m.seats.filter((c): c is Client => !!c && !c.closed);
const roster = (m: Match, votes = false) =>
  members(m).map((c) => ({ seat: c.seat, name: c.name, ...(votes ? { vote: c.vote } : {}) }));

function newMatch(mode: Match['mode']): Match {
  return { mode, seats: [], started: false, alive: new Set(), fallen: [], decided: false };
}

/** Sit a fighter in the first free seat. */
function seat(m: Match, c: Client) {
  let i = m.seats.findIndex((x) => !x || x.closed);
  if (i < 0) i = m.seats.length;
  m.seats[i] = c;
  c.match = m;
  c.seat = i;
  c.vote = c.again = false;
}

/** Tell everyone in a lobby who is there and who has voted to start. */
function lobbyNews(m: Match) {
  const players = roster(m, true);
  for (const c of members(m)) send(c, { op: 'lobby', seat: c.seat, players });
}

/** Free-for-all lobby: full, or two or more and every one wants to go. */
function lobbyCheck(m: Match) {
  const in_ = members(m);
  if (in_.length >= FFA_SIZE || (in_.length >= 2 && in_.every((c) => c.vote))) begin(m);
  else lobbyNews(m);
}

/** A fresh bout for everyone seated. */
function bout(m: Match) {
  m.alive = new Set(members(m));
  m.fallen = [];
  m.decided = false;
  for (const c of m.alive) c.again = c.vote = false;
}

function begin(m: Match) {
  if (lobby === m) lobby = null;
  m.started = true;
  bout(m);
  const players = roster(m);
  for (const c of members(m)) send(c, { op: 'start', seat: c.seat, mode: m.mode, players });
}

/**
 * `c` is out of the bout: fell (to the fighter in seat `by`, if known), or (`fled`) left mid-bout. Once
 * one fighter stands alone, the bout is theirs. A win only pays if someone else actually fell to it, so
 * nobody farms wins off friends who leave, or off a second tab logged in as themselves.
 */
function fall(c: Client, fled = false, by?: unknown) {
  const m = c.match;
  if (!m || !m.started || m.decided || !m.alive.delete(c)) return;
  const changed = new Set<Client>();
  if (!fled) {
    m.fallen.push(c);
    const slayer = typeof by === 'number' ? m.seats[by] : undefined;
    if (slayer && slayer !== c && !slayer.closed && slayer.account && slayer.account !== c.account) {
      accounts.awardKill(slayer.account);
      changed.add(slayer);
    }
  }
  if (m.alive.size <= 1) {
    m.decided = true;
    const [winner] = m.alive;
    const beaten = m.fallen.filter((l) => !winner?.account || l.account !== winner.account);
    if (winner?.account && beaten.length > 0) {
      accounts.awardWin(winner.account);
      changed.add(winner);
    }
    if (winner) for (const l of beaten) if (l.account) {
      accounts.recordLoss(l.account);
      changed.add(l);
    }
  }
  for (const x of changed) {
    const profile = x.account && accounts.getProfile(x.account);
    if (profile) send(x, { op: 'profile', profile: { ...profile, progress: undefined } });
  }
}

/** Duels only: both have asked to fight again after a decided bout. */
function rematch(c: Client) {
  const m = c.match;
  if (!m || m.mode !== 'duel' || !m.decided) return;
  c.again = true;
  const in_ = members(m);
  if (in_.length === 2 && in_.every((x) => x.again)) bout(m);
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
  if (c.code && rooms.get(c.code) === c) rooms.delete(c.code);
  c.code = null;
}

/** Take a fighter out of their match: out of the bout if one is on, and the others are told. */
function leave(c: Client) {
  const m = c.match;
  if (!m) return;
  fall(c, true);
  if (m.seats[c.seat] === c) m.seats[c.seat] = null;
  c.match = null;
  if (!m.started) {
    if (members(m).length === 0) {
      if (lobby === m) lobby = null;
    } else lobbyCheck(m); // the ones left may all have voted already
    return;
  }
  for (const o of members(m)) send(o, { op: 'left', seat: c.seat });
}

function drop(c: Client) {
  if (c.closed) return;
  c.closed = true;
  unlist(c);
  leave(c);
  try {
    c.dc?.close();
    c.pc?.close();
  } catch {}
  c.dc = c.pc = null;
  try {
    c.ws.terminate();
  } catch {}
}

/** A guest's typed name, tidied: no control characters, collapsed spaces, capped length. */
function guestName(text: unknown) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH).trim();
}

function find(c: Client, mode: unknown, code: unknown) {
  if (c.match || c.code) return; // one search per connection
  if (mode === 'queue') {
    if (!lobby || lobby.started || members(lobby).length >= FFA_SIZE) lobby = newMatch('ffa');
    seat(lobby, c);
    lobbyCheck(lobby);
  } else if (mode === 'host' && typeof code === 'string' && CODE.test(code)) {
    if (rooms.has(code)) return send(c, { op: 'fail', why: 'taken' });
    rooms.set(code, c);
    c.code = code;
  } else if (mode === 'join' && typeof code === 'string' && CODE.test(code)) {
    const host = rooms.get(code);
    if (!host || host.closed) return send(c, { op: 'fail', why: 'missing' });
    unlist(host);
    const m = newMatch('duel');
    seat(m, host);
    seat(m, c);
    begin(m);
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
    case 'find': {
      if (f.token !== undefined) c.account = accounts.session(f.token);
      // the name the others see: an account's real name, so nobody can fight under someone else's
      const profile = c.account && accounts.getProfile(c.account);
      c.name = profile ? profile.name : guestName(f.name) || 'Gladiator';
      return find(c, f.mode, f.code);
    }
    case 'vote':
      if (c.match && !c.match.started) {
        c.vote = f.on === true;
        lobbyCheck(c.match);
      }
      return;
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
    case 's': {
      // forwarded with the sender's seat; the receiving client checks every field
      const m = c.match;
      if (!m?.started || typeof f.n !== 'number' || !f.m || typeof f.m !== 'object') return;
      const out = JSON.stringify({ op: 's', n: f.n, m: f.m, from: c.seat });
      for (const o of members(m)) if (o !== c) sendState(o, out);
      return;
    }
    case 'msg': {
      const m = c.match;
      if (!m?.started || !f.m || typeof f.m !== 'object') return;
      const t = (f.m as { t?: unknown }).t;
      if (t === 'dead') fall(c, false, (f.m as { by?: unknown }).by);
      else if (t === 'rematch') rematch(c);
      else if (t === 'leave') return leave(c);
      const frame = { op: 'msg', m: f.m, from: c.seat };
      if (typeof f.to === 'number') {
        const o = m.seats[f.to];
        if (o && o !== c && !o.closed) send(o, frame);
      } else for (const o of members(m)) if (o !== c) send(o, frame);
      return;
    }
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
    ws, match: null, seat: 0, name: '', code: null, pc: null, dc: null, heard: Date.now(), budget: MAX_RATE, closed: false,
    account: null, vote: false, again: false, ip,
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

http.listen(PORT, () => console.log(`match server on :${PORT} (ws), ${rtcLib ? `udp :${UDP_PORT}` : 'no udp: state over the WebSocket'}`));
