import { Peer, type DataConnection } from 'peerjs';
import type { AttackKind } from './gladiator';
import type { Zone } from './hits';

/**
 * One-on-one matchmaking and messaging, peer to peer over WebRTC.
 *
 * There is no game server. Players meet through a single well-known id on the public PeerJS
 * broker: whoever claims it waits there as host; whoever finds it taken dials it as guest.
 * Once two are paired the host lets go of the id, so the next player to search can claim it.
 * After that the broker is out of the picture and everything travels over the data channel.
 */
const QUEUE_ID = 'ad-victorem-v1-duel-queue';

export type Msg =
  | { t: 'gear'; gear: Record<string, string | null> }
  /** Fighter state, sent many times a second: position, velocity, facing, aim, move direction, flag bits, health 0..1. */
  | { t: 's'; p: number[]; v: number[]; f: number; a: number; m: number[]; b: number; hp: number }
  | { t: 'atk'; k: AttackKind; f: number }
  | { t: 'jump' }
  /** A blow landed on `zone`: raw damage before the victim's armour, how sharp the weapon is, and the push direction. */
  | { t: 'hit'; zone: Zone; d: number; edge: number; x: number; z: number }
  | { t: 'dead' };

export interface Link {
  /** The host fights from the north gate, the guest from the south. */
  readonly host: boolean;
  send(m: Msg): void;
}

export interface Search {
  /** Stop searching, or hang up on the opponent. Fires no callbacks. */
  close(): void;
}

export function findOpponent(on: { found(link: Link): void; message(m: Msg): void; lost(): void }): Search {
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

  /** Try to take the queue id and wait there for someone to dial in. */
  function wait() {
    const p = (peer = new Peer(QUEUE_ID));
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
        dial();
      } else retry();
    });
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
      else retry();
    };
    const giveUp = window.setTimeout(() => settle(false), 8000);
    p.on('open', () => {
      const c = p.connect(QUEUE_ID, { reliable: true, serialization: 'json' });
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

  wait();
  return { close };
}
