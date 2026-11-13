import { Peer, type DataConnection } from 'peerjs';
import type { AttackKind } from './gladiator';
import type { Zone } from './hits';

/**
 * One-on-one matchmaking and messaging, peer to peer over WebRTC.
 *
 * There is no game server. Players meet through well-known ids on the public PeerJS broker:
 *  - the open queue: one shared id. Whoever claims it waits there as host; whoever finds it
 *    taken dials it as guest. Once paired the host lets go of the id for the next pair.
 *  - friend codes: the host claims an id made from a short code and waits; the friend dials it.
 * After pairing the broker is out of the picture and everything travels over the data channel.
 */
const QUEUE_ID = 'ad-victorem-v1-duel-queue';
const ROOM_PREFIX = 'ad-victorem-v1-room-';

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
/** Why a search gave up: the code is already in use (host should pick another), or nobody is waiting on it. */
export type Failure = 'taken' | 'missing';

export type Msg =
  /** Sent once on pairing: the fighter's name and what they wear. */
  | { t: 'gear'; gear: Record<string, string | null>; name?: string }
  /** Fighter state, sent many times a second: position, velocity, facing, aim, move direction, flag bits, health 0..1. */
  | { t: 's'; p: number[]; v: number[]; f: number; a: number; m: number[]; b: number; hp: number }
  | { t: 'atk'; k: AttackKind; f: number; aim: number }
  | { t: 'jump' }
  /** A blow landed on `zone`: raw damage before the victim's armour, how sharp the weapon is, and the push direction. */
  | { t: 'hit'; zone: Zone; d: number; edge: number; x: number; z: number }
  | { t: 'dead' }
  /** Wants to fight again on the same connection. */
  | { t: 'rematch' }
  /** Has left for good (back to the room, or a new opponent). */
  | { t: 'leave' };

export interface Link {
  /** The host fights from the north gate, the guest from the south. */
  readonly host: boolean;
  send(m: Msg): void;
}

export interface Search {
  /** Stop searching, or hang up on the opponent (after `graceMs`, to let a last message out). Fires no callbacks. */
  close(graceMs?: number): void;
}

export function findOpponent(mode: Mode, on: { found(link: Link): void; message(m: Msg): void; lost(): void; failed(why: Failure): void }): Search {
  let peer: Peer | null = null, conn: DataConnection | null = null;
  let closed = false, matched = false, timer = 0;

  const adopt = (c: DataConnection, host: boolean) => {
    matched = true;
    conn = c;
    if (host) peer?.disconnect(); // leaves the data channel up, frees the queue id for the next pair
    c.on('data', (d) => {
      if (!closed && d && typeof d === 'object' && (d as Msg).t !== undefined) on.message(d as Msg);
    });
    const drop = () => {
      if (closed) return;
      close();
      on.lost();
    };
    c.on('close', drop);
    c.on('error', drop);
    on.found({ host, send: (m) => void (c.open && c.send(m)) });
  };

  const retry = () => {
    peer?.destroy();
    peer = null;
    if (!closed && !matched) timer = window.setTimeout(wait, 600 + Math.random() * 900);
  };

  /** Try to take the meeting id and wait there for someone to dial in. */
  function wait() {
    const p = (peer = new Peer(mode.kind === 'host' ? ROOM_PREFIX + mode.code : QUEUE_ID));
    p.on('connection', (c) => {
      if (matched) {
        // a second caller arrived before the id was released: send them round again
        c.on('open', () => {
          c.send({ t: 'busy' });
          window.setTimeout(() => c.close(), 300);
        });
        return;
      }
      matched = true;
      // a caller who never finishes connecting must not hold the queue for ever
      const stale = window.setTimeout(() => {
        matched = false;
        c.close();
      }, 8000);
      c.on('open', () => {
        clearTimeout(stale);
        if (closed) return;
        c.send({ t: 'ok' });
        adopt(c, true);
      });
    });
    p.on('error', (e) => {
      if (closed || matched) return;
      if (e.type === 'unavailable-id') {
        p.destroy();
        if (mode.kind === 'host') fail('taken');
        else dial();
      } else retry();
    });
  }

  function fail(why: Failure) {
    if (closed || matched) return;
    close();
    on.failed(why);
  }

  /** Someone is already waiting: call them. */
  function dial() {
    if (closed) return;
    const p = (peer = new Peer());
    let settled = false;
    const settle = (ok: boolean, c?: DataConnection) => {
      if (settled || closed) return;
      settled = true;
      clearTimeout(giveUp);
      if (ok && c) adopt(c, false);
      else if (mode.kind === 'join') fail('missing');
      else retry();
    };
    const giveUp = window.setTimeout(() => settle(false), 8000);
    p.on('open', () => {
      const c = p.connect(mode.kind === 'join' ? ROOM_PREFIX + mode.code : QUEUE_ID, { reliable: true, serialization: 'json' });
      c.on('data', (d) => settle((d as { t?: string })?.t === 'ok', c));
      c.on('error', () => settle(false));
    });
    p.on('error', () => settle(false));
  }

  function close() {
    closed = true;
    clearTimeout(timer);
    conn?.close();
    peer?.destroy();
    peer = conn = null;
  }

  if (mode.kind === 'join') dial();
  else wait();
  return {
    close(graceMs = 0) {
      // a short grace lets a parting message ('leave') get out before the channel shuts
      if (graceMs > 0) {
        closed = true;
        window.setTimeout(close, graceMs);
      } else close();
    },
  };
}
