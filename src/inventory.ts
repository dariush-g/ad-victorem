import { ITEMS, SLOTS, SLOT_LABEL, iconSVG, type Slot } from './items';
import { ZONES, type Zone } from './hits';
import { createItemView } from './itemview';

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

  /** Everything carried, as plain data for saving to an account. */
  snapshot(): { bag: (Stack | null)[]; equipped: Record<string, string | null> } {
    return { bag: this.bag.map((s) => s && { id: s.id, n: s.n }), equipped: { ...this.equipped } };
  }

  /** Replace everything carried with a saved snapshot. Unknown items, and items in the wrong slot, are dropped. Returns false if `data` isn't a snapshot. */
  restore(data: unknown): boolean {
    const d = data as { bag?: unknown; equipped?: unknown };
    if (!d || typeof d !== 'object' || !Array.isArray(d.bag) || !d.equipped || typeof d.equipped !== 'object') return false;
    const known = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(ITEMS, id);
    for (let i = 0; i < this.bag.length; i++) {
      const s = d.bag[i] as Stack | null;
      this.bag[i] = s && known(s.id) && Number.isInteger(s.n) && s.n > 0 ? { id: s.id, n: Math.min(s.n, ITEMS[s.id].stack) } : null;
    }
    for (const slot of SLOTS) {
      const id = (d.equipped as Record<string, unknown>)[slot];
      if (known(id) && ITEMS[id].slot === slot) this.equipped[slot] = id;
      else if (slot !== 'garb') this.equipped[slot] = null; // never left without a loincloth
    }
    this.onChange();
    return true;
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
  /** Where the panel lives: inside a page (the main menu) when given one, else floating in the HUD. */
  mount(parent: HTMLElement | null): void;
  /** The box in the middle of the paper doll, where the fighter's figure goes. */
  readonly figure: HTMLElement;
  /** The inventory page came into view. */
  onShowInventory: () => void;
  /** After the panel opens, closes or changes page. */
  onChange: (open: boolean, tab: number) => void;
  /** The panel's close button was pressed. */
  onClose: () => void;
}

/** Paper-doll sides: slots down the left and right of the figure, roughly where each is worn. */
const DOLL_LEFT: Slot[] = ['head', 'chest', 'arm', 'weapon'];
const DOLL_RIGHT: Slot[] = ['tunic', 'belt', 'garb', 'legs'];
const BAG_COLUMNS = 8;

type Pick = { kind: 'slot'; slot: Slot } | { kind: 'bag'; i: number };

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
  const head = el('div', 'inv-head', panel);
  const tabBar = el('div', 'inv-tabs', head);
  const closeBtn = el('button', 'inv-close', head, '✕') as HTMLButtonElement;
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => ui.onClose());
  const pages: { btn: HTMLElement; page: HTMLElement; onShow?: () => void }[] = [];
  let current = 0;
  const show = (i: number) => {
    current = i;
    pages.forEach((p, j) => {
      p.page.hidden = j !== i;
      p.btn.classList.toggle('on', j === i);
    });
    pages[i].onShow?.();
    view.setActive(!panel.hidden && current === 0);
    ui.onChange(!panel.hidden, current);
  };
  const addTab = (name: string, page: HTMLElement, onShow?: () => void) => {
    const i = pages.length, btn = el('button', 'inv-tab', tabBar, name);
    btn.addEventListener('click', () => show(i));
    panel.appendChild(page);
    pages.push({ btn, page, onShow });
    if (pages.length > 1) show(current);
    return i;
  };

  // --- the inventory page: paper doll | item detail, the bag underneath ---
  const invPage = document.createElement('div');
  invPage.className = 'inv-page';
  const top = el('div', 'inv-top', invPage);
  const dollEl = el('div', 'inv-doll', top);
  const left = el('div', 'inv-doll-col', dollEl);
  const figure = el('div', 'inv-figure', dollEl);
  const right = el('div', 'inv-doll-col', dollEl);

  const detail = el('div', 'inv-detail', top);
  const viewWrap = el('div', 'inv-view', detail);
  const viewCanvas = el('canvas', '', viewWrap) as HTMLCanvasElement;
  el('div', 'inv-view-hint', viewWrap, 'Drag to turn · scroll to zoom');
  const viewEmpty = el('div', 'inv-view-empty', viewWrap, 'Empty');
  const view = createItemView(viewCanvas);
  const dName = el('div', 'inv-d-name', detail);
  const dKind = el('div', 'inv-d-kind', detail);
  const dDesc = el('div', 'inv-d-desc', detail);
  const dStats = el('div', 'inv-d-stats', detail);
  const dAction = el('button', 'inv-d-action', detail) as HTMLButtonElement;

  const bagWrap = el('div', 'inv-bag-wrap', invPage);
  const bagHead = el('div', 'inv-section', bagWrap);
  el('span', '', bagHead, 'Bag');
  const bagCount = el('span', 'inv-bag-count', bagHead);
  const bagGrid = el('div', 'inv-bag', bagWrap);
  bagGrid.style.gridTemplateColumns = `repeat(${BAG_COLUMNS}, var(--cell))`;
  el('div', 'inv-help', invPage, 'Click to inspect · double-click to equip or take off · gear is fixed once an opponent is found');
  const promptEl = el('div', 'prompt', hud);
  const toastEl = el('div', 'toast', hud);

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
  };

  let pick: Pick | null = { kind: 'slot', slot: 'weapon' };
  let shownId: string | null | undefined; // what the turntable holds, to skip rebuilding it
  const pickedId = () => (!pick ? null : pick.kind === 'slot' ? inv.equipped[pick.slot] : inv.bag[pick.i]?.id ?? null);

  const makeCell = (parent: HTMLElement, p: Pick, label?: string) => {
    const wrap = label ? el('div', 'inv-slot', parent) : parent;
    const cell = el('div', 'inv-cell', wrap);
    el('div', 'inv-icon', cell);
    el('div', 'inv-count', cell);
    if (label) el('div', 'inv-slot-name', wrap, label);
    cell.addEventListener('click', () => {
      pick = p;
      render();
    });
    cell.addEventListener('dblclick', () => {
      pick = p;
      act();
    });
    return cell;
  };
  const equipCells = {} as Record<Slot, HTMLElement>;
  for (const [col, slots] of [[left, DOLL_LEFT], [right, DOLL_RIGHT]] as const)
    for (const slot of slots) equipCells[slot] = makeCell(col, { kind: 'slot', slot }, SLOT_LABEL[slot]);
  const bagCells = inv.bag.map((_, i) => makeCell(bagGrid, { kind: 'bag', i }));
  panel.addEventListener('contextmenu', (e) => e.preventDefault());

  /** Equip the picked bag item, or take off the picked worn one; the pick follows the item. */
  function act() {
    if (!pick) return;
    if (pick.kind === 'slot') {
      const slot = pick.slot, id = inv.equipped[slot];
      const r = inv.unequip(slot);
      if (r === 'full') toast('Bag is full');
      if (r === 'locked') toast('A slave keeps his cloth on');
      if (r === 'sealed') toast('Too late to change gear');
      if (r === 'ok') {
        const i = inv.bag.findIndex((s) => s?.id === id);
        if (i >= 0) pick = { kind: 'bag', i };
      }
    } else {
      const s = inv.bag[pick.i], slot = s && ITEMS[s.id].slot;
      if (s && inv.equipFromBag(pick.i)) pick = { kind: 'slot', slot: slot! };
      else if (s) toast(inv.locked ? 'Too late to change gear' : `${ITEMS[s.id].name} can't be worn`);
    }
    render();
  }
  dAction.addEventListener('click', act);

  const fill = (cell: HTMLElement, id: string | null, n = 1) => {
    cell.querySelector('.inv-icon')!.innerHTML = id ? iconSVG(ITEMS[id]) : '';
    cell.querySelector('.inv-count')!.textContent = n > 1 ? String(n) : '';
    cell.classList.toggle('filled', !!id);
  };

  const statRow = (label: string, value: string, frac?: number) => {
    const row = el('div', 'inv-stat', dStats);
    el('span', 'inv-stat-name', row, label);
    if (frac !== undefined) (el('span', 'inv-stat-bar', row).appendChild(document.createElement('i')) as HTMLElement).style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
    el('span', 'inv-stat-val', row, value);
  };

  function renderDetail() {
    const id = pickedId();
    if (id !== shownId) {
      view.show(id);
      shownId = id;
    }
    viewEmpty.hidden = !!id;
    dStats.replaceChildren();
    if (!id) {
      dName.textContent = pick?.kind === 'slot' ? SLOT_LABEL[pick.slot] : 'Empty space';
      dKind.textContent = pick?.kind === 'slot' ? 'Nothing worn here' : 'Nothing in this space';
      dDesc.textContent = 'Pick something from your bag to see it here.';
      dAction.hidden = true;
      return;
    }
    const def = ITEMS[id];
    dName.textContent = def.name;
    const worn = pick?.kind === 'slot';
    dKind.textContent = [def.slot ? SLOT_LABEL[def.slot] : 'Valuables', worn ? 'Worn' : 'In your bag'].join(' · ');
    dDesc.textContent = def.desc;
    if (def.blade) {
      statRow('Force', `×${def.power}`, (def.power ?? 1) / 2);
      statRow('Reach', `${Math.round((def.blade[1] - def.blade[0]) * 100)} cm`, (def.blade[1] - def.blade[0]) / 0.9);
      statRow('Edge', (def.edge ?? 0) >= 0.8 ? 'Sharp' : 'Blunt', def.edge ?? 0);
    }
    for (const [z, c] of Object.entries(def.covers ?? {})) statRow(ZONES[z as Zone].name, `${Math.round(c * 100)}%`, c);
    if (!def.blade && !def.covers && def.slot) statRow('Protection', 'None');
    if (def.price) statRow('Value', `${def.price} gold`);
    const n = pick?.kind === 'bag' ? inv.bag[pick.i]?.n ?? 1 : 1;
    if (n > 1) statRow('Count', String(n));
    dAction.hidden = !def.slot || (worn && def.slot === 'garb');
    dAction.textContent = worn ? 'Take off' : 'Equip';
    dAction.disabled = inv.locked;
  }

  const render = () => {
    for (const slot of SLOTS) {
      fill(equipCells[slot], inv.equipped[slot]);
      equipCells[slot].classList.toggle('picked', pick?.kind === 'slot' && pick.slot === slot);
    }
    inv.bag.forEach((s, i) => {
      fill(bagCells[i], s?.id ?? null, s?.n);
      bagCells[i].classList.toggle('picked', pick?.kind === 'bag' && pick.i === i);
    });
    bagCount.textContent = `${inv.bag.filter(Boolean).length} / ${inv.bag.length}`;
    renderDetail();
  };

  const ui: InventoryUI = {
    get open() {
      return !panel.hidden;
    },
    setOpen(open: boolean, tab?: number) {
      panel.hidden = !open;
      if (open) {
        render();
        show(tab ?? current);
      } else {
        view.setActive(false);
        ui.onChange(false, current);
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
    mount(parent: HTMLElement | null) {
      const to = parent ?? hud;
      if (panel.parentElement !== to) to.appendChild(panel);
      panel.classList.toggle('docked', !!parent);
    },
    figure,
    onShowInventory: () => {},
    onChange: () => {},
    onClose: () => ui.setOpen(false),
  };
  addTab('Inventory', invPage, () => ui.onShowInventory());
  render();
  return ui;
}
