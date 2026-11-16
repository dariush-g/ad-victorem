import type { Database } from 'firebase/database';

/**
 * Fallback transport for when two browsers cannot reach each other directly (strict NATs: phone
 * networks, offices, some routers). Messages go through Firebase Realtime Database instead:
 *
 *   relay/<key>/h   what the host writes      relay/<key>/g   what the guest writes
 *     on            true while connected (removed on disconnect, which tells the other side)
 *     s             latest fighter state ('s' messages: only the newest matters, so it is overwritten).
 *                   Stored with a counter: the database only reports writes that change the value, and a
 *                   fighter standing still sends the same state over and over.
 *     q/<push id>   every other message, in order
 *
 * The key is the guest's PeerJS id, a random UUID both sides already know after the broker
 * introduced them. Messages are stored as JSON strings so the database never reshapes them
 * (it drops nulls and turns arrays into objects).
 *
 * Firebase is loaded only when a relay is actually needed, and its connection is dropped again
 * when no relay is open, so direct matches never touch it.
 */
const DATABASE_URL = import.meta.env.VITE_FIREBASE_DATABASE_URL ?? '';

export const relayAvailable = DATABASE_URL !== '';

type DB = { db: Database; mod: typeof import('firebase/database') };
let loading: Promise<DB> | null = null;
function load(): Promise<DB> {
  return (loading ??= (async () => {
    const [{ initializeApp }, mod] = await Promise.all([import('firebase/app'), import('firebase/database')]);
    const db = mod.getDatabase(initializeApp({ databaseURL: DATABASE_URL }, 'relay'));
    return { db, mod };
  })());
}

let openCount = 0;

export interface Pipe {
  send(m: { t: string }): void;
  close(): void;
}

/** Join the relay room `key` as host or guest. Usable at once: sends made before Firebase is ready wait for it. */
export function openRelay(key: string, side: 'h' | 'g', on: { message(m: unknown): void; gone(): void }): Pipe {
  let closed = false;
  const backlog: { t: string }[] = [];
  let write: ((m: { t: string }) => void) | null = null;
  const stops: (() => void)[] = [];
  let leave: (() => void) | null = null;

  openCount++;
  load()
    .then(({ db, mod }) => {
      if (closed) return;
      if (openCount === 1) mod.goOnline(db);
      const mine = mod.ref(db, `relay/${key}/${side}`);
      const theirs = mod.ref(db, `relay/${key}/${side === 'h' ? 'g' : 'h'}`);
      void mod.onDisconnect(mine).remove();
      void mod.set(mod.child(mine, 'on'), true);
      leave = () => void mod.remove(mine);

      const parse = (raw: unknown) => {
        if (closed || typeof raw !== 'string') return;
        try {
          on.message(JSON.parse(raw));
        } catch {}
      };
      stops.push(
        mod.onValue(mod.child(theirs, 's'), (snap) => {
          const raw = snap.val();
          if (typeof raw === 'string') parse(raw.slice(raw.indexOf('|') + 1));
        }),
      );
      stops.push(mod.onChildAdded(mod.child(theirs, 'q'), (snap) => parse(snap.val())));
      let seen = false;
      stops.push(
        mod.onValue(mod.child(theirs, 'on'), (snap) => {
          if (snap.val() === true) seen = true;
          else if (seen && !closed) on.gone();
        }),
      );

      let seq = 0;
      write = (m) => {
        const raw = JSON.stringify(m);
        if (m.t === 's') void mod.set(mod.child(mine, 's'), `${seq++}|${raw}`);
        else void mod.push(mod.child(mine, 'q'), raw);
      };
      for (const m of backlog.splice(0)) write(m);
    })
    .catch(() => {
      if (!closed) on.gone();
    });

  return {
    send(m) {
      if (closed) return;
      if (write) write(m);
      else backlog.push(m);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const stop of stops) stop();
      leave?.();
      if (--openCount === 0)
        void load().then(({ db, mod }) => {
          // let the removal reach the server before going quiet
          window.setTimeout(() => openCount === 0 && mod.goOffline(db), 1000);
        });
    },
  };
}
