import { SERVER_URL } from './net';
import { cleanCareer, freshCareer, spendPoint, type Career } from './career';
import { ALL_GEAR, STARTER } from './items';
import type { StatName } from './stats';

/**
 * The player's account on the duel server: log in or sign up with a username and password, and
 * the server keeps their progress and win/loss record. Without one they play as a guest and
 * nothing is saved.
 *
 * Requests go over a short-lived WebSocket to the same server as matchmaking, opened when needed
 * and closed again after a little while idle. Each request carries an id that its reply echoes.
 * The session token is kept in localStorage, so a returning player is logged straight back in.
 */
export const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN = 8;

export interface Profile {
  name: string;
  wins: number;
  losses: number;
  /** Whatever was last saved (the inventory); null for a new account. */
  progress?: unknown;
  career: Career;
  /** Items owned: the starting kit plus purchases (everything, for an admin). */
  owned: string[];
  admin: boolean;
}

type Reply = { ok: boolean; why?: string; [k: string]: unknown };

const TOKEN_KEY = 'gladiators-session';
const TIMEOUT_MS = 10_000, IDLE_MS = 30_000;

let sock: WebSocket | null = null, opening: Promise<WebSocket> | null = null, idle = 0, nextId = 1;
const waiting = new Map<number, (r: Reply) => void>();

function connect(): Promise<WebSocket> {
  if (sock?.readyState === WebSocket.OPEN) return Promise.resolve(sock);
  return (opening ??= new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => {
      opening = null;
      sock = ws;
      res(ws);
    };
    ws.onerror = ws.onclose = () => {
      opening = null;
      if (sock === ws) sock = null;
      rej(new Error('unreachable'));
      for (const done of waiting.values()) done({ ok: false, why: 'unreachable' });
      waiting.clear();
    };
    ws.onmessage = (e) => {
      try {
        const f = JSON.parse(String(e.data));
        if (f?.op === 'reply' && typeof f.id === 'number') {
          waiting.get(f.id)?.(f);
          waiting.delete(f.id);
        }
      } catch {}
    };
  }));
}

async function call(op: string, body: object = {}): Promise<Reply> {
  let ws: WebSocket;
  try {
    ws = await connect();
  } catch {
    return { ok: false, why: 'unreachable' };
  }
  clearTimeout(idle);
  idle = window.setTimeout(() => {
    if (waiting.size === 0) sock?.close();
  }, IDLE_MS);
  const id = nextId++;
  return new Promise<Reply>((res) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      res({ ok: false, why: 'unreachable' });
    }, TIMEOUT_MS);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      res(r);
    });
    ws.send(JSON.stringify({ op, id, ...body }));
  });
}

const store = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

const asProfile = (p: unknown): Profile | null => {
  const o = p as Profile;
  if (!o || typeof o.name !== 'string' || typeof o.wins !== 'number' || typeof o.losses !== 'number') return null;
  const owned = Array.isArray(o.owned) ? o.owned.filter((x): x is string => typeof x === 'string') : [...STARTER];
  return { ...o, career: cleanCareer(o.career), owned, admin: o.admin === true };
};

/** A message for the player for each way a login or sign-up can fail. */
export const REASONS: Record<string, string> = {
  'bad-name': 'Usernames are 3–16 letters, numbers or _',
  'bad-password': `Passwords need at least ${PASSWORD_MIN} characters`,
  taken: 'That username is taken',
  wrong: 'Wrong username or password',
  locked: 'Too many wrong passwords: wait a minute',
  'slow-down': 'Too many attempts: wait a minute',
  unreachable: 'Could not reach the server',
  poor: 'Not enough gold',
  owned: 'You already own that',
  'not-for-sale': 'That is not for sale',
  expired: 'Your session has expired: log in again',
};

/**
 * Development builds only (`npm run dev`): log in as admin without the server, with the password
 * in .env.development.local (VITE_DEV_ADMIN_PASSWORD, never committed). Production builds compile
 * this away entirely, so the password never reaches the public site.
 */
function offlineAdmin(name: string, password: string): Profile | null {
  if (!import.meta.env.DEV) return null;
  const expected = import.meta.env.VITE_DEV_ADMIN_PASSWORD;
  if (!expected || name.toLowerCase() !== 'admin' || password !== expected) return null;
  return { name: 'admin', wins: 0, losses: 0, progress: null, career: freshCareer(), owned: [...ALL_GEAR], admin: true };
}

export const account = {
  token: store.get(),
  profile: null as Profile | null,
  /** Logged in as the offline admin (development only): nothing goes to the server. */
  offline: false,
  /** Called whenever the player logs in or out, or their record changes. */
  onChange: () => {},

  get loggedIn() {
    return this.profile !== null && this.token !== null;
  },

  /** Log in, or sign up carrying over what the guest built up. Returns why it failed, or null. */
  async enter(
    op: 'login' | 'register', name: string, password: string,
    inherit?: { career: Career; owned: string[]; progress: unknown },
  ): Promise<string | null> {
    const r = await call(op, op === 'register' ? { name, password, ...inherit } : { name, password });
    if (r.why === 'unreachable' && op === 'login') {
      const admin = offlineAdmin(name, password);
      if (admin) {
        this.offline = true;
        this.token = 'offline';
        this.profile = admin;
        this.onChange();
        return null;
      }
    }
    const profile = asProfile(r.profile);
    if (!r.ok || typeof r.token !== 'string' || !profile) return REASONS[r.why ?? ''] ?? 'Something went wrong';
    this.offline = false;
    this.token = r.token;
    store.set(r.token);
    this.profile = profile;
    this.onChange();
    return null;
  },

  /** Log back in with the saved session, if there is one. */
  async resume(): Promise<boolean> {
    if (!this.token) return false;
    const r = await call('resume', { token: this.token });
    const profile = asProfile(r.profile);
    if (!r.ok || !profile) {
      if (r.why === 'expired') {
        this.token = null;
        store.set(null);
      }
      return false;
    }
    this.profile = profile;
    this.onChange();
    return true;
  },

  logout() {
    if (this.token && !this.offline) void call('logout', { token: this.token });
    this.offline = false;
    this.token = this.profile = null;
    store.set(null);
    this.onChange();
  },

  /** Save progress to the account (no-op as a guest). */
  async save(progress: unknown): Promise<boolean> {
    if (!this.loggedIn || this.offline) return false;
    return (await call('save', { token: this.token, progress })).ok;
  },

  /** The server settled a bout: take the new record and career. */
  update(p: unknown) {
    const profile = asProfile(p);
    if (!profile || !this.profile || profile.name !== this.profile.name) return;
    this.profile = { ...this.profile, wins: profile.wins, losses: profile.losses, career: profile.career };
    this.onChange();
  },

  /** Spend a skill point; the server checks there is one to spend. */
  async spend(stat: StatName): Promise<boolean> {
    if (!this.loggedIn || !this.profile) return false;
    if (this.offline) {
      if (!spendPoint(this.profile.career, stat)) return false;
      this.onChange();
      return true;
    }
    const r = await call('spend', { token: this.token, stat });
    if (!r.ok || !this.profile) return false;
    this.profile = { ...this.profile, career: cleanCareer(r.career) };
    this.onChange();
    return true;
  },
};

/** Buy an item from the shop with the account's gold. Returns why it failed, or null. */
export async function buyItem(item: string): Promise<string | null> {
  if (!account.loggedIn || !account.profile) return 'Not logged in';
  if (account.offline) return account.profile.owned.includes(item) ? REASONS.owned : null;
  const r = await call('buy', { token: account.token, item });
  const profile = asProfile(r.profile);
  if (!r.ok || !profile) return REASONS[r.why ?? ''] ?? 'Something went wrong';
  account.profile = { ...account.profile, career: profile.career, owned: profile.owned };
  account.onChange();
  return null;
}

/** The accounts with the most wins, best first. */
export async function fetchLeaderboard(): Promise<{ name: string; wins: number }[] | null> {
  const r = await call('board');
  if (!r.ok || !Array.isArray(r.top)) return null;
  return r.top.filter((e): e is { name: string; wins: number } => e && typeof e.name === 'string' && typeof e.wins === 'number');
}
