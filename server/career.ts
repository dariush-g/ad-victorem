// Server copy of src/career.ts (the rules only): keep the two in step.
export type StatName = 'strength' | 'stamina' | 'health' | 'agility';
export const STAT_NAMES: StatName[] = ['strength', 'stamina', 'health', 'agility'];
export const STAT_MAX = 10;

/**
 * A gladiator's career: level, experience, unspent skill points, money (gold) and the four
 * stats those points went into.
 *
 * Winning a bout earns WIN_XP and WIN_MONEY, and each opponent slain (the last blow was yours)
 * KILL_XP and KILL_MONEY. Each level takes a little more experience than the
 * last (xpToNext), and every level gained brings one skill point and LEVEL_MONEY.
 *
 * This server keeps logged-in players' careers and does the awarding, so a modified client can't
 * grant itself levels. Guests keep theirs in the browser (src/career.ts).
 */
export const WIN_XP = 100, WIN_MONEY = 50, KILL_XP = 50, KILL_MONEY = 25, LEVEL_MONEY = 100;

/** Experience needed to go from `level` to the next: 100, then 25 more for each level after. */
export const xpToNext = (level: number) => 100 + 25 * (level - 1);

export interface Career {
  level: number;
  /** Experience gathered toward the next level. */
  xp: number;
  /** Skill points not yet spent. */
  points: number;
  money: number;
  stats: Record<StatName, number>;
}

export const freshCareer = (): Career => ({ level: 1, xp: 0, points: 0, money: 0, stats: { strength: 1, stamina: 1, health: 1, agility: 1 } });

const int = (x: unknown, lo: number, hi: number, fallback: number) =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.floor(x))) : fallback;

/** Make sure a career from storage or the network is well formed: whole numbers in range, and no more points than levels earned. */
export function cleanCareer(raw: unknown): Career {
  const r = (raw ?? {}) as Partial<Career>;
  const c = freshCareer();
  c.level = int(r.level, 1, 10_000, 1);
  c.xp = int(r.xp, 0, xpToNext(c.level) - 1, 0);
  c.money = int(r.money, 0, 1e12, 0);
  for (const s of STAT_NAMES) c.stats[s] = int(r.stats?.[s], 1, STAT_MAX, 1);
  let spent = STAT_NAMES.reduce((n, s) => n + c.stats[s] - 1, 0);
  if (spent > c.level - 1) {
    // more stat raises than the level could have paid for: untrustworthy, so the stats start over
    for (const s of STAT_NAMES) c.stats[s] = 1;
    spent = 0;
  }
  c.points = c.level - 1 - spent;
  return c;
}

/** Add experience and money. Returns how many levels it brought (each one a skill point and LEVEL_MONEY). */
export function grant(c: Career, xp: number, money: number): number {
  c.money += money;
  c.xp += xp;
  let levels = 0;
  while (c.xp >= xpToNext(c.level)) {
    c.xp -= xpToNext(c.level);
    c.level++;
    c.points++;
    c.money += LEVEL_MONEY;
    levels++;
  }
  return levels;
}

/** Award a won bout. */
export const grantWin = (c: Career) => grant(c, WIN_XP, WIN_MONEY);
/** Award an opponent slain. */
export const grantKill = (c: Career) => grant(c, KILL_XP, KILL_MONEY);

/** All the experience a career has gathered, from level 1: for telling how much a reward added. */
export function totalXp(c: Career): number {
  let n = c.xp;
  for (let l = 1; l < c.level; l++) n += xpToNext(l);
  return n;
}

/** Put a skill point into a stat. False if there is no point to spend or the stat is at its cap. */
export function spendPoint(c: Career, stat: StatName): boolean {
  if (c.points <= 0 || !STAT_NAMES.includes(stat) || c.stats[stat] >= STAT_MAX) return false;
  c.stats[stat]++;
  c.points--;
  return true;
}
