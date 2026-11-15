export type StatName = 'strength' | 'stamina' | 'health' | 'agility';
export const STAT_NAMES: StatName[] = ['strength', 'stamina', 'health', 'agility'];
export const STAT_MAX = 10;

// --- tuning ---
const BASE = 1; // starting level: every formula is neutral here
const STAMINA_REGEN = 30, STAMINA_DELAY = 0.7; // per second, after this long without effort
const EMPTY_DELAY = 1.3; // ran the pool dry: the wait before it refills is longer
const GUARD_REGEN = 0.35; // share of the refill rate while holding the guard up
const POISE = 30, POISE_DELAY = 2.5; // how much battering it takes to stagger you; it comes back all at once after this long unhit
const SECOND_WIND = 25; // once spent, the bar shows winded until stamina is back to this
const HEALTH_REGEN = 1, HEALTH_DELAY = 5;
const CLOT_HALF_LIFE = 12; // seconds for a wound to bleed half as fast
const STOPPED = 0.05; // hp/s below which a wound has closed

/**
 * The player's attributes and the two pools they feed. Levels run 1..10; everyone starts
 * at 1, and each level above that is a straight improvement.
 */
export class Vitals {
  readonly stats: Record<StatName, number> = { strength: BASE, stamina: BASE, health: BASE, agility: BASE };
  health: number;
  stamina: number;
  /** Open wounds, each bleeding this many health points per second and slowly clotting. */
  private wounds: number[] = [];
  /** Ran dry, and not yet back to a second wind (the bar shows it). */
  winded = false;
  private sinceEffort = 99;
  private sinceHurt = 99;
  /** Battering left before a blow staggers you. */
  poise = POISE;
  private sinceBattered = 99;

  constructor() {
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
  }

  get maxHealth() {
    return 100 + 10 * (this.stats.health - BASE);
  }
  get maxStamina() {
    return 100 + 10 * (this.stats.stamina - BASE);
  }
  /** Multiplier on how hard blows land. */
  get power() {
    return 1 + (this.stats.strength - BASE) * 0.08;
  }
  /** Multiplier on walking and running speed. */
  get speed() {
    return 1 + (this.stats.agility - BASE) * 0.03;
  }
  /** Total bleeding, health per second. */
  get bleeding() {
    return this.wounds.reduce((a, b) => a + b, 0);
  }
  get dead() {
    return this.health <= 0;
  }
  /** Any breath left at all lets you swing, dodge or parry: the move can take you down to zero. */
  get canAct() {
    return this.stamina > 0;
  }

  /** Use up `n` stamina (an attack, dodge, parry, or a blow taken on the guard). */
  spend(n: number) {
    if (n <= 0) return;
    this.stamina = Math.max(0, this.stamina - n);
    this.sinceEffort = 0;
    if (this.stamina === 0) {
      this.winded = true;
      this.sinceEffort = STAMINA_DELAY - EMPTY_DELAY;
    }
  }
  /** Take `n` poise damage; true if that breaks it (stagger), which also resets it. */
  batter(n: number) {
    this.sinceBattered = 0;
    this.poise -= n;
    if (this.poise > 0) return false;
    this.poise = POISE;
    return true;
  }

  /** Take `n` damage (armour already accounted for), opening a wound that bleeds `bleed` health per second. */
  hurt(n: number, bleed = 0) {
    this.health = Math.max(0, this.health - n);
    this.sinceHurt = 0;
    if (bleed >= STOPPED) this.wounds.push(bleed);
  }
  /** Close every wound and fill both pools (back in the room after a match). */
  restore() {
    this.wounds.length = 0;
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.winded = false;
    this.poise = POISE;
  }
  heal(n: number) {
    this.health = Math.min(this.maxHealth, this.health + n);
  }

  update(dt: number, guarding = false) {
    this.sinceEffort += dt;
    this.sinceHurt += dt;
    this.sinceBattered += dt;
    if (this.sinceBattered > POISE_DELAY) this.poise = POISE;
    const regen = STAMINA_REGEN * (guarding ? GUARD_REGEN : 1);
    if (this.sinceEffort > STAMINA_DELAY) this.stamina = Math.min(this.maxStamina, this.stamina + regen * dt);
    if (this.winded && this.stamina >= SECOND_WIND) this.winded = false;
    if (this.wounds.length) {
      if (!this.dead) this.health = Math.max(0, this.health - this.bleeding * dt);
      const k = Math.pow(0.5, dt / CLOT_HALF_LIFE);
      this.wounds = this.wounds.map((w) => w * k).filter((w) => w >= STOPPED);
      this.sinceHurt = 0; // no healing while blood is still running
    }
    if (!this.dead && this.sinceHurt > HEALTH_DELAY) this.heal(HEALTH_REGEN * dt);
  }
}
