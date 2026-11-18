import * as THREE from 'three';
import { createArena, groundHeight, ceilingAt, confine, site, spawnPoint, gateYaw, GATES, R } from './arena';
import { createPost, BASE_CHROMA } from './post';
import { loadGladiator, type Gladiator, isAttack, MOVE_INFO, MOVE_KINDS, HEAVY_CHARGE_BONUS, type MoveKind } from './gladiator';
import { ITEMS, SLOTS, SHOP, STARTER, iconSVG } from './items';
import { Inventory, createInventoryUI, clashingSlot } from './inventory';
import { findOpponent, makeCode, cleanCode, cleanName, type Link, type Mode, type Msg, type Search, type Seat } from './net';
import { account, buyItem, fetchLeaderboard, USERNAME, PASSWORD_MIN } from './account';
import {
  grantWin, spendPoint, loadLocalCareer, saveLocalCareer, freshCareer, loadLocalOwned, saveLocalOwned, loadLocalGear, saveLocalGear,
  WIN_XP, WIN_MONEY, type Career,
} from './career';
import type { StatName } from './stats';
import { BASE_DAMAGE, ZONES, ZONE_LIST, protection, touchedPart } from './hits';
import { Vitals } from './stats';
import { createVitalBars, createCharacterSheet } from './character';
import { createTurntable } from './portrait';
import { renderIcons } from './icons';

const SENS = 0.0022;
// over-the-right-shoulder rig, in camera space relative to the character's upper chest
const SHOULDER = { right: 1.0, up: 1.62, back: 3.3 };
// resting camera tilt: the middle of the view (where swings are aimed) sits at chest height at sword's reach
const REST_PITCH = -0.25;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// start sharp, then drop resolution in steps if the machine can't hold frame rate
const MAX_RATIO = Math.min(window.devicePixelRatio, 2), MIN_RATIO = Math.min(1, MAX_RATIO);
let pixelRatio = MAX_RATIO;
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.localClippingEnabled = true; // the portcullis bars are clipped where they rise into the lintel
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);
camera.rotation.order = 'YXZ';

const arena = createArena(scene);
// image-based ambient light: the finished arena, captured once from head height, lights and reflects in every material
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(scene, 0.03, 0.1, 600, { position: new THREE.Vector3(0, 1.7, 0) }).texture;
  scene.environmentIntensity = 0.75;
  pmrem.dispose();
}
const post = createPost(renderer, scene, camera);
// the player starts in the north gateway room, facing its closed gate; bodies for up to three
// opponents wait unseen until a match
const [player, ...foeBodies] = await Promise.all([
  loadGladiator(groundHeight, confine, spawnPoint(0).pos),
  ...[1, 2, 3].map((g) => loadGladiator(groundHeight, () => {}, spawnPoint(g).pos)),
]);
for (const b of foeBodies) b.root.visible = false;
scene.add(player.root, ...foeBodies.map((b) => b.root));

// soft contact shadow: grounds the gladiator even inside the stadium's shade
const blob = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(60,34,30,0.42)');
  g.addColorStop(1, 'rgba(60,34,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
  );
  scene.add(m);
  return m;
})();

// --- inventory: bag + equipment. Gear is chosen in the gateway room and fixed once an opponent is found ---
const inventory = new Inventory();
renderIcons(); // every item's icon, drawn from its model, before anything shows one
const ui = createInventoryUI(inventory);
// --- attributes, health and stamina ---
const vitals = new Vitals();
const drawBars = createVitalBars(vitals, document.getElementById('rank')!);
/** Flash the stamina bar: a press was made with no breath left for it. */
function flashStamina() {
  const bar = document.querySelector('.bar.sp');
  if (!bar) return;
  bar.classList.remove('empty');
  void (bar as HTMLElement).offsetWidth; // restart the animation
  bar.classList.add('empty');
}
// armour summary for the character sheet: what each body zone is protected by, all worn pieces together
const sheet = createCharacterSheet(
  vitals,
  () => {
    const parts = ZONE_LIST.map((z) => [ZONES[z].name, Math.round(protection(inventory.equipped, z) * 100)] as const).filter(([, p]) => p > 0);
    return parts.length ? 'Armour: ' + parts.map(([n, p]) => `${n} ${p}%`).join(', ') : 'No armour';
  },
  () => career(),
  (stat) => void spendSkill(stat),
);

// --- career: level, experience, money and skill points. Logged in it lives on the server; as a guest, in this browser ---
let localCareer = loadLocalCareer();
const career = (): Career => account.profile?.career ?? localCareer;
/** Items owned: the starting kit plus purchases. Logged in, the server's list; as a guest, this browser's. */
let localOwned = loadLocalOwned(STARTER);
const owned = (): string[] => account.profile?.owned ?? localOwned;

/** Bring the fighter's stats in line with the career (between bouts only: the stats are fixed once a bout starts). */
function applyCareer() {
  if (phase === 'countdown' || phase === 'fight') return;
  Object.assign(vitals.stats, career().stats);
  vitals.health = Math.min(vitals.health, vitals.maxHealth);
  vitals.stamina = Math.min(vitals.stamina, vitals.maxStamina);
  renderRank();
  if (ui.open && ui.tab === SHEET_TAB) sheet.render();
}

/** Tell the player what a win brought: experience, money, and any levels. */
function celebrate(before: Career, after: Career) {
  if (after.level === before.level && after.xp === before.xp && after.money === before.money) return;
  const gained = after.level - before.level;
  ui.toast(
    gained > 0
      ? `Level up! Level ${after.level} · +${after.money - before.money} gold · press C to spend your skill ${after.points === 1 ? 'point' : 'points'}`
      : `+${WIN_XP} XP · +${WIN_MONEY} gold`,
  );
}

/** A guest's win: awarded here and kept in this browser. (Logged in, the server awards it and sends the new career.) */
function rewardGuestWin() {
  if (account.loggedIn) return;
  const before = structuredClone(localCareer);
  grantWin(localCareer);
  saveLocalCareer(localCareer);
  applyCareer();
  celebrate(before, localCareer);
}

async function spendSkill(stat: StatName) {
  if (phase === 'countdown' || phase === 'fight') return ui.toast('Skills can only be trained between bouts');
  if (account.loggedIn) {
    if (!(await account.spend(stat))) ui.toast('Could not spend the point');
  } else if (spendPoint(localCareer, stat)) {
    saveLocalCareer(localCareer);
    applyCareer();
  }
}
// One live, turnable figure of the fighter, shared by both tabs: it moves to whichever is showing,
// so the two differ only in what is laid out around it (gear, or attributes).
const turntable = createTurntable(renderer, scene, player);
const SHEET_TAB = ui.addTab('Character', sheet.el, () => {
  sheet.figure.appendChild(turntable.el);
  sheet.render();
});
ui.onShowInventory = () => ui.figure.appendChild(turntable.el);
const rankSub = document.querySelector('#rank .sub')!, purseEl = document.getElementById('main-purse')!;
function renderRank() {
  const w = inventory.equipped.weapon, k = career();
  rankSub.textContent = `Level ${k.level} · Slave · ${w ? ITEMS[w].name : 'Bare hands'}`;
  purseEl.innerHTML = `<span>Level <b>${k.level}</b></span><span><b>${k.money.toLocaleString()}</b> gold</span>` +
    (k.points ? `<span><b>${k.points}</b> skill ${k.points === 1 ? 'point' : 'points'}</span>` : '');
}
inventory.onChange = () => {
  for (const slot of SLOTS) player.equip(slot, inventory.equipped[slot]);
  renderRank();
  ui.render();
  saveSoon();
};
/** Logged in: keep the account's copy of the inventory up to date, a moment after each change. */
let saveTimer = 0, restoring = false;
function saveSoon() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (account.offline) return;
    if (account.loggedIn) void account.save(inventory.snapshot());
    else saveLocalGear(inventory.snapshot()); // a guest's gear stays in this browser
  }, 1000);
}

/**
 * Make the inventory hold exactly the owned items, each once, arranged as the saved `layout` where
 * it can be. Anything not owned goes; owned items it lacks go into the bag (on a fresh start with no
 * layout, straight onto the body if their slot is free, so a new gladiator holds the wooden sword).
 */
function syncInventory(layout: unknown) {
  if (inventory.locked) return;
  restoring = true;
  if (!inventory.restore(layout)) inventory.restore({ bag: [], equipped: {} });
  const own = new Set(owned()), seen = new Set<string>();
  for (const slot of SLOTS) {
    const id = inventory.equipped[slot];
    if (id && (!own.has(id) || seen.has(id))) inventory.equipped[slot] = null;
    else if (id) seen.add(id);
  }
  inventory.bag.forEach((st, i) => {
    if (st && (!own.has(st.id) || seen.has(st.id))) inventory.bag[i] = null;
    else if (st) seen.add(st.id);
  });
  for (const id of own) {
    if (seen.has(id) || !Object.hasOwn(ITEMS, id)) continue;
    const slot = ITEMS[id].slot;
    if (layout == null && slot && !inventory.equipped[slot] && !clashingSlot(inventory.equipped, id)) inventory.equipped[slot] = id;
    else inventory.add(id);
  }
  // never without a loincloth
  if (!inventory.equipped.garb) {
    const i = inventory.bag.findIndex((st) => st && ITEMS[st.id].slot === 'garb');
    if (i >= 0) {
      inventory.equipped.garb = inventory.bag[i]!.id;
      inventory.bag[i] = null;
    }
  }
  restoring = false;
  inventory.onChange();
}
syncInventory(loadLocalGear());

// --- matches: free-for-all from the open queue (up to four, one per gate) or a duel by friend code.
// From the menu into a gateway room, gates rise, fight, last one standing wins, back to the menu ---
type Phase = 'lobby' | 'searching' | 'countdown' | 'fight' | 'over' | 'practice';
const COUNTDOWN = 4, SEND_HZ = 30;
const REMATCH_WINDOW = 20; // seconds after a duel in which both must agree to fight again
const GATE_CLEAR = 3; // metres onto the sand before a gate drops behind its fighter
let phase: Phase = 'lobby', phaseT = 0, bannerT = 0;
let search: Search | null = null, link: Link | null = null;
let searchMode: Mode = { kind: 'queue' };
/** Free-for-all lobby while it fills: our seat, who is in, and whether we have voted to start. */
let lobbyInfo: { seat: number; players: Seat[] } | null = null, myVote = false;
/** After a duel: who has asked to fight again, and why a rematch is off the table (null while it is still possible). */
const rematch = { mine: false, theirs: false, closed: null as string | null };
let sendT = 0;

/** Another fighter in the match: their body here, and the last word from their machine. */
interface Foe {
  seat: number;
  name: string;
  body: Gladiator;
  remote: {
    p: THREE.Vector3; v: THREE.Vector3; f: number; a: number; mx: number; mz: number; bits: number; hp: number;
    at: number; // when it arrived, ms
    dead: boolean;
    attack: { k: MoveKind; f: number; aim: number; d: number } | null;
    /** Their heavy blow is still charging (no release heard yet). */
    charging: boolean;
    released: boolean;
  };
  /** Their gate has dropped behind them. */
  gateShut: boolean;
  /** Has left the match. */
  gone: boolean;
  /** Name floating over their head, and their health bar at the top of the screen. */
  label: HTMLElement;
  card: HTMLElement;
  fill: HTMLElement;
}
let foes: Foe[] = [];
const foeAt = (seat: number) => foes.find((f) => f.seat === seat);
/** Still in the bout: neither fallen nor fled. */
const standing = (f: Foe) => !f.remote.dead && !f.gone;

const matchEl = document.getElementById('match')!;
const foeCards = document.getElementById('foes')!;
const hudEl = document.getElementById('hud')!;
const labelAt = new THREE.Vector3();
/** Each opponent's name, floating above their head while they are in the arena with us. */
function updateFoeLabel() {
  const show = link !== null && (phase === 'countdown' || phase === 'fight' || phase === 'over');
  for (const f of foes) {
    if (!show || !f.body.root.visible) {
      f.label.hidden = true;
      continue;
    }
    f.body.headPosition(labelAt).y += 0.32;
    camera.updateMatrixWorld();
    labelAt.project(camera);
    const onScreen = labelAt.z < 1 && Math.abs(labelAt.x) < 1.1 && Math.abs(labelAt.y) < 1.1;
    if (onScreen) {
      const x = ((labelAt.x + 1) / 2) * window.innerWidth, y = ((1 - labelAt.y) / 2) * window.innerHeight;
      f.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    f.label.hidden = !onScreen;
  }
}
const banner = (html: string) => {
  if (matchEl.innerHTML !== html) matchEl.innerHTML = html;
};
const num = (x: unknown, lo = -1e4, hi = 1e4) => (typeof x === 'number' && Number.isFinite(x) ? THREE.MathUtils.clamp(x, lo, hi) : 0);
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Start looking for a match: the open free-for-all queue, or a friend's duel by code. */
function startSearch(mode: Mode) {
  if (phase !== 'lobby' || !requireName()) return;
  phase = 'searching';
  searchMode = mode;
  lobbyInfo = null;
  myVote = false;
  renderMainNav(); // the menu stays up, saying it is connecting, until the server takes the search
  search = findOpponent(mode, {
    found: onFound,
    // queueing or holding a code: into the gateway room to wait. Joining a friend waits on the menu until paired.
    waiting() {
      if (mode.kind === 'join') return;
      hideMain();
      lock();
    },
    lobby(seat, players) {
      lobbyInfo = { seat, players };
      myVote = players.find((p) => p.seat === seat)?.vote ?? false;
    },
    message: onMessage,
    left: onLeft,
    lost: onLost,
    profile: (p) => {
      const before = structuredClone(career());
      account.update(p);
      celebrate(before, career());
    },
    failed(why) {
      search = null;
      phase = 'lobby';
      renderMainNav();
      if (why === 'taken' && mode.kind === 'host') return startSearch({ kind: 'host', code: makeCode() }); // unlucky: someone has that code
      ui.toast(
        why === 'missing' && mode.kind === 'join'
          ? `Nobody is waiting with code ${mode.code}`
          : why === 'unreachable'
            ? 'Could not reach the match server'
            : 'Could not connect',
      );
      openMain();
    },
  }, account.loggedIn ? account.token : null, playerName());
  if (!menu.hidden) setMenu(true);
}

function toggleSearch() {
  if (phase === 'lobby') startSearch({ kind: 'queue' });
  else if (phase === 'searching') toLobby();
}

/** In a free-for-all lobby: vote to start now with whoever is in (it starts once everyone has). */
function toggleVote() {
  if (phase !== 'searching' || searchMode.kind !== 'queue' || !lobbyInfo || lobbyInfo.players.length < 2) return;
  myVote = !myVote;
  search?.vote(myVote);
}

function onFound(l: Link) {
  link = l;
  site.side = l.seat; // our seat is our gate
  for (const f of foes) dropFoe(f);
  foes = l.players
    .filter((p) => p.seat !== l.seat)
    .slice(0, foeBodies.length)
    .map((p, i) => makeFoe(p.seat, p.name || 'Gladiator', foeBodies[i]));
  l.send({ t: 'gear', gear: { ...inventory.equipped }, name: playerName() });
  hideMain(); // joined a friend straight from the menu
  beginMatch();
  lock();
}

function makeFoe(seat: number, name: string, body: Gladiator): Foe {
  for (const slot of SLOTS) body.equip(slot, null);
  const label = hudEl.appendChild(document.createElement('div'));
  label.className = 'foe-name';
  label.hidden = true;
  label.textContent = name;
  const card = foeCards.appendChild(document.createElement('div'));
  card.className = 'foe';
  card.appendChild(document.createElement('span')).textContent = name;
  const bar = card.appendChild(document.createElement('div'));
  bar.className = 'bar hp';
  const fill = bar.appendChild(document.createElement('i'));
  return {
    seat, name, body, label, card, fill, gateShut: false, gone: false,
    remote: {
      p: new THREE.Vector3(), v: new THREE.Vector3(), f: 0, a: 0, mx: 0, mz: 0, bits: 0, hp: 1, at: 0, dead: false,
      attack: null, charging: false, released: false,
    },
  };
}
function dropFoe(f: Foe) {
  f.body.root.visible = false;
  f.label.remove();
  f.card.remove();
}

/** Every fighter to their gateway room, healed, gear fixed, gates shut, countdown running. Used for the first bout and every rematch. */
function beginMatch() {
  phase = 'countdown';
  phaseT = COUNTDOWN;
  resultEl.hidden = true;
  inventory.locked = true;
  ui.setOpen(false);
  if (!menu.hidden) setMenu(true);
  vitals.restore();
  for (let g = 0; g < GATES; g++) arena.setGate(g, false);
  site.zone = 'room';
  const here = spawnPoint(site.side);
  player.place(here.pos, here.facing);
  focus.copy(here.pos);
  yaw = gateYaw(site.side); // camera behind the player, looking at the gate
  pitch = REST_PITCH;
  for (const f of foes) {
    const there = spawnPoint(f.seat), r = f.remote;
    f.body.place(there.pos, there.facing);
    r.p.copy(there.pos);
    r.v.set(0, 0, 0);
    r.f = r.a = there.facing;
    r.mx = r.mz = r.bits = 0;
    r.hp = 1;
    r.dead = false;
    r.at = performance.now();
    r.attack = null;
    r.charging = r.released = false;
    f.gateShut = false;
    f.body.root.visible = !f.gone;
    f.card.classList.toggle('out', f.gone);
  }
  riposteUntil = 0;
}

/** Everything here comes from another player's machine: check it before using it. */
function onMessage(m: Msg, from: number) {
  if (!link) return;
  const foe = foeAt(from);
  if (!foe) return;
  const remote = foe.remote;
  switch (m.t) {
    case 'gear':
      for (const slot of SLOTS) {
        const id = m.gear?.[slot];
        foe.body.equip(slot, typeof id === 'string' && Object.hasOwn(ITEMS, id) && ITEMS[id].slot === slot ? id : null);
      }
      // nobody carries a shield with a two-handed weapon
      if (foe.body.held('weapon') && ITEMS[foe.body.held('weapon')!].twoHanded) foe.body.equip('shield', null);
      break;
    case 's':
      if (!Array.isArray(m.p) || !Array.isArray(m.v) || !Array.isArray(m.m)) break;
      remote.p.set(num(m.p[0], -60, 60), num(m.p[1], -5, 30), num(m.p[2], -60, 60));
      remote.v.set(num(m.v[0], -30, 30), num(m.v[1], -30, 30), num(m.v[2], -30, 30));
      remote.f = num(m.f);
      remote.a = num(m.a);
      remote.mx = num(m.m[0], -1, 1);
      remote.mz = num(m.m[1], -1, 1);
      remote.bits = num(m.b, 0, 255) | 0;
      remote.hp = num(m.hp, 0, 1);
      remote.at = performance.now();
      break;
    case 'atk':
      if (MOVE_KINDS.includes(m.k)) remote.attack = { k: m.k, f: num(m.f), aim: num(m.aim, -1, 1), d: num(m.d) };
      break;
    case 'rel':
      remote.released = true;
      break;
    case 'parried':
      // our blow was turned aside: we reel, wide open
      if (phase !== 'fight' || vitals.dead) break;
      player.forceMove('parried');
      ui.toast('Parried!');
      impact(0.09, 0.5);
      break;
    case 'blocked':
      if (phase !== 'fight' || vitals.dead) break;
      if (player.attacking && player.currentMove !== 'heavy') player.forceMove('recoil'); // heavies push through a guard
      impact(0.05, 0.25);
      break;
    case 'hit': {
      if (phase !== 'fight' || vitals.dead || !ZONE_LIST.includes(m.zone)) break;
      // Our own machine has the last word on our defence: what we see is what counts for dodging,
      // parrying and blocking, so a dodge that looked clean on our screen is clean.
      if (player.invulnerable) break;
      const x = num(m.x, -1, 1), z = num(m.z, -1, 1);
      const d = num(m.d, 0, 200), poise = num(m.poise, 0, 200);
      // the blow comes along (x, z): it is in front of us if that runs against our facing
      const front = -(Math.sin(player.facing) * x + Math.cos(player.facing) * z) > FRONT_COS;
      if (front && player.parrying) {
        link.send({ t: 'parried' }, from);
        // a weapon that leaves its wielder reeling longer (the spear) gives a longer opening
        const theirs = foe.body.held('weapon');
        riposteUntil = performance.now() + RIPOSTE_MS * ((theirs && ITEMS[theirs].parriedStun) || 1);
        ui.toast('Parried · strike now!');
        impact(0.1, 0.4);
        break;
      }
      // a shield covers a wider arc than a blade held across the body, for less stamina, and lets less through
      const shield = inventory.equipped.shield ? ITEMS[inventory.equipped.shield].guard : undefined;
      const guard = shield ?? { cost: BLOCK_STAMINA, chip: BLOCK_CHIP, arc: FRONT_COS };
      const covered = -(Math.sin(player.facing) * x + Math.cos(player.facing) * z) > guard.arc;
      if (covered && player.blocking) {
        const cost = d * guard.cost;
        if (vitals.stamina >= cost) {
          vitals.spend(cost);
          vitals.hurt(d * guard.chip);
          link.send({ t: 'blocked' }, from);
          player.vel.x += x * 1.5;
          player.vel.z += z * 1.5;
          impact(0.05, 0.3);
          if (vitals.dead) die();
          break;
        }
        // not enough breath to hold it: the guard is battered down and half the blow gets through
        vitals.spend(vitals.stamina);
        vitals.hurt(d * 0.5);
        player.forceMove('guardbreak');
        ui.toast('Guard broken!');
        impact(0.08, 0.6);
        if (vitals.dead) die();
        break;
      }
      // armour on the struck place turns away part of the blow, and keeps the edge out of the flesh
      const prot = protection(inventory.equipped, m.zone);
      const through = d * (1 - prot);
      const bleed = through * ZONES[m.zone].bleed * num(m.edge, 0, 1) * (1 - prot);
      vitals.hurt(through, bleed);
      ui.toast(`${foe.name} struck your ${ZONES[m.zone].name}${prot >= 0.5 ? ' · the armour held' : bleed >= 0.5 ? ' · bleeding' : ''}`);
      chromaPulse = 0.035;
      impact(0.07, 0.5);
      // battered past our poise: stagger (cutting short whatever we were doing); otherwise a shove
      if (vitals.batter(poise * (1 - prot * 0.5)) && !player.exposed) player.forceMove('stagger', player.facing, 0);
      else {
        player.vel.x += x * 2;
        player.vel.z += z * 2;
      }
      if (vitals.dead) die();
      break;
    }
    case 'dead':
      remote.hp = 0;
      remote.dead = true;
      foe.card.classList.add('out');
      if (phase === 'fight' && foes.some(standing)) ui.toast(`${foe.name} has fallen`);
      checkVictory();
      break;
    case 'rematch':
      if (link.mode !== 'duel' || phase !== 'over' || rematch.closed) break;
      rematch.theirs = true;
      if (rematch.mine) beginMatch();
      break;
  }
}

/** We are the last one standing: the bout is ours. */
function checkVictory() {
  if ((phase !== 'fight' && phase !== 'countdown') || vitals.dead || foes.some(standing)) return;
  const fled = foes.every((f) => f.gone && !f.remote.dead);
  finish('Victory', fled ? (foes.length > 1 ? 'Your opponents fled' : 'Your opponent fled') : link?.mode === 'ffa' ? 'Last one standing' : '');
  if (!fled) rewardGuestWin(); // as on the server: a win where everyone fled earns nothing
}

/** A fighter has left the match: mid-bout that counts as fleeing (out of the bout). */
function onLeft(seat: number) {
  const f = foeAt(seat);
  if (!f || f.gone) return;
  f.gone = true;
  if (!f.remote.dead) f.body.root.visible = false; // fled: gone from the sand (a body that fell stays where it lies)
  f.card.classList.add('out');
  if (phase === 'fight' || phase === 'countdown') {
    ui.toast(`${f.name} has fled`);
    checkVictory();
  } else if (phase === 'over' && link?.mode === 'duel' && !rematch.closed) {
    rematch.closed = rematch.mine ? 'Your opponent did not take the rematch' : 'Your opponent has left';
  }
}

/** Our own connection to the match is gone. */
function onLost() {
  search = link = null;
  if (phase === 'countdown' || phase === 'fight') finish('Disconnected', 'Lost the connection to the match server');
  else if (phase === 'over') rematch.closed ??= 'The connection was lost';
  else if (phase === 'searching') {
    ui.toast('Lost the connection to the match server');
    toLobby();
  }
}

/** Leave the match politely: tell the others, then hang up once the message is out. */
function hangUp() {
  link?.send({ t: 'leave' });
  search?.close(300);
  search = link = null;
}

/** Out of health, from a blow or from bleeding. */
function die() {
  if (phase !== 'fight') return;
  player.collapse();
  link?.send({ t: 'dead' });
  const left = foes.filter(standing).length;
  finish('Defeat', link?.mode === 'ffa' && left > 1 ? `${left} fighters still standing` : '');
}

/** The bout is decided for us: show the result and free the mouse to click it. */
function finish(title: string, note = '') {
  phase = 'over';
  phaseT = REMATCH_WINDOW;
  rematch.mine = rematch.theirs = false;
  // only a duel can be fought again; a free-for-all breaks up and everyone finds a new match
  rematch.closed = link?.mode !== 'duel' ? '' : foes.every((f) => f.gone) ? 'Your opponent has left' : null;
  resultTitle.textContent = title;
  resultEl.dataset.note = note;
  resultEl.hidden = false;
  resultBtn('rematch').hidden = link?.mode !== 'duel';
  banner('');
  if (!menu.hidden) setMenu(false);
  document.exitPointerLock();
}

const resultEl = document.getElementById('result')!;
const resultTitle = resultEl.querySelector('.result-title')!, resultNote = resultEl.querySelector('.result-note')!;
const resultBtn = (act: string) => resultEl.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
resultEl.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (!act || phase !== 'over') return;
  if (act === 'rematch') {
    if (rematch.closed !== null || rematch.mine) return;
    rematch.mine = true;
    link?.send({ t: 'rematch' });
    if (rematch.theirs) beginMatch();
    lock();
    return;
  }
  hangUp();
  toLobby();
  if (act === 'again') startSearch({ kind: 'queue' });
  lock();
});
/** Keep the result panel's buttons and note in step with the rematch state. */
function renderResult() {
  const secs = Math.max(0, Math.ceil(phaseT));
  const btn = resultBtn('rematch');
  btn.disabled = rematch.closed !== null || rematch.mine;
  const label = rematch.closed !== null ? 'Rematch' : rematch.mine ? `Waiting for your opponent… ${secs}` : `Rematch · ${secs}`;
  if (btn.textContent !== label) btn.textContent = label;
  const note = rematch.closed || (rematch.theirs ? 'Your opponent wants a rematch' : resultEl.dataset.note ?? '');
  if (resultNote.textContent !== note) resultNote.textContent = note;
}

/** Alone on the sand with the training posts. Gear can still be changed; P goes back to the main menu. */
function togglePractice() {
  if (phase === 'practice') return toLobby();
  if (phase !== 'lobby') return;
  phase = 'practice';
  hideMain();
  arena.setPractice(true);
  site.side = 0;
  site.zone = 'arena';
  const drop = new THREE.Vector3(0, 0, 9);
  drop.y = groundHeight(drop.x, drop.z);
  player.place(drop, Math.PI); // facing the posts in the middle
  focus.copy(drop);
  yaw = 0;
  pitch = REST_PITCH;
}

/** Back to the north room, healed, gates shut, and out to the main menu to change gear or search again. */
function toLobby() {
  search?.close();
  search = link = null;
  lobbyInfo = null;
  phase = 'lobby';
  resultEl.hidden = true;
  arena.setPractice(false);
  if (!menu.hidden) setMenu(true);
  for (let g = 0; g < GATES; g++) arena.setGate(g, false);
  site.side = 0;
  site.zone = 'room';
  const home = spawnPoint(0);
  player.place(home.pos, home.facing);
  focus.copy(home.pos);
  yaw = gateYaw(0);
  pitch = REST_PITCH;
  vitals.restore();
  inventory.locked = false;
  for (const f of foes) dropFoe(f);
  foes = [];
  openMain();
}

/** The banner while waiting in a free-for-all lobby: who is in, and the vote to start early. */
function lobbyBanner() {
  if (!lobbyInfo) return 'Joining a free-for-all…  ·  <b>F</b> leave';
  const n = lobbyInfo.players.length, votes = lobbyInfo.players.filter((p) => p.vote).length;
  const names = lobbyInfo.players.map((p) => `${esc(p.name)}${p.vote ? ' ✓' : ''}`).join(' · ');
  const vote = n < 2 ? 'waiting for another fighter' : `<b>V</b> ${myVote ? 'take back your vote' : 'vote to start now'} (${votes}/${n})`;
  return `Free-for-all · <b>${n}/${GATES}</b> fighters  ·  ${vote}  ·  <b>F</b> leave<div class="match-sub">${names}</div>`;
}

function updateMatch(dt: number) {
  if (phase === 'lobby') banner('');
  else if (phase === 'practice') banner('Practice · <b>P</b> main menu');
  else if (phase === 'searching')
    banner(
      searchMode.kind === 'host'
        ? `Your code: <b>${searchMode.code}</b> · give it to your friend for a duel · <b>F</b> cancel`
        : searchMode.kind === 'join'
          ? `Joining <b>${searchMode.code}</b>… · <b>F</b> cancel`
          : lobbyBanner(),
    );
  else if (phase === 'countdown') {
    phaseT -= dt;
    const who = link?.mode === 'ffa' ? `${foes.length + 1} fighters` : 'Opponent found';
    banner(`${who} · the gates open in <b>${Math.max(1, Math.ceil(phaseT))}</b>`);
    if (phaseT <= 0) {
      phase = 'fight';
      bannerT = 2.5;
      arena.setGate(site.side, true);
      for (const f of foes) if (!f.gone) arena.setGate(f.seat, true);
      checkVictory(); // everyone else may have fled during the countdown
    }
  } else if (phase === 'fight') {
    bannerT -= dt;
    banner(bannerT > 0 ? '<b>Fight!</b>' : '');
    // each gate drops once its fighter is well out on the sand: no way back
    if (site.zone === 'room' && arena.gateOpen(site.side) && Math.hypot(player.pos.x, player.pos.z) < R - GATE_CLEAR) {
      site.zone = 'arena';
      arena.setGate(site.side, false);
    }
    for (const f of foes)
      if (!f.gateShut && (f.gone || Math.hypot(f.body.pos.x, f.body.pos.z) < R - GATE_CLEAR)) {
        f.gateShut = true;
        arena.setGate(f.seat, false);
      }
  } else if (phase === 'over') {
    // a duel's rematch offer lapses: nobody is left waiting on a player who won't answer
    if (link?.mode === 'duel' && rematch.closed === null && (phaseT -= dt) <= 0) {
      rematch.closed = rematch.mine ? 'Your opponent did not take the rematch' : 'The rematch offer has lapsed';
      hangUp();
    }
    renderResult();
  }
  const fighting = phase === 'countdown' || phase === 'fight' || phase === 'over';
  foeCards.hidden = !fighting || foes.length === 0;
  if (fighting) for (const f of foes) f.fill.style.width = `${f.remote.hp * 100}%`;
}

/** Tell the others where we are. `still` = report standing at rest (the tab is in the background and nothing is moving). */
function sendState(move: { x: number; z: number }, free: boolean, backpedal: boolean, still = false) {
  if (!link || phase === 'lobby' || phase === 'searching' || phase === 'practice') return;
  const p = player.pos, v = still ? ZERO : player.vel;
  link.send({
    t: 's', p: [p.x, p.y, p.z], v: [v.x, v.y, v.z], f: player.facing, a: yaw + Math.PI, m: [move.x, move.z],
    b: (free ? 1 : 0) | (backpedal ? 2 : 0) | (player.ragdolled ? 4 : 0) | (blockHeld ? 8 : 0), hp: vitals.health / vitals.maxHealth,
  });
}
const ZERO = new THREE.Vector3();

// A hidden tab gets no animation frames. Timers still run there (about once a second, slower after a
// while), so they keep the match clock and our fighter's state going. Staying connected is net.ts's job.
let hiddenLast = 0;
document.addEventListener('visibilitychange', () => void (hiddenLast = performance.now()));
window.setInterval(() => {
  if (!document.hidden) return;
  const now = performance.now();
  const dt = Math.min((now - hiddenLast) / 1000, 2);
  updateMatch(dt);
  vitals.update(dt, false); // wounds keep bleeding while the tab is in the background
  if (vitals.dead) die();
  hiddenLast = now;
  sendState(ZERO, false, false, true);
}, 250);

/** Move the other fighters' bodies: replay their inputs through the same character code, pulled toward where they say they are. */
function updateFoes(dt: number, move: { x: number; z: number }, free: boolean, backpedal: boolean) {
  sendT -= dt;
  if (sendT <= 0) {
    sendT = 1 / SEND_HZ;
    sendState(move, free, backpedal);
  }
  for (const foe of foes) {
    const body = foe.body, remote = foe.remote;
    if (!body.root.visible) continue;
    const limp = remote.dead || (remote.bits & 4) !== 0; // a fallen fighter drops whether or not their own screen has caught up
    if (!body.ragdolled) {
      const age = Math.min(0.25, (performance.now() - remote.at) / 1000);
      const dx = remote.p.x + remote.v.x * age - body.pos.x, dz = remote.p.z + remote.v.z * age - body.pos.z;
      const k = Math.hypot(dx, dz) > 3 ? 1 : 1 - Math.exp(-10 * dt); // far off: snap; otherwise ease
      body.pos.x += dx * k;
      body.pos.z += dz * k;
    }
    body.stayDown = limp;
    if (remote.attack) body.forceMove(remote.attack.k, remote.attack.f, remote.attack.aim, remote.attack.d);
    if (remote.released) body.releaseCharge();
    remote.attack = null;
    remote.released = false;
    // whoever is nearest them (us, or another fighter) is who they square up to
    let target = vitals.dead ? null : player.pos, best = target ? body.pos.distanceTo(target) : Infinity;
    for (const o of foes)
      if (o !== foe && o.body.root.visible && standing(o)) {
        const d = body.pos.distanceTo(o.body.pos);
        if (d < best) {
          best = d;
          target = o.body.pos;
        }
      }
    body.update(dt, {
      moveX: remote.mx, moveZ: remote.mz, free: (remote.bits & 1) !== 0, backpedal: (remote.bits & 2) !== 0,
      attack: false, block: (remote.bits & 8) !== 0, ragdoll: limp !== body.ragdolled, aimYaw: remote.a, aim: 0,
      threat: best, target: target ?? player.pos,
    });
    body.started.length = 0;
    body.released = false;
  }
}

// --- landing blows: the blade (or fist) must actually pass through a body part or prop while the swing is live ---
let chromaPulse = 0;
const STRIKE_SUBSTEPS = 4; // fast swings travel far between frames: test the sweep in between too
const bladeA = new THREE.Vector3(), bladeB = new THREE.Vector3(), prevA = new THREE.Vector3(), prevB = new THREE.Vector3();
const segA = new THREE.Vector3(), segB = new THREE.Vector3(), swingDir = new THREE.Vector3();
let swingSeen = -1, wasStriking = false;
/** Opponents (by seat) this swing has already landed on: one hit on each per swing. */
const foesStruck = new Set<number>();
/** Until when (ms) our parry has the opponent reeling: the next blow that lands is a riposte. */
let riposteUntil = 0;
const RIPOSTE_MS = 1300, RIPOSTE_MULT = 3;
// defending: a blow counts as from the front within about 70° of where we face
const FRONT_COS = 0.35;
// a blow taken on the guard costs this much stamina per point of damage, and still lets this share through
const BLOCK_STAMINA = 2.2, BLOCK_CHIP = 0.12;

// --- impact feel: a brief freeze on contact (hitstop) and a jolt of the camera ---
let hitstop = 0, shake = 0;
function impact(stop: number, jolt: number) {
  hitstop = Math.max(hitstop, stop);
  shake = Math.max(shake, jolt);
}
const propsStruck = new Set<object>();
/** Each frame: sweep the weapon from where it was to where it is, and see what it cut through. One hit on each opponent per swing. */
function resolveStrike() {
  if (!player.striking) {
    wasStriking = false;
    return;
  }
  if (player.swing !== swingSeen) {
    swingSeen = player.swing;
    wasStriking = false;
    foesStruck.clear();
    propsStruck.clear();
  }
  const wr = player.weaponSegment(bladeA, bladeB);
  if (!wasStriking) {
    prevA.copy(bladeA);
    prevB.copy(bladeB);
  }
  wasStriking = true;
  const w = inventory.equipped.weapon, def = w ? ITEMS[w] : null;
  const kind = player.currentMove, info = MOVE_INFO[kind];
  const charge = kind === 'heavy' ? 1 + player.charge * HEAVY_CHARGE_BONUS : 1;
  const power = (def?.power ?? 0.5) * vitals.power * info.dmg * charge;
  swingDir.set(Math.sin(player.facing), 0, Math.cos(player.facing));
  // the attacker's own view decides whether a blow lands; the victim's machine applies armour, damage and bleeding
  const targets = phase === 'fight' && link ? foes.filter((f) => standing(f) && f.remote.hp > 0 && !foesStruck.has(f.seat)) : [];
  const parts = targets.map((f) => ({ f, parts: f.body.bodyParts() }));
  let hits = 0;
  for (let i = 1; i <= STRIKE_SUBSTEPS; i++) {
    segA.lerpVectors(prevA, bladeA, i / STRIKE_SUBSTEPS);
    segB.lerpVectors(prevB, bladeB, i / STRIKE_SUBSTEPS);
    hits += arena.touch(segA, segB, wr, swingDir, power, propsStruck);
    for (const { f, parts: body } of parts) {
      if (foesStruck.has(f.seat)) continue;
      const zone = touchedPart(body, segA, segB, wr);
      if (!zone) continue;
      foesStruck.add(f.seat);
      // a blow on an opponent reeling from our parry is a riposte: it lands far harder
      const riposte = performance.now() < riposteUntil;
      if (riposte) riposteUntil = 0;
      const crit = riposte ? RIPOSTE_MULT : 1;
      link!.send({ t: 'hit', zone, d: BASE_DAMAGE * power * ZONES[zone].damage * crit, edge: def?.edge ?? 0, x: swingDir.x, z: swingDir.z, poise: info.poise * crit }, f.seat);
      ui.toast(riposte ? `Riposte to ${f.name}'s ${ZONES[zone].name}!` : `You struck ${f.name}'s ${ZONES[zone].name}`);
      impact(riposte ? 0.12 : kind === 'heavy' ? 0.09 : 0.06, riposte ? 0.6 : 0.3);
      hits++;
    }
  }
  prevA.copy(bladeA);
  prevB.copy(bladeB);
  if (hits > 0) chromaPulse = 0.02;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  post.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// --- input ---
const keys = new Set<string>();
let locked = false, yaw = 0, pitch = REST_PITCH;
// presses since the last frame (the fighter buffers them, so an early press still lands), and what is held
const pressed = { attack: false, dodge: false, parry: false };
let mouseHeld = false, blockHeld = false;
const canvas = renderer.domElement;
// Pause menu: shown in the arena whenever the mouse is free and the inventory isn't, so Esc (which the
// browser spends on releasing pointer lock) brings it up.
// --- main menu: the whole screen between bouts. Log in, pick gear, shop; the game shows once queueing or practising ---
const mainEl = document.getElementById('main')!, mainBody = mainEl.querySelector<HTMLElement>('.main-body')!;
const mainPage = document.getElementById('main-page')!;
// in the menu the inventory takes the place of the cards on the right; in the arena it floats at the side
ui.onChange = (open, tab) => {
  mainBody.classList.toggle('inv-docked', open && mainOpen);
  for (const [act, t] of [['gear', 0], ['character', SHEET_TAB]] as const)
    mainEl.querySelector(`.main-nav [data-act="${act}"]`)!.classList.toggle('on', open && mainOpen && tab === t);
};
ui.onClose = () => (mainOpen ? ui.setOpen(false) : setInventoryOpen(false));
let mainOpen = !mainEl.hidden;
function openMain() {
  if (phase !== 'lobby') return; // only between bouts
  mainOpen = true;
  mainEl.hidden = false;
  document.body.classList.add('in-main');
  menu.hidden = true;
  closeShop(false);
  if (ui.open) ui.setOpen(false);
  ui.mount(mainPage);
  if (document.pointerLockElement) document.exitPointerLock();
  renderAccount();
  renderRank();
  renderMainNav();
  refreshLeaderboard(true);
}
/** While a search is connecting from the menu: Find becomes Cancel, the other ways in wait. */
function renderMainNav() {
  const busy = phase === 'searching';
  const btn = (act: string) => mainEl.querySelector<HTMLButtonElement>(`.main-nav [data-act="${act}"]`)!;
  btn('search').innerHTML = busy
    ? `${searchMode.kind === 'join' ? `Joining ${searchMode.code}` : 'Connecting'}… · cancel`
    : 'Free for all <kbd>F</kbd>';
  for (const act of ['host', 'join', 'practice']) btn(act).disabled = busy;
}
function hideMain() {
  if (!mainOpen) return;
  mainOpen = false;
  mainEl.hidden = true;
  document.body.classList.remove('in-main');
  closeShop(false);
  if (ui.open) ui.setOpen(false);
  ui.mount(null);
}
mainEl.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (!act) return;
  if (act === 'login' || act === 'register') return void enterAccount(act);
  if (act === 'logout') {
    clearTimeout(saveTimer);
    account.logout();
    syncInventory(loadLocalGear()); // back to this browser's guest gear
    return;
  }
  if (act === 'shop') return openShop();
  if (act === 'gear') return ui.setOpen(!(ui.open && ui.tab === 0), 0);
  if (act === 'character') return ui.setOpen(!(ui.open && ui.tab === SHEET_TAB), SHEET_TAB);
  if (act === 'search' && phase === 'searching') return toggleSearch(); // cancel while still connecting
  if (act === 'join' && !joinByCode()) return;
  if (act === 'search') startSearch({ kind: 'queue' });
  if (act === 'host') startSearch({ kind: 'host', code: makeCode() });
  if (act === 'practice') togglePractice();
  lock(); // only takes the mouse once the menu has closed
});

// --- shop: gear for gold. Logged in, the server checks and records each purchase; a guest's stay in this browser ---
const shopEl = document.getElementById('shop')!, shopList = document.getElementById('shop-list')!;
const shopGold = document.getElementById('shop-gold')!, shopNote = document.getElementById('shop-note')!;
let shopOpen = false, shopBusy = false;
function openShop() {
  if (!mainOpen) return ui.toast('The shop is open from the main menu');
  shopOpen = true;
  shopEl.hidden = false;
  menu.hidden = true;
  if (ui.open) ui.setOpen(false);
  shopNote.textContent = account.profile?.admin ? 'Admin: you own every item.' : '';
  if (document.pointerLockElement) document.exitPointerLock();
  renderShop();
}
function closeShop(backToMenu = true) {
  if (!shopOpen) return;
  shopOpen = false;
  shopEl.hidden = true;
  if (backToMenu) setMenu(true);
}
/** What an item does, in a few words. */
function itemEffect(id: string) {
  const d = ITEMS[id];
  if (d.power) return `Weapon · hit force ×${d.power} · ${(d.edge ?? 0) >= 0.7 ? 'sharp' : 'blunt'}${d.twoHanded ? ' · two-handed, long reach' : ''}`;
  if (d.guard) return 'Shield · hold E to block: cheaper and wider than a blade';
  const cover = Object.entries(d.covers ?? {}).map(([z, p]) => `${ZONES[z as keyof typeof ZONES].name} ${Math.round(p * 100)}%`);
  return cover.length ? `Armour · ${cover.join(', ')}` : 'No protection: for the look';
}
function renderShop() {
  if (!shopOpen) return;
  const gold = career().money, own = new Set(owned());
  shopGold.textContent = `${gold.toLocaleString()} gold`;
  shopList.replaceChildren(
    ...SHOP.map((d) => {
      const row = document.createElement('div');
      row.className = 'shop-item';
      const icon = row.appendChild(document.createElement('div'));
      icon.className = 'icon';
      icon.innerHTML = iconSVG(d);
      const text = row.appendChild(document.createElement('div'));
      text.appendChild(document.createElement('div')).className = 'name';
      (text.firstChild as HTMLElement).textContent = d.name;
      const effect = text.appendChild(document.createElement('div'));
      effect.className = 'effect';
      effect.textContent = itemEffect(d.id);
      const btn = row.appendChild(document.createElement('button'));
      const have = own.has(d.id);
      btn.textContent = have ? 'Owned' : `${d.price} gold`;
      btn.disabled = have || shopBusy || gold < d.price!;
      btn.title = have ? 'Already yours' : gold < d.price! ? `You need ${d.price! - gold} more gold` : `Buy ${d.name}`;
      btn.addEventListener('click', () => void buy(d.id));
      return row;
    }),
  );
}
async function buy(id: string) {
  const d = ITEMS[id];
  if (shopBusy || !d.price || owned().includes(id)) return;
  if (account.loggedIn) {
    shopBusy = true;
    renderShop();
    const failed = await buyItem(id);
    shopBusy = false;
    if (failed) {
      shopNote.textContent = failed;
      return renderShop();
    }
  } else {
    if (localCareer.money < d.price) return void (shopNote.textContent = 'Not enough gold');
    localCareer.money -= d.price;
    localOwned.push(id);
    saveLocalCareer(localCareer);
    saveLocalOwned(localOwned);
    renderAccount();
  }
  shopNote.textContent = '';
  syncInventory(inventory.snapshot()); // the new item goes into the bag
  ui.toast(`Bought ${d.name}: equip it from your bag (Tab)`);
  if (ui.open && ui.tab === SHEET_TAB) sheet.render();
  renderShop();
}
shopEl.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button')?.dataset.act === 'close') closeShop();
});

const menu = document.getElementById('menu')!;
const menuBtn = (act: string) => menu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
const joinInput = document.getElementById('join-code') as HTMLInputElement;
const nameInput = document.getElementById('player-name') as HTMLInputElement;
const NAME_KEY = 'gladiators-name';
try {
  nameInput.value = cleanName(localStorage.getItem(NAME_KEY));
} catch {}
/** Logged in, the fighter goes by the account's username; a guest types a name. */
const playerName = () => account.profile?.name ?? cleanName(nameInput.value);
nameInput.addEventListener('input', () => {
  nameInput.classList.remove('missing');
  try {
    localStorage.setItem(NAME_KEY, playerName());
  } catch {}
});
/** Fighting someone needs a name: if there isn't one yet, point at the name box and say so. */
function requireName(): boolean {
  if (playerName()) return true;
  ui.toast('Name your gladiator first, or log in');
  nameInput.classList.add('missing');
  openMain();
  nameInput.focus();
  return false;
}
// --- accounts: log in to keep progress and appear on the leaderboard; guests play without saving ---
const accountEl = document.getElementById('account')!;
const userInput = document.getElementById('acct-user') as HTMLInputElement, passInput = document.getElementById('acct-pass') as HTMLInputElement;
const acctNote = accountEl.querySelector('.acct-note')!;
const acctMsg = document.getElementById('acct-msg')!, nameLabel = nameInput.closest('label')!;
const boardEl = document.getElementById('leaderboard')!;
let accountBusy = false;

function renderAccount() {
  const p = account.profile;
  accountEl.dataset.state = p ? 'user' : 'guest';
  nameLabel.hidden = !!p; // logged in, the username is the fighter's name
  if (p) {
    document.getElementById('acct-name')!.textContent = p.name;
    document.getElementById('acct-record')!.textContent =
      `Level ${p.career.level} · ${p.career.money.toLocaleString()} gold · ${p.wins} ${p.wins === 1 ? 'win' : 'wins'} · ${p.losses} ${p.losses === 1 ? 'loss' : 'losses'}`;
  } else {
    const k = localCareer, fresh = k.level === 1 && k.xp === 0 && k.money === 0;
    acctNote.textContent = fresh
      ? 'Log in to save your progress to the cloud and count your wins. Guests keep their progress on this computer only.'
      : `As a guest you are level ${k.level} with ${k.money.toLocaleString()} gold, saved on this computer only. Create an account to keep it: your level, skills, gold and gear come with you.`;
  }
  for (const b of accountEl.querySelectorAll('button')) b.disabled = accountBusy;
}

account.onChange = () => {
  renderAccount();
  applyCareer();
  renderShop();
  if (!account.offline) refreshLeaderboard(true);
};

/** Logged in: bring in the account's saved inventory, or give a new account the current one. */
/** Logged in: wear and carry what the account owns, as it was last arranged. */
function adoptProgress() {
  if (!account.profile) return;
  clearTimeout(saveTimer); // a guest save still pending must not land on the account
  syncInventory(account.profile.progress ?? null);
  if (!account.profile.progress && !account.offline) void account.save(inventory.snapshot());
}

async function enterAccount(op: 'login' | 'register') {
  if (accountBusy) return;
  const name = userInput.value.trim(), password = passInput.value;
  const problem = !USERNAME.test(name)
    ? 'Usernames are 3–16 letters, numbers or _'
    : password.length < PASSWORD_MIN
      ? `Passwords need at least ${PASSWORD_MIN} characters`
      : null;
  if (problem && (op === 'register' || !name || !password)) return void (acctMsg.textContent = problem);
  accountBusy = true;
  acctMsg.textContent = op === 'register' ? 'Creating account…' : 'Logging in…';
  renderAccount();
  // signing up carries the guest's career (level, skills, gold) and gear into the new account
  const inherit = op === 'register' ? { career: localCareer, owned: localOwned, progress: inventory.snapshot() } : undefined;
  const failed = await account.enter(op, name, password, inherit);
  if (!failed && op === 'register') {
    // it belongs to the account now: the guest in this browser starts over, so it can't be carried into a second account
    localCareer = freshCareer();
    localOwned = [...STARTER];
    saveLocalCareer(null);
    saveLocalOwned(null);
    saveLocalGear(null);
  }
  accountBusy = false;
  acctMsg.textContent = failed ?? '';
  if (!failed) {
    passInput.value = '';
    adoptProgress();
    ui.toast(op === 'register' ? `Welcome, ${account.profile!.name}` : `Welcome back, ${account.profile!.name}${account.offline ? ' (offline)' : ''}`);
  }
  renderAccount();
}

let boardAt = 0;
/** The leaderboard in the menu: refreshed when the menu opens (at most every 15 s) or a result comes in. */
function refreshLeaderboard(force = false) {
  const now = performance.now();
  if (!force && now - boardAt < 15_000) return;
  boardAt = now;
  void fetchLeaderboard().then((top) => {
    boardEl.replaceChildren();
    if (!top) return void (boardEl.innerHTML = '<li class="board-empty">Leaderboard unavailable</li>');
    if (top.length === 0) return void (boardEl.innerHTML = '<li class="board-empty">No wins recorded yet</li>');
    top.forEach((e, i) => {
      const li = boardEl.appendChild(document.createElement('li'));
      if (i === 0) li.className = 'board-top';
      const name = li.appendChild(document.createElement('span'));
      name.textContent = e.name;
      if (e.name === account.profile?.name) li.classList.add('board-me');
      li.appendChild(document.createElement('b')).textContent = String(e.wins);
    });
  });
}

// a real form, so password managers offer to save the login; submitting it never reloads the page
document.getElementById('acct-form')!.addEventListener('submit', (e) => e.preventDefault());

applyCareer();
renderAccount();
void account.resume().then((ok) => ok && adoptProgress());

/** Join a friend's match with the code typed into the menu. Returns false (menu stays open) if it isn't a valid code. */
function joinByCode(): boolean {
  const code = cleanCode(joinInput.value);
  if (!code) {
    ui.toast('Codes are 5 letters and numbers');
    joinInput.focus();
    return false;
  }
  joinInput.value = '';
  startSearch({ kind: 'join', code });
  return true;
}
function setMenu(open: boolean) {
  menu.hidden = !open || mainOpen || shopOpen; // the main menu and the shop each take the place of the pause menu
  if (menu.hidden) return;
  // the way out follows the match state
  const inLobby = phase === 'searching' && searchMode.kind === 'queue';
  menuBtn('vote').hidden = !inLobby || !lobbyInfo || lobbyInfo.players.length < 2;
  menuBtn('vote').textContent = myVote ? 'Take back your vote to start' : 'Vote to start now';
  menuBtn('leave').textContent =
    inLobby ? 'Leave the lobby · main menu'
      : phase === 'searching' ? 'Stop searching · main menu'
      : phase === 'practice' ? 'Leave practice · main menu'
        : phase === 'countdown' || phase === 'fight' ? 'Flee the arena · main menu'
          : 'Main menu';
}
const lock = () => {
  if (mainOpen || shopOpen) return; // the cursor belongs to the menus
  void Promise.resolve(canvas.requestPointerLock()).catch(() => {
    if (!ui.open) setMenu(true); // the browser refused (e.g. just after Esc): don't leave the player stuck without a cursor or a menu
  });
};
menu.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (!act) return;
  if (act === 'leave') return toLobby(); // mid-bout this hangs up: the others count us as fled
  if (act === 'vote') toggleVote();
  setMenu(false);
  lock();
});
function setInventoryOpen(open: boolean, tab?: number) {
  ui.setOpen(open, tab);
  if (open) {
    setMenu(false);
    document.exitPointerLock();
  } else lock();
}
canvas.addEventListener('click', () => {
  if (mainOpen || shopOpen) return;
  if (ui.open) setInventoryOpen(false);
  else if (!locked) lock();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  setMenu(!locked && !ui.open && phase !== 'over'); // after a bout the result panel takes the mouse instead
  if (!locked) {
    keys.clear();
    mouseHeld = false;
  }
});
document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  yaw -= e.movementX * SENS;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * SENS, -1.1, 0.45);
});
document.addEventListener('mousedown', (e) => {
  if (locked && e.button === 0) {
    pressed.attack = true;
    mouseHeld = true;
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseHeld = false;
});
document.addEventListener('keydown', (e) => {
  // typing a username or password: keys are text, not controls (Enter logs in)
  if (e.target === userInput || e.target === passInput) {
    if (e.code === 'Enter') void enterAccount('login');
    if (e.code !== 'Escape') return;
  }
  // typing a friend's code: keys are text, not controls (Enter joins)
  if (e.target === nameInput) {
    if (e.code === 'Enter') nameInput.blur();
    if (e.code !== 'Escape') return;
  }
  if (e.target === joinInput) {
    if (e.code === 'Enter' && joinByCode()) lock();
    if (e.code !== 'Escape') return;
  }
  if (shopOpen) {
    if (e.code === 'Escape' && !e.repeat) closeShop();
    return;
  }
  if (mainOpen) {
    // the main menu takes no fighting keys: only its shortcuts
    if (e.code === 'Tab' || e.code === 'KeyI' || (e.code === 'Escape' && ui.open)) {
      e.preventDefault();
      if (!e.repeat) ui.setOpen(!ui.open, 0);
    } else if (e.code === 'KeyC' && !e.repeat) ui.setOpen(!(ui.open && ui.tab === SHEET_TAB), SHEET_TAB);
    else if (e.code === 'KeyF' && !e.repeat) startSearch({ kind: 'queue' });
    else if (e.code === 'KeyP' && !e.repeat) togglePractice();
    if ((e.code === 'KeyF' || e.code === 'KeyP') && !mainOpen) lock();
    return;
  }
  if (e.code === 'Escape' && !ui.open) {
    // only reaches us while the mouse is already free: toggle the menu
    if (!e.repeat) {
      if (menu.hidden) setMenu(true);
      else {
        setMenu(false);
        lock();
      }
    }
    return;
  }
  if (e.code === 'Tab' || e.code === 'KeyI' || (e.code === 'Escape' && ui.open)) {
    e.preventDefault();
    if (!e.repeat) setInventoryOpen(!ui.open, 0);
    return;
  }
  if (e.code === 'KeyC') {
    // straight to the character sheet; pressed again while it shows, closes the panel
    if (!e.repeat) setInventoryOpen(!(ui.open && ui.tab === SHEET_TAB), SHEET_TAB);
    return;
  }
  if (e.code === 'KeyF') {
    if (!e.repeat && phase === 'searching') toggleSearch();
    return;
  }
  if (e.code === 'KeyV') {
    if (!e.repeat) toggleVote();
    if (!menu.hidden) setMenu(true);
    return;
  }
  if (e.code === 'KeyP') {
    if (!e.repeat) togglePractice();
    if (!menu.hidden) setMenu(true);
    return;
  }
  if (!locked) return;
  keys.add(e.code);
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) pressed.dodge = true;
  }
  if (e.code === 'KeyQ' && !e.repeat) pressed.parry = true;
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

// --- aiming: the swing goes where the middle of the screen looks ---
const AIM_REACH = 1.3; // metres in front of the fighter where the view is read (about sword's reach)
const AIM_MID = 1.3, AIM_SPAN = 0.4; // height (m) of a level swing, and how far above/below counts as fully high/low
const _aimN = new THREE.Vector3(), _aimP = new THREE.Vector3(), _aimF = new THREE.Vector3();
/**
 * -1..1: how high the middle of the view crosses a plane at sword's reach in front of the fighter.
 * About head height → 1, chest → 0, thighs → -1. With the middle of the view on the opponent's neck, the
 * blade comes in at the neck.
 */
function aimFromView() {
  _aimN.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // camera's horizontal forward
  camera.getWorldDirection(_aimF);
  _aimP.copy(player.pos).addScaledVector(_aimN, AIM_REACH).sub(camera.position);
  const along = _aimF.dot(_aimN);
  if (along < 1e-3) return 0;
  const h = camera.position.y + _aimF.y * (_aimP.dot(_aimN) / along) - player.pos.y;
  return THREE.MathUtils.clamp((h - AIM_MID) / AIM_SPAN, -1, 1);
}

// --- camera rig ---
const focus = player.pos.clone();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function updateCamera(dt: number) {
  // track x/z exactly (any lag here reads as the character stuttering); smooth only height over dunes
  focus.x = player.pos.x;
  focus.z = player.pos.z;
  focus.y += (player.pos.y - focus.y) * (1 - Math.exp(-10 * dt));
  const cp = Math.cos(pitch);
  fwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  const p = camera.position;
  p.copy(focus);
  p.y += SHOULDER.up;
  p.addScaledVector(right, SHOULDER.right).addScaledVector(fwd, -SHOULDER.back);
  // keep the camera inside the arena bowl and above the sand
  confine(p, 0.35);
  p.y = Math.max(groundHeight(p.x, p.z) + 0.3, Math.min(p.y, ceilingAt(p.x, p.z) - 0.25));
  // a blow landing jolts the view
  shake *= Math.exp(-14 * dt);
  const j = shake * 0.018;
  camera.rotation.set(pitch + (Math.random() - 0.5) * j, yaw + (Math.random() - 0.5) * j, 0);

  const ground = groundHeight(player.pos.x, player.pos.z);
  blob.position.set(player.pos.x, ground + 0.04, player.pos.z);
  blob.material.opacity = THREE.MathUtils.clamp(1 - (player.pos.y - ground) * 0.7, 0, 1);
}

const postAt = new THREE.Vector3();
function update(dt: number) {
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const len = Math.hypot(f, s) || 1;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  // stamina gates effort: no swing, dodge or parry without the breath for it
  blockHeld = keys.has('KeyE') && !player.ragdolled;
  // Shift: jog (faster, facing where you go)
  const free = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const move = { x: (-sin * f + cos * s) / len, z: (-cos * f - sin * s) / len };
  const backpedal = f < 0 && !free; // S without Shift: back up, still facing forward; with Shift, turn and jog
  // the nearest opponent on the sand (a fallen one still counts as near; only a standing one is a target)
  let foeNear = Infinity, foeTarget: THREE.Vector3 | null = null;
  for (const o of foes) {
    if (!o.body.root.visible) continue;
    const d = o.body.pos.distanceTo(player.pos);
    if (d < foeNear) foeNear = d;
    if (link && !o.body.ragdolled && standing(o) && (!foeTarget || d < foeTarget.distanceTo(player.pos))) foeTarget = o.body.pos;
  }
  // out of breath: say so plainly instead of silently ignoring the press (the press stays buffered a moment)
  if ((pressed.attack || pressed.dodge || pressed.parry) && !vitals.canAct) flashStamina();
  // hitstop: everything on the sand freezes for a few hundredths of a second when a blow connects
  const sdt = hitstop > 0 ? dt * 0.06 : dt;
  hitstop = Math.max(0, hitstop - dt);
  // the nearest enemy: an opponent, or in practice the nearest training post
  const nearPost = arena.nearestEnemy(player.pos, postAt);
  const target = foeTarget && (!nearPost || foeTarget.distanceTo(player.pos) <= nearPost.distanceTo(player.pos)) ? foeTarget : nearPost;
  player.speedMul = vitals.speed;
  player.update(sdt, {
    moveX: move.x,
    moveZ: move.z,
    free,
    backpedal,
    attack: pressed.attack,
    attackHeld: mouseHeld,
    dodge: pressed.dodge,
    parry: pressed.parry,
    block: blockHeld,
    canAct: vitals.canAct,
    target,
    ragdoll: false, // going limp is not a choice: only death drops you
    aimYaw: yaw + Math.PI, // camera looks down -Z at yaw 0; model faces +Z at 0
    aim: aimFromView(),
    threat: Math.min(arena.enemyDistance(player.pos), foeNear),
  });
  // pay for and announce every move started this frame (including reactions forced by a blow)
  for (const k of player.started) {
    vitals.spend(MOVE_INFO[k].cost);
    link?.send({ t: 'atk', k, f: player.facing, aim: isAttack(k) ? aimFromView() : 0, d: player.dodgeDir });
  }
  player.started.length = 0;
  if (player.released) {
    player.released = false;
    link?.send({ t: 'rel' });
  }
  vitals.update(dt, player.blocking);
  if (vitals.dead) die(); // bled out
  drawBars();
  if (ui.open && ui.tab === SHEET_TAB) sheet.render();
  pressed.attack = pressed.dodge = pressed.parry = false;
  updateMatch(dt);
  updateFoes(sdt, move, free, backpedal);
  // two bodies can't share the same patch of sand: step out of every opponent
  for (const o of foes) {
    const b = o.body;
    if (!b.root.visible || b.ragdolled || player.ragdolled) continue;
    const dx = player.pos.x - b.pos.x, dz = player.pos.z - b.pos.z, d = Math.hypot(dx, dz), min = player.radius + b.radius;
    if (d < min && d > 1e-4 && Math.abs(player.pos.y - b.pos.y) < 1.5) {
      player.pos.x = b.pos.x + (dx / d) * min;
      player.pos.z = b.pos.z + (dz / d) * min;
    }
  }
  resolveStrike();
  arena.update(dt, player);

  chromaPulse = Math.max(0, chromaPulse - dt * 0.1);
  post.setChroma(BASE_CHROMA + chromaPulse);
}

let last = performance.now(), slowMs = 0, slowFrames = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const raw = now - last;
  const dt = Math.min(raw / 1000, 0.05);
  last = now;
  // adaptive resolution: average over ~1.5 s; under ~48 fps → render fewer pixels
  if (raw < 200) {
    slowMs += raw;
    if (++slowFrames >= 90) {
      if (slowMs / slowFrames > 21 && pixelRatio > MIN_RATIO) {
        pixelRatio = Math.max(MIN_RATIO, pixelRatio - 0.25);
        renderer.setPixelRatio(pixelRatio);
        resize();
      }
      slowMs = slowFrames = 0;
    }
  }
  update(dt); // runs unlocked too (no input) so the idle pose and physics stay alive
  updateCamera(dt);
  updateFoeLabel();
  if (ui.open) turntable.draw(dt); // the fighter in the inventory / character panel
  post.render();
}
openMain(); // every visit begins at the main menu
frame();
