import type { MoveKind } from './gladiator';
import type { Zone } from './hits';

/**
 * One-on-one matchmaking and messaging through the duel server (server/server.ts).
 *
 * The server pairs players (the open queue, or a friend by code) and forwards what each says to
 * the other. It does not run the fight: each side stays the authority over its own fighter.
 *
 * Two connections to the server:
 *  - a WebSocket (TCP): matchmaking, WebRTC signalling, and every game event, in order;
 *  - a WebRTC data channel the server offers, unordered and never retransmitted (SCTP over DTLS over
 *    UDP): the fighter state sent many times a second, where only the newest matters. If it never
 *    opens (UDP blocked on this network), state goes over the WebSocket too.
 */
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? `ws://${location.hostname || 'localhost'}:8080`;

/** For the browser's side of the data channel. The server has a public address, so STUN is only a help. */
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/** Friend codes: 5 characters with no look-alikes (no 0/O, 1/I/L). */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
export function makeCode() {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
/** Tidy what a player typed into a code, or null if it can't be one. */
export function cleanCode(text: string): string | null {
  const c = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_CHARS.includes(ch)) ? c : null;
}

export const NAME_LENGTH = 16;
/** Tidy a fighter's name (typed here, or sent by the other side): no control characters, collapsed spaces, capped length. */
export function cleanName(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH).trim();
}

/** How to find the opponent: anyone in the open queue, or a friend by code (as the one who made it, or the one joining). */
export type Mode = { kind: 'queue' } | { kind: 'host'; code: string } | { kind: 'join'; code: string };
/** Why a search gave up: the code is already in use (host should pick another), nobody is waiting on it, or the server could not be reached. */
export type Failure = 'taken' | 'missing' | 'unreachable';

export type Msg =
  /** Sent once on pairing: the fighter's name and what they wear. */
  | { t: 'gear'; gear: Record<string, string | null>; name?: string }
  /** Fighter state, sent many times a second: position, velocity, facing, aim, move direction, flag bits, health 0..1. */
  | { t: 's'; p: number[]; v: number[]; f: number; a: number; m: number[]; b: number; hp: number }
  /** Started a move (attack, dodge, parry, or reeling from a blow): its kind, facing, aim height, and a dodge's direction. */
  | { t: 'atk'; k: MoveKind; f: number; aim: number; d: number }
  /** Let go of a charging heavy blow. */
  | { t: 'rel' }
  /** A blow landed on `zone`: raw damage before the victim's armour, how sharp the weapon is, and the push direction. */
  | { t: 'hit'; zone: Zone; d: number; edge: number; x: number; z: number; poise: number }
  /** Your blow was turned aside by a parry: reel, open to a riposte. */
  | { t: 'parried' }
  /** Your blow landed on a raised guard and bounced off. */
  | { t: 'blocked' }
  | { t: 'dead' }
  /** Wants to fight again on the same connection. */
  | { t: 'rematch' }
  /** Has left for good (back to the room, or a new opponent). */
  | { t: 'leave' };

export interface Link {
  /** The host fights from the north gate, the guest from the south. */
  readonly host: boolean;
  /** The opponent's account name, vouched for by the server; null for a guest (then only their `gear` name is known). */
  readonly foe: string | null;
  send(m: Msg): void;
}

export interface Search {
  /** Stop searching, or hang up on the opponent (after `graceMs`, to let a last message out). Fires no callbacks. */
  close(graceMs?: number): void;
}

/**
 * Keep-alive: a ping to the server every second, and a link that has heard nothing at all for
 * `SILENT_MS` is treated as dropped. Pausing (a hidden tab, a minimised window) stops the game
 * loop but not the pings, so a paused player stays in the match. A closed tab is noticed at once
 * through the server; this only catches connections that die quietly.
 */
const PING_MS = 1000, SILENT_MS = 20000;

/**
 * A once-a-second tick that keeps going in a background tab. Browsers slow page timers in hidden
 * tabs to once a minute after a while; timers inside a worker are left alone.
 */
function ticker(tick: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${PING_MS});`], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = tick;
    return () => worker.terminate();
  } catch {
    const id = window.setInterval(tick, PING_MS);
    return () => clearInterval(id);
  }
}

type Frame = { op?: unknown; [k: string]: unknown };

/** Callbacks for a search, plus `token` (a logged-in session) so the server can record the result. */
export function findOpponent(
  mode: Mode,
  on: { found(link: Link): void; message(m: Msg): void; lost(): void; failed(why: Failure): void; profile?(p: unknown): void },
  token: string | null = null,
): Search {
  let closed = false, matched = false;
  let heard = performance.now();
  let pc: RTCPeerConnection | null = null, dc: RTCDataChannel | null = null;
  /** State numbering: the data channel may deliver out of order, so older states are dropped. */
  let sentN = 0, seenN = -1;
  /** Signalling steps run one after another: a candidate must wait for the offer it belongs to. */
  let signalling: Promise<unknown> = Promise.resolve();

  const ws = new WebSocket(SERVER_URL);
  const stopTicker = ticker(() => {
    if (closed) return;
    if (performance.now() - heard > SILENT_MS) return end();
    if (ws.readyState === WebSocket.OPEN) ws.send('{"op":"ping"}');
  });
  const out = (f: object) => {
    if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  };

  /** The connection is gone: before pairing that is a failed search, after it a lost opponent. */
  function end() {
    if (closed) return;
    const wasMatched = matched;
    close();
    if (wasMatched) on.lost();
    else on.failed('unreachable');
  }

  function state(f: Frame) {
    if (!matched || typeof f.n !== 'number' || f.n <= seenN || !f.m || typeof f.m !== 'object') return;
    seenN = f.n;
    on.message(f.m as Msg);
  }

  function frame(raw: unknown) {
    if (closed || typeof raw !== 'string') return;
    let f: Frame;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (!f || typeof f !== 'object') return;
    heard = performance.now();
    switch (f.op) {
      case 'paired':
        if (matched) return;
        matched = true;
        on.found({ host: f.host === true, foe: typeof f.foe === 'string' ? f.foe : null, send });
        return;
      case 'fail':
        if (matched) return;
        close();
        on.failed(f.why === 'taken' || f.why === 'missing' ? f.why : 'unreachable');
        return;
      case 'msg':
        if (matched && f.m && typeof f.m === 'object') on.message(f.m as Msg);
        return;
      case 's':
        return state(f);
      case 'gone':
        return end();
      case 'profile':
        on.profile?.(f.profile);
        return;
      case 'rtc':
        return rtc(f);
    }
  }

  /** The server offers the state channel; answer it. Failure here only means state stays on the WebSocket. */
  function rtc(f: Frame) {
    const offer = f.offer as RTCSessionDescriptionInit | undefined;
    const cand = f.candidate as RTCIceCandidateInit | undefined;
    signalling = signalling
      .then(async () => {
        if (closed) return;
        if (offer && typeof offer.sdp === 'string') {
          pc?.close();
          const p = (pc = new RTCPeerConnection(RTC_CONFIG));
          p.onicecandidate = (e) => e.candidate && out({ op: 'rtc', candidate: e.candidate.toJSON() });
          p.ondatachannel = (e) => {
            dc = e.channel;
            dc.onmessage = (m) => {
              if (closed || typeof m.data !== 'string') return;
              try {
                const sf = JSON.parse(m.data);
                if (sf && sf.op === 's') {
                  heard = performance.now();
                  state(sf);
                }
              } catch {}
            };
          };
          await p.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
          await p.setLocalDescription(await p.createAnswer());
          out({ op: 'rtc', answer: { type: 'answer', sdp: p.localDescription?.sdp } });
        } else if (cand && pc) await pc.addIceCandidate(cand);
      })
      .catch(() => {});
  }

  function send(m: Msg) {
    if (closed) return;
    if (m.t !== 's') return out({ op: 'msg', m });
    const raw = JSON.stringify({ op: 's', n: sentN++, m });
    if (dc?.readyState === 'open') {
      try {
        return dc.send(raw);
      } catch {}
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }

  ws.onopen = () =>
    out({ op: 'find', mode: mode.kind, ...(mode.kind === 'queue' ? {} : { code: mode.code }), ...(token ? { token } : {}) });
  ws.onmessage = (e) => frame(e.data);
  ws.onclose = end;
  ws.onerror = end;

  function close() {
    closed = true;
    stopTicker();
    ws.onclose = ws.onerror = ws.onmessage = null;
    ws.close();
    dc?.close();
    pc?.close();
    dc = pc = null;
  }

  return {
    close(graceMs = 0) {
      // a short grace lets a parting message ('leave') get out before the connection shuts
      if (graceMs > 0) {
        if (closed) return;
        closed = true; // no more callbacks, but the socket stays open a moment
        window.setTimeout(() => {
          closed = false;
          close();
        }, graceMs);
      } else close();
    },
  };
}
