export type StatName = 'strength' | 'stamina' | 'health' | 'agility';
export const STAT_NAMES: StatName[] = ['strength', 'stamina', 'health', 'agility'];
export const STAT_MAX = 10;

// --- tuning ---
const BASE = 1; // starting level: every formula is neutral here
const SPRINT_DRAIN = 14, ATTACK_COST = 14, JUMP_COST = 10; // stamina; sprint is per second
const STAMINA_REGEN = 22, STAMINA_DELAY = 0.8; // per second, after this long without effort
const SECOND_WIND = 25; // once spent, stamina must recover to this before sprinting again
const HEALTH_REGEN = 1, HEALTH_DELAY = 5;
const MAX_PROTECTION = 0.75;

/**
 * The player's attributes and the two pools they feed. Levels run 1..10; everyone starts
 * at 1, and each level above that is a straight improvement.
 */
export class Vitals {
  readonly stats: Record<StatName, number> = { strength: BASE, stamina: BASE, health: BASE, agility: BASE };
  health: number;
  stamina: number;
  /** Armour points worn; set by whoever tracks equipment. */
  armor = 0;
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
  /** Share of each blow that armour turns away. */
  get protection() {
    return Math.min(MAX_PROTECTION, this.armor / 100);
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

  /** Take a blow of `n` damage, less whatever the armour absorbs. */
  hurt(n: number) {
    this.health = Math.max(0, this.health - n * (1 - this.protection));
    this.sinceHurt = 0;
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
    if (!this.dead && this.sinceHurt > HEALTH_DELAY) this.heal(HEALTH_REGEN * dt);
  }
}
