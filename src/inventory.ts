import { ITEMS, SLOTS, SLOT_LABEL, iconSVG, type Slot } from './items';
import { ZONES, type Zone } from './hits';

export interface Stack {
  id: string;
  n: number;
}

/** What the player carries: a bag of stacks plus one item per equipment slot. */
export class Inventory {
  readonly bag: (Stack | null)[];
  readonly equipped = Object.fromEntries(SLOTS.map((s) => [s, null])) as Record<Slot, string | null>;
  /** Gear is fixed once a match is found: nothing can be put on or taken off. */
  locked = false;
  /** Called after any change. */
  onChange = () => {};

  constructor(size = 16) {
    this.bag = new Array(size).fill(null);
  }

  /** Put items in the bag, topping up existing stacks first. Returns how many did not fit. */
  add(id: string, n = 1): number {
    const max = ITEMS[id].stack, before = n;
    for (const s of this.bag) {
      if (n <= 0) break;
      if (s && s.id === id && s.n < max) {
        const k = Math.min(n, max - s.n);
        s.n += k;
        n -= k;
      }
    }
    for (let i = 0; i < this.bag.length && n > 0; i++) {
      if (this.bag[i]) continue;
      const k = Math.min(n, max);
      this.bag[i] = { id, n: k };
      n -= k;
    }
    if (n !== before) this.onChange();
    return n;
  }

  /** Remove and return the whole stack in a bag space. */
  take(i: number): Stack | null {
    const s = this.bag[i];
    if (!s) return null;
    this.bag[i] = null;
    this.onChange();
    return s;
  }

  /** Put on an item directly (starting gear), discarding whatever was in its slot. */
  wear(id: string) {
    const slot = ITEMS[id].slot;
    if (!slot) return;
    this.equipped[slot] = id;
    this.onChange();
  }

  /** Equip the item in a bag space; whatever it replaces takes that space. */
  equipFromBag(i: number): boolean {
    const s = this.bag[i], slot = s && ITEMS[s.id].slot;
    if (!s || !slot || this.locked) return false;
    const old = this.equipped[slot];
    this.equipped[slot] = s.id;
    this.bag[i] = old ? { id: old, n: 1 } : null;
    this.onChange();
    return true;
  }

  /** Move an equipped item back to the bag. The loincloth can be swapped but never simply removed. */
  unequip(slot: Slot): 'ok' | 'empty' | 'full' | 'locked' | 'sealed' {
    const id = this.equipped[slot];
    if (!id) return 'empty';
    if (this.locked) return 'sealed';
    if (slot === 'garb') return 'locked';
    const free = this.bag.indexOf(null);
    if (free < 0) return 'full';
    this.bag[free] = { id, n: 1 };
    this.equipped[slot] = null;
    this.onChange();
    return 'ok';
  }
}

export interface InventoryUI {
  readonly open: boolean;
  /** Show or hide the panel; `tab` picks which page it opens on. */
  setOpen(open: boolean, tab?: number): void;
  /** Add a page beside the inventory. `onShow` runs whenever the page comes into view. Returns its index. */
  addTab(name: string, page: HTMLElement, onShow?: () => void): number;
  /** Index of the page in view. */
  readonly tab: number;
  render(): void;
  toast(text: string): void;
  /** Line shown above the hint bar; empty hides it. */
  prompt(html: string): void;
}

/** Inventory panel, prompt line and toast messages, built into the HUD. */
export function createInventoryUI(inv: Inventory): InventoryUI {
  const hud = document.getElementById('hud')!;
  const el = (tag: string, cls: string, parent: HTMLElement, text = '') => {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  const panel = el('div', 'inv', hud);
  panel.hidden = true;
  const tabBar = el('div', 'inv-tabs', panel);
  const pages: { btn: HTMLElement; page: HTMLElement; onShow?: () => void }[] = [];
  let current = 0;
  const show = (i: number) => {
    current = i;
    pages.forEach((p, j) => {
      p.page.hidden = j !== i;
      p.btn.classList.toggle('on', j === i);
    });
    pages[i].onShow?.();
  };
  const addTab = (name: string, page: HTMLElement, onShow?: () => void) => {
    const i = pages.length, btn = el('div', 'inv-tab', tabBar, name);
    btn.addEventListener('click', () => show(i));
    panel.appendChild(page);
    pages.push({ btn, page, onShow });
    show(current);
    return i;
  };
  const invPage = document.createElement('div');
  addTab('Inventory', invPage);
  const body = el('div', 'inv-body', invPage);
  const equipCol = el('div', 'inv-equip', body);
  const bagGrid = el('div', 'inv-bag', body);
  const info = el('div', 'inv-info', invPage);
  el('div', 'inv-help', invPage, 'Click: equip / take off · Tab: close · Gear is fixed once an opponent is found');
  const promptEl = el('div', 'prompt', hud);
  const toastEl = el('div', 'toast', hud);

  const describe = (id: string | null, fallback = '') => {
    info.textContent = '';
    if (!id) {
      info.textContent = fallback;
      return;
    }
    const def = ITEMS[id];
    el('b', '', info, def.name);
    const covers = Object.entries(def.covers ?? {}).map(([z, c]) => `${ZONES[z as Zone].name} ${Math.round(c * 100)}%`);
    const stats = def.blade
      ? ` Force ×${def.power} · Blade ${Math.round((def.blade[1] - def.blade[0]) * 100)} cm · ${(def.edge ?? 0) >= 0.8 ? 'Sharp' : 'Blunt'}.`
      : covers.length ? ` Protects: ${covers.join(', ')}.` : '';
    info.append(` — ${def.desc}${stats}`);
  };

  const fill = (cell: HTMLElement, id: string | null, n = 1) => {
    cell.querySelector('.inv-icon')!.innerHTML = id ? iconSVG(ITEMS[id]) : '';
    cell.querySelector('.inv-count')!.textContent = n > 1 ? String(n) : '';
    cell.classList.toggle('filled', !!id);
  };
  const makeCell = (parent: HTMLElement) => {
    const cell = el('div', 'inv-cell', parent);
    el('div', 'inv-icon', cell);
    el('div', 'inv-count', cell);
    cell.addEventListener('mouseleave', () => describe(null));
    return cell;
  };

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
  };

  const equipCells = SLOTS.map((slot) => {
    const row = el('div', 'inv-slot', equipCol);
    const cell = makeCell(row);
    el('div', 'inv-slot-name', row, SLOT_LABEL[slot]);
    cell.addEventListener('mouseenter', () => describe(inv.equipped[slot], `${SLOT_LABEL[slot]}: nothing`));
    cell.addEventListener('click', () => {
      const r = inv.unequip(slot);
      if (r === 'full') toast('Bag is full');
      if (r === 'locked') toast('A slave keeps his cloth on');
      if (r === 'sealed') toast('Too late to change gear');
    });
    return cell;
  });
  const bagCells = inv.bag.map((_, i) => {
    const cell = makeCell(bagGrid);
    cell.addEventListener('mouseenter', () => describe(inv.bag[i]?.id ?? null));
    cell.addEventListener('click', () => {
      const s = inv.bag[i];
      if (s && !inv.equipFromBag(i)) toast(inv.locked ? 'Too late to change gear' : `${ITEMS[s.id].name} can't be worn`);
      describe(inv.bag[i]?.id ?? null);
    });
    return cell;
  });
  panel.addEventListener('contextmenu', (e) => e.preventDefault());

  const render = () => {
    SLOTS.forEach((slot, i) => fill(equipCells[i], inv.equipped[slot]));
    inv.bag.forEach((s, i) => fill(bagCells[i], s?.id ?? null, s?.n));
  };
  render();

  return {
    get open() {
      return !panel.hidden;
    },
    setOpen(open: boolean, tab?: number) {
      panel.hidden = !open;
      if (open) {
        describe(null);
        show(tab ?? current);
      }
    },
    addTab,
    get tab() {
      return current;
    },
    render,
    toast,
    prompt(html: string) {
      if (promptEl.innerHTML !== html) promptEl.innerHTML = html;
      promptEl.classList.toggle('show', !!html);
    },
  };
}
