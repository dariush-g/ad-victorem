export type StatName = 'strength' | 'stamina' | 'health' | 'agility';
export const STAT_NAMES: StatName[] = ['strength', 'stamina', 'health', 'agility'];
export const STAT_MAX = 10;

// --- tuning ---
const BASE = 1; // starting level: every formula is neutral here
const SPRINT_DRAIN = 14, ATTACK_COST = 14, JUMP_COST = 10; // stamina; sprint is per second
const STAMINA_REGEN = 22, STAMINA_DELAY = 0.8; // per second, after this long without effort
const SECOND_WIND = 25; // once spent, stamina must recover to this before sprinting again
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
  /** Ran dry: no sprinting until a second wind. */
  winded = false;
  private sinceEffort = 99;
  private sinceHurt = 99;

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
  get canSprint() {
    return !this.winded && this.stamina > 0;
  }
  get canAttack() {
    return this.stamina >= ATTACK_COST;
  }
  get canJump() {
    return this.stamina >= JUMP_COST;
  }

  private spend(n: number) {
    this.stamina = Math.max(0, this.stamina - n);
    this.sinceEffort = 0;
    if (this.stamina === 0) this.winded = true;
  }
  attacked() {
    this.spend(ATTACK_COST);
  }
  jumped() {
    this.spend(JUMP_COST);
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
  }
  heal(n: number) {
    this.health = Math.min(this.maxHealth, this.health + n);
  }

  update(dt: number, sprinting: boolean) {
    if (sprinting) this.spend(SPRINT_DRAIN * dt);
    this.sinceEffort += dt;
    this.sinceHurt += dt;
    if (this.sinceEffort > STAMINA_DELAY) this.stamina = Math.min(this.maxStamina, this.stamina + STAMINA_REGEN * dt);
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
