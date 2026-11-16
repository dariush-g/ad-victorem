import { STAT_MAX, type StatName, type Vitals } from './stats';
import { xpToNext, type Career } from './career';
import { FRAME } from './portrait';


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
// Character sheet: a proportion study of the player. The figure is the game's own model
// (rendered by portrait.ts) in two superimposed poses, inscribed in a circle and a square,
// with each attribute called out from the part of the body it belongs to.
// ---------------------------------------------------------------------------------------

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const W = 420, HGT = 444; // diagram size, px
const K = W / (FRAME.circle * 2 + FRAME.margin * 2); // px per body height
const FEET_Y = (HGT + W) / 2 - FRAME.margin * K, CX = W / 2;
/** Diagram position of a point on the body: x in heights to the figure's left, y in heights above the ground. */
const at = (x: number, y: number): [number, number] => [CX + x * K, FEET_Y - y * K];

interface Callout {
  stat: StatName;
  label: string;
  corner: 'tl' | 'tr' | 'bl' | 'br';
  point: [number, number];
  note: (v: Vitals) => string;
}
const CALLOUTS: Callout[] = [
  { stat: 'strength', label: 'Strength', corner: 'tl', point: at(-0.2, 0.8), note: (v) => `Hit force ×${v.power.toFixed(2)}` },
  { stat: 'health', label: 'Health', corner: 'tr', point: at(0.035, 0.735), note: (v) => `Max health ${v.maxHealth}` },
  { stat: 'stamina', label: 'Stamina', corner: 'bl', point: at(-0.05, 0.66), note: (v) => `Max stamina ${v.maxStamina}` },
  { stat: 'agility', label: 'Agility', corner: 'br', point: at(0.075, 0.36), note: (v) => `Move speed ×${v.speed.toFixed(2)}` },
];

/**
 * The "body" tab. `canvas` is where portrait.ts draws the figure. `career` gives the level, money
 * and skill points; `spend` is called when the player puts a point into a stat.
 */
export function createCharacterSheet(vitals: Vitals, armour: () => string, career: () => Career, spend: (stat: StatName) => void) {
  const el = document.createElement('div');
  el.className = 'sheet';
  // level, experience toward the next, money, and points waiting to be spent
  const head = el.appendChild(document.createElement('div'));
  head.className = 'sheet-career';
  const levelEl = head.appendChild(document.createElement('div'));
  levelEl.className = 'career-level';
  const xpBar = head.appendChild(document.createElement('div'));
  xpBar.className = 'career-xp';
  const xpFill = xpBar.appendChild(document.createElement('i'));
  const xpText = xpBar.appendChild(document.createElement('span'));
  const moneyEl = head.appendChild(document.createElement('div'));
  moneyEl.className = 'career-money';
  const pointsEl = el.appendChild(document.createElement('div'));
  pointsEl.className = 'career-points';
  const figure = el.appendChild(document.createElement('div'));
  figure.className = 'sheet-figure';
  figure.style.height = HGT + 'px';

  // circle and square behind the figure; leader lines over it
  const r = FRAME.circle * K, side = K, top = FEET_Y - side;
  const svg = (inner: string) => `<svg viewBox="0 0 ${W} ${HGT}" fill="none" stroke="#f0c050" stroke-linecap="round">${inner}</svg>`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => `M${CX - side / 2 + t * side} ${FEET_Y + 5}v${t % 0.5 ? 4 : 7}`).join('');
  const back = figure.appendChild(document.createElement('div'));
  back.innerHTML = svg(`
    <circle cx="${CX}" cy="${FEET_Y - r}" r="${r}" stroke-width="1.5" opacity="0.8"/>
    <rect x="${CX - side / 2}" y="${top}" width="${side}" height="${side}" stroke-width="1.5" opacity="0.8"/>
    <path d="M${CX} ${top}V${FEET_Y} M${CX - side / 2} ${FEET_Y - r}H${CX + side / 2}" stroke-width="1" opacity="0.22" stroke-dasharray="3 5"/>
    <path d="${ticks}" stroke-width="1" opacity="0.7"/>`);
  const canvas = figure.appendChild(document.createElement('canvas'));
  const corner = { tl: [70, 66], tr: [W - 70, 66], bl: [70, HGT - 64], br: [W - 70, HGT - 64] };
  const front = figure.appendChild(document.createElement('div'));
  front.innerHTML = svg(
    CALLOUTS.map(({ corner: c, point: [px, py] }) => {
      const [x, y] = corner[c];
      return `<path d="M${x} ${y}L${px} ${py}" stroke-width="1.2" opacity="0.9"/><circle cx="${px}" cy="${py}" r="3.2" fill="#f0c050" stroke="#1a1210" stroke-width="1"/>`;
    }).join(''),
  );

  const notes = CALLOUTS.map((c) => {
    const box = figure.appendChild(document.createElement('div'));
    box.className = 'stat ' + c.corner;
    const top = box.appendChild(document.createElement('div'));
    top.className = 'stat-top';
    const name = top.appendChild(document.createElement('div'));
    name.className = 'stat-name';
    name.textContent = c.label;
    const plus = top.appendChild(document.createElement('button'));
    plus.className = 'stat-plus';
    plus.textContent = '+';
    plus.title = `Spend a skill point on ${c.label.toLowerCase()}`;
    plus.addEventListener('click', () => spend(c.stat));
    const pips = box.appendChild(document.createElement('div'));
    pips.className = 'stat-pips';
    for (let i = 0; i < STAT_MAX; i++) pips.appendChild(document.createElement('i'));
    const note = box.appendChild(document.createElement('div'));
    note.className = 'stat-note';
    return { c, name, pips, note, plus };
  });
  const live = el.appendChild(document.createElement('div'));
  live.className = 'sheet-live';

  const render = () => {
    const k = career(), need = xpToNext(k.level);
    levelEl.textContent = `Level ${k.level}`;
    xpFill.style.width = `${(k.xp / need) * 100}%`;
    xpText.textContent = `${k.xp} / ${need} XP`;
    moneyEl.textContent = `${k.money.toLocaleString()} gold`;
    pointsEl.hidden = k.points <= 0;
    pointsEl.textContent = `${k.points} skill ${k.points === 1 ? 'point' : 'points'} to spend: press + beside a skill`;
    for (const { c, name, pips, note, plus } of notes) {
      const lvl = vitals.stats[c.stat];
      plus.hidden = k.points <= 0 || lvl >= STAT_MAX;
      name.textContent = `${c.label} ${ROMAN[lvl]}`;
      Array.from(pips.children).forEach((p, i) => p.classList.toggle('on', i < lvl));
      note.textContent = c.note(vitals);
    }
    live.textContent = `Health ${Math.ceil(vitals.health)} / ${vitals.maxHealth} · Stamina ${Math.floor(vitals.stamina)} / ${vitals.maxStamina} · ${armour()}`;
  };
  return { el, canvas, render };
}
