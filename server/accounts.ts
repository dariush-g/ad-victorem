/**
 * Player accounts: unique usernames, passwords, saved progress, and win/loss records.
 *
 * Everything lives in one JSON file (DATA_FILE, default data/accounts.json beside the server),
 * loaded at start and rewritten shortly after each change: written to a temporary file first,
 * then renamed over the old one, so a crash mid-write never leaves a half-written file.
 *
 * Admin accounts are listed in a second file, ADMINS_FILE (default admins.json beside DATA_FILE),
 * written by `npm run make-admin` (make-admin.ts). It is read afresh at every admin login, so
 * admins can be added or changed while the server runs. Admins own every item.
 *
 * Passwords are never stored: only a scrypt hash with a random salt per account. Logging in
 * hands back a random session token; the file keeps only the token's SHA-256, so a leaked file
 * gives away neither passwords nor sessions.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanCareer, freshCareer, grantKill, grantWin, spendPoint, type Career, type StatName } from './career.js';
import { ALL_ITEMS, PRICES, STARTER, isItem } from './shop.js';

const DATA_FILE = process.env.DATA_FILE ?? 'data/accounts.json';
export const ADMINS_FILE = process.env.ADMINS_FILE ?? join(dirname(DATA_FILE), 'admins.json');
/** Bumped when everyone's gear is reset: accounts saved under an older version go back to the starting kit. */
const GEAR_VERSION = 2;

/** 3 to 16 letters, digits or underscores. Uniqueness ignores case: "Spartacus" and "spartacus" are one name. */
export const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN = 8, PASSWORD_MAX = 128;
/** Saved progress is the client's business (its inventory); the server only caps its size. */
const PROGRESS_MAX = 1500;
const SESSION_DAYS = 30;
/** After this many wrong passwords in a row, an account refuses logins for LOCK_MS. */
const MAX_FAILS = 5, LOCK_MS = 60_000;

interface Account {
  name: string;
  salt: string;
  hash: string;
  wins: number;
  losses: number;
  /** JSON text, as the client sent it, or null before the first save. */
  progress: string | null;
  /** Level, experience, skill points, money and stats. Missing on accounts made before levels existed. */
  career?: Career;
  /** Items this account owns (each at most once): the starting kit plus whatever it has bought. */
  owned?: string[];
  gearVersion?: number;
  /** Logs in through ADMINS_FILE, and owns everything. */
  admin?: boolean;
  created: number;
}
interface Store {
  accounts: Record<string, Account>;
  /** sha256(token) → which account, and when the session started. */
  sessions: Record<string, { key: string; at: number }>;
}

export interface Profile {
  name: string;
  wins: number;
  losses: number;
  progress: unknown;
  career: Career;
  owned: string[];
  admin: boolean;
}

const store: Store = load();
// gear reset: accounts from before the shop go back to the starting kit (level and gold are kept)
let resetGear = false;
for (const a of Object.values(store.accounts))
  if (a.gearVersion !== GEAR_VERSION) {
    a.owned = [...STARTER];
    a.progress = null;
    a.gearVersion = GEAR_VERSION;
    resetGear = true;
  }
const fails = new Map<string, { n: number; until: number }>();

function load(): Store {
  try {
    const s = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Store;
    if (s && typeof s.accounts === 'object' && typeof s.sessions === 'object') return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // a corrupt file must not be silently replaced by an empty one
  }
  return { accounts: {}, sessions: {} };
}

let saveTimer: NodeJS.Timeout | null = null;
function persist() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, DATA_FILE);
  }, 300);
}
/** Write any pending change now (on shutdown). */
export function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(store));
}

/** Storage key for a name. The prefix keeps names like `__proto__` from meaning anything to JavaScript objects. */
const keyOf = (name: string) => 'u:' + name.toLowerCase();
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const hashPassword = (password: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(password, salt, 64, (e, k) => (e ? rej(e) : res(k))));

const ownedBy = (a: Account) => (a.admin ? ALL_ITEMS : (a.owned ??= [...STARTER]));

function profile(a: Account): Profile {
  let progress: unknown = null;
  try {
    progress = a.progress === null ? null : JSON.parse(a.progress);
  } catch {}
  return { name: a.name, wins: a.wins, losses: a.losses, progress, career: (a.career ??= freshCareer()), owned: [...ownedBy(a)], admin: !!a.admin };
}

const newAccount = (name: string, salt: string, hash: string): Account => ({
  name, salt, hash, wins: 0, losses: 0, progress: null, career: freshCareer(), owned: [...STARTER], gearVersion: GEAR_VERSION, created: Date.now(),
});

/** Admin logins: name key → salt and scrypt hash, written by make-admin.ts. */
type Admins = Record<string, { name: string; salt: string; hash: string }>;
export function readAdmins(): Admins {
  try {
    const a = JSON.parse(readFileSync(ADMINS_FILE, 'utf8'));
    return a && typeof a === 'object' ? a : {};
  } catch {
    return {};
  }
}
export function writeAdmins(admins: Admins) {
  mkdirSync(dirname(ADMINS_FILE), { recursive: true });
  writeFileSync(`${ADMINS_FILE}.tmp`, JSON.stringify(admins, null, 2), { mode: 0o600 });
  renameSync(`${ADMINS_FILE}.tmp`, ADMINS_FILE);
}
export async function adminEntry(name: string, password: string) {
  const salt = randomBytes(16);
  return { name, salt: salt.toString('base64'), hash: (await hashPassword(password, salt)).toString('base64') };
}
export { keyOf };

function startSession(key: string): string {
  const token = randomBytes(32).toString('base64url');
  store.sessions[digest(token)] = { key, at: Date.now() };
  persist();
  return token;
}

export type AuthResult = { ok: true; token: string; key: string; profile: Profile } | { ok: false; why: string };

/**
 * `inherit`: what this player built up as a guest before signing up (career, items bought, and how
 * they were arranged), carried into the new account.
 */
export async function register(name: unknown, password: unknown, inherit?: { career?: unknown; owned?: unknown; progress?: unknown }): Promise<AuthResult> {
  if (typeof name !== 'string' || !USERNAME.test(name)) return { ok: false, why: 'bad-name' };
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return { ok: false, why: 'bad-password' };
  const key = keyOf(name);
  if (store.accounts[key] || readAdmins()[key]) return { ok: false, why: 'taken' };
  const salt = randomBytes(16);
  const hash = await hashPassword(password, salt);
  if (store.accounts[key]) return { ok: false, why: 'taken' }; // someone else took it while we were hashing
  const a = newAccount(name, salt.toString('base64'), hash.toString('base64'));
  if (inherit?.career) a.career = cleanCareer(inherit.career);
  if (Array.isArray(inherit?.owned)) a.owned = [...new Set([...STARTER, ...inherit.owned.filter(isItem)])];
  store.accounts[key] = a;
  if (inherit?.progress) saveProgress(key, inherit.progress);
  return { ok: true, token: startSession(key), key, profile: profile(a) };
}

export async function login(name: unknown, password: unknown): Promise<AuthResult> {
  if (typeof name !== 'string' || typeof password !== 'string' || password.length > PASSWORD_MAX) return { ok: false, why: 'wrong' };
  const key = keyOf(name);
  const f = fails.get(key);
  if (f && f.until > Date.now()) return { ok: false, why: 'locked' };
  const admin = readAdmins()[key];
  if (admin) {
    // admin passwords live in ADMINS_FILE; the account record (record, career, gear) is made on first login
    const hash = await hashPassword(password, Buffer.from(admin.salt, 'base64'));
    if (!timingSafeEqual(hash, Buffer.from(admin.hash, 'base64'))) {
      const n = (f?.n ?? 0) + 1;
      fails.set(key, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return { ok: false, why: 'wrong' };
    }
    fails.delete(key);
    const a = (store.accounts[key] ??= newAccount(admin.name, '', ''));
    a.admin = true;
    persist();
    return { ok: true, token: startSession(key), key, profile: profile(a) };
  }
  const a = store.accounts[key];
  // hash even for an unknown name, so the reply time doesn't reveal which names exist
  const salt = a ? Buffer.from(a.salt, 'base64') : randomBytes(16);
  const hash = await hashPassword(password, salt);
  if (!a || a.admin || !timingSafeEqual(hash, Buffer.from(a.hash, 'base64'))) {
    if (a) {
      const n = (f?.n ?? 0) + 1;
      fails.set(key, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    }
    return { ok: false, why: 'wrong' };
  }
  fails.delete(key);
  return { ok: true, token: startSession(key), key, profile: profile(a) };
}

/** The account a session token belongs to, or null if it is unknown or has expired. */
export function session(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const s = store.sessions[digest(token)];
  if (!s) return null;
  if (Date.now() - s.at > SESSION_DAYS * 86_400_000 || !store.accounts[s.key]) {
    delete store.sessions[digest(token)];
    persist();
    return null;
  }
  return s.key;
}

export function logout(token: unknown) {
  if (typeof token !== 'string') return;
  if (delete store.sessions[digest(token)]) persist();
}

export function getProfile(key: string): Profile | null {
  const a = store.accounts[key];
  return a ? profile(a) : null;
}

/** Save how the account's items are arranged. Refused if it holds anything the account doesn't own, or anything twice. */
export function saveProgress(key: string, progress: unknown): boolean {
  const a = store.accounts[key];
  if (!a) return false;
  const text = JSON.stringify(progress);
  if (typeof text !== 'string' || text.length > PROGRESS_MAX) return false;
  const p = progress as { bag?: unknown; equipped?: unknown };
  if (!p || !Array.isArray(p.bag) || !p.equipped || typeof p.equipped !== 'object') return false;
  const ids = [...p.bag.map((s) => (s as { id?: unknown } | null)?.id), ...Object.values(p.equipped)].filter((id) => id != null);
  const owned = ownedBy(a);
  if (ids.some((id) => typeof id !== 'string' || !owned.includes(id)) || new Set(ids).size !== ids.length) return false;
  a.progress = text;
  persist();
  return true;
}

/** A won bout (someone fell to it, account or guest): counts toward the leaderboard, and pays its experience and money. */
export function awardWin(key: string) {
  const a = store.accounts[key];
  if (!a) return;
  a.wins++;
  grantWin((a.career ??= freshCareer()));
  persist();
}

/** Fell in a bout someone else won. */
export function recordLoss(key: string) {
  const a = store.accounts[key];
  if (!a) return;
  a.losses++;
  persist();
}

/** Slew an opponent (the last blow was theirs): experience and money. */
export function awardKill(key: string) {
  const a = store.accounts[key];
  if (!a) return;
  grantKill((a.career ??= freshCareer()));
  persist();
}

/** Buy an item from the shop. Returns the account's profile after, or why not. Admins already own everything. */
export function buy(key: string, item: unknown): { ok: true; profile: Profile } | { ok: false; why: string } {
  const a = store.accounts[key];
  if (!a) return { ok: false, why: 'expired' };
  if (typeof item !== 'string' || !Object.hasOwn(PRICES, item)) return { ok: false, why: 'not-for-sale' };
  const owned = ownedBy(a), c = (a.career ??= freshCareer());
  if (owned.includes(item)) return { ok: false, why: 'owned' };
  if (c.money < PRICES[item]) return { ok: false, why: 'poor' };
  c.money -= PRICES[item];
  owned.push(item);
  persist();
  return { ok: true, profile: profile(a) };
}

/** Spend a skill point. Returns the career after, or null if it couldn't be spent. */
export function spend(key: string, stat: unknown): Career | null {
  const a = store.accounts[key];
  if (!a || typeof stat !== 'string') return null;
  const c = (a.career ??= freshCareer());
  if (!spendPoint(c, stat as StatName)) return null;
  persist();
  return c;
}

/** The accounts with the most wins (at least one), best first; ties go to fewer losses, then the older account. */
export function leaderboard(n = 10): { name: string; wins: number }[] {
  return Object.values(store.accounts)
    .filter((a) => a.wins > 0)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.created - b.created)
    .slice(0, n)
    .map((a) => ({ name: a.name, wins: a.wins }));
}

/** Drop expired sessions now and then, so the file doesn't grow for ever. */
setInterval(() => {
  const cutoff = Date.now() - SESSION_DAYS * 86_400_000;
  let changed = false;
  for (const [k, s] of Object.entries(store.sessions))
    if (s.at < cutoff) {
      delete store.sessions[k];
      changed = true;
    }
  if (changed) persist();
}, 3_600_000).unref();

if (resetGear) persist();
