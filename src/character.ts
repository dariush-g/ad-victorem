import { STAT_MAX, type StatName, type Vitals } from './stats';
import { xpToNext, type Career } from './career';


/** Health and stamina bars for the HUD. Returns a function that refreshes them. */
export function createVitalBars(vitals: Vitals, parent: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'vitals';
  const bar = (cls: string) => {
    const b = document.createElement('div');
    b.className = 'bar ' + cls;
    const fill = b.appendChild(document.createElement('i'));
    const text = b.appendChild(document.createElement('span'));
    wrap.appendChild(b);
    return { b, fill, text };
  };
  const hp = bar('hp'), sp = bar('sp');
  parent.appendChild(wrap);
  let shown = '';
  return () => {
    const bleeding = vitals.bleeding > 0.05;
    const key = `${Math.ceil(vitals.health)}/${vitals.maxHealth}/${Math.round(vitals.stamina * 4)}/${vitals.maxStamina}/${vitals.winded}/${bleeding}`;
    if (key === shown) return;
    shown = key;
    hp.fill.style.width = `${(vitals.health / vitals.maxHealth) * 100}%`;
    hp.text.textContent = `${Math.ceil(vitals.health)} / ${vitals.maxHealth}${bleeding ? ' · bleeding' : ''}`;
    hp.b.classList.toggle('bleeding', bleeding);
    sp.fill.style.width = `${(vitals.stamina / vitals.maxStamina) * 100}%`;
    sp.text.textContent = `${Math.floor(vitals.stamina)} / ${vitals.maxStamina}`;
    sp.b.classList.toggle('winded', vitals.winded);
  };
}

// ---------------------------------------------------------------------------------------
// Character sheet: the same frame as the inventory page, with the fighter's live figure in the
// middle (main.ts puts it in `figure`). Around it, where the inventory has gear slots, sit the
// four attributes; on the right, where it shows an item, the career and the fighter's condition.
// ---------------------------------------------------------------------------------------

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

interface StatInfo {
  stat: StatName;
  label: string;
  what: string;
  note: (v: Vitals) => string;
}
const LEFT: StatInfo[] = [
  { stat: 'strength', label: 'Strength', what: 'How hard your blows land', note: (v) => `Force ×${v.power.toFixed(2)}` },
  { stat: 'health', label: 'Health', what: 'How much punishment you take', note: (v) => `${v.maxHealth} health` },
];
const RIGHT: StatInfo[] = [
  { stat: 'stamina', label: 'Stamina', what: 'Breath for swings, rolls and blocks', note: (v) => `${v.maxStamina} stamina` },
  { stat: 'agility', label: 'Agility', what: 'How fast you move', note: (v) => `Speed ×${v.speed.toFixed(2)}` },
];

/**
 * The "Character" tab. `figure` is the box for the fighter's figure. `career` gives the level, money
 * and skill points; `spend` is called when the player puts a point into a stat.
 */
export function createCharacterSheet(vitals: Vitals, armour: () => string, career: () => Career, spend: (stat: StatName) => void) {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = '') => {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  const el = document.createElement('div');
  el.className = 'sheet';
  const top = make('div', 'inv-top', el);

  // the fighter with an attribute on each side, laid out like the inventory's paper doll
  const doll = make('div', 'inv-doll', top);
  const left = make('div', 'inv-doll-col', doll);
  const figure = make('div', 'inv-figure', doll);
  const right = make('div', 'inv-doll-col', doll);
  const chip = (c: StatInfo, parent: HTMLElement) => {
    const card = make('div', 'stat-chip', parent);
    card.title = c.what;
    const line = make('div', 'stat-chip-top', card);
    const name = make('div', 'stat-chip-name', line);
    const plus = make('button', 'stat-plus', line, '+');
    plus.title = `Spend a skill point on ${c.label.toLowerCase()}`;
    plus.addEventListener('click', () => spend(c.stat));
    const pips = make('div', 'stat-pips', card);
    for (let i = 0; i < STAT_MAX; i++) make('i', '', pips);
    const note = make('div', 'stat-chip-note', card);
    return { c, name, note, pips, plus };
  };
  const chips = [...LEFT.map((c) => chip(c, left)), ...RIGHT.map((c) => chip(c, right))];

  // the right-hand panel: career, then condition
  const side = make('div', 'inv-detail', top);
  const head = make('div', 'sheet-career', side);
  const levelEl = make('div', 'career-level', head);
  const moneyEl = make('div', 'career-money', head);
  const xpBar = make('div', 'career-xp', side);
  const xpFill = make('i', '', xpBar);
  const xpText = make('div', 'career-xp-text', side);
  const pointsEl = make('div', 'career-points', side);
  make('div', 'inv-section sheet-now', side, 'Condition');
  const now = make('div', 'inv-d-stats', side);
  const nowRow = (label: string) => {
    const row = make('div', 'inv-stat', now);
    make('span', 'inv-stat-name', row, label);
    const fill = make('i', '', make('span', 'inv-stat-bar', row));
    const val = make('span', 'inv-stat-val', row);
    return { fill, val };
  };
  const hpRow = nowRow('Health'), spRow = nowRow('Stamina');
  const armourEl = make('div', 'sheet-armour', side);
  make('div', 'inv-help', el, 'Win bouts to level up · each level gives a skill point · hover an attribute to see what it does');

  const render = () => {
    const k = career(), need = xpToNext(k.level);
    levelEl.textContent = `Level ${k.level}`;
    moneyEl.textContent = `${k.money.toLocaleString()} gold`;
    xpFill.style.width = `${Math.min(1, k.xp / need) * 100}%`;
    xpText.textContent = `${k.xp} / ${need} XP to level ${k.level + 1}`;
    pointsEl.hidden = k.points <= 0;
    pointsEl.textContent = `${k.points} skill ${k.points === 1 ? 'point' : 'points'} to spend: press + on an attribute`;
    for (const { c, name, note, pips, plus } of chips) {
      const lvl = vitals.stats[c.stat];
      plus.hidden = k.points <= 0 || lvl >= STAT_MAX;
      name.textContent = `${c.label} ${ROMAN[lvl]}`;
      note.textContent = c.note(vitals);
      Array.from(pips.children).forEach((p, i) => p.classList.toggle('on', i < lvl));
    }
    hpRow.fill.style.width = `${(vitals.health / vitals.maxHealth) * 100}%`;
    hpRow.val.textContent = `${Math.ceil(vitals.health)} / ${vitals.maxHealth}`;
    spRow.fill.style.width = `${(vitals.stamina / vitals.maxStamina) * 100}%`;
    spRow.val.textContent = `${Math.floor(vitals.stamina)} / ${vitals.maxStamina}`;
    armourEl.textContent = armour();
  };
  return { el, figure, render };
}
