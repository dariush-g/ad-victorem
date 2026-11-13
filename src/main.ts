import * as THREE from 'three';
import { createArena, groundHeight, ceilingAt, confine, site, spawnPoint, R } from './arena';
import { createPost, BASE_CHROMA } from './post';
import { loadGladiator } from './gladiator';
import { ITEMS, SLOTS } from './items';
import { Inventory, createInventoryUI } from './inventory';
import { findOpponent, type Link, type Msg, type Search } from './net';
import { BASE_DAMAGE, ZONES, ZONE_LIST, protection, touchedPart } from './hits';
import { Vitals } from './stats';
import { createVitalBars, createCharacterSheet } from './character';
import { createPortrait } from './portrait';

const SENS = 0.0022;
// over-the-right-shoulder rig, in camera space relative to the character's upper chest
const SHOULDER = { right: 1.0, up: 1.62, back: 3.3 };

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
// the player starts in the north gateway room, facing its closed gate; the opponent's body waits unseen until a match
const [player, foe] = await Promise.all([
  loadGladiator(groundHeight, confine, spawnPoint(1).pos),
  loadGladiator(groundHeight, () => {}, spawnPoint(-1).pos),
]);
foe.root.visible = false;
scene.add(player.root, foe.root);

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
const ui = createInventoryUI(inventory);
// --- attributes, health and stamina ---
const vitals = new Vitals();
const drawBars = createVitalBars(vitals, document.getElementById('rank')!);
// armour summary for the character sheet: what each body zone is protected by, all worn pieces together
const sheet = createCharacterSheet(vitals, () => {
  const parts = ZONE_LIST.map((z) => [ZONES[z].name, Math.round(protection(inventory.equipped, z) * 100)] as const).filter(([, p]) => p > 0);
  return parts.length ? 'Armour: ' + parts.map(([n, p]) => `${n} ${p}%`).join(', ') : 'No armour';
});
const portrait = createPortrait(renderer, scene, player);
let portraitStale = true; // redraw the figure next time the sheet is in view
let portraitSettle = 0; // seconds until a second redraw, once swinging cloth has come to rest
const SHEET_TAB = ui.addTab('Character', sheet.el, () => {
  portraitStale = true;
  sheet.render();
});
const rankSub = document.querySelector('#rank .sub')!;
inventory.onChange = () => {
  for (const slot of SLOTS) player.equip(slot, inventory.equipped[slot]);
  portraitStale = true;
  const w = inventory.equipped.weapon;
  rankSub.textContent = `Slave · ${w ? ITEMS[w].name : 'Bare hands'}`;
  ui.render();
};
for (const id of ['rudis', 'subligaculum', 'cord']) inventory.wear(id);
for (const id of ['gladius', 'balteus', 'subligaculum_red', 'tunica', 'tunica_russa', 'galea', 'pectorale', 'manica', 'ocreae']) inventory.add(id);

// --- the duel: find an opponent from the room, gates rise, fight, back to the room ---
type Phase = 'lobby' | 'searching' | 'countdown' | 'fight' | 'over' | 'practice';
const COUNTDOWN = 4, AFTERMATH = 6, SEND_HZ = 30, SILENCE_MS = 6000;
const GATE_CLEAR = 3; // metres onto the sand before a gate drops behind its fighter
const ATTACK_KINDS = ['stand', 'walk', 'run'] as const;
let phase: Phase = 'lobby', phaseT = 0, bannerT = 0;
let search: Search | null = null, link: Link | null = null;
let sendT = 0, foeGateShut = false;
/** Last word from the other side. */
const remote = {
  p: new THREE.Vector3(), v: new THREE.Vector3(), f: 0, a: 0, mx: 0, mz: 0, bits: 0, hp: 1,
  at: 0, // when it arrived, ms
  dead: false,
  attack: null as { k: (typeof ATTACK_KINDS)[number]; f: number } | null,
  jump: false,
};
const matchEl = document.getElementById('match')!;
const foeBar = document.getElementById('foe')!, foeFill = foeBar.querySelector('i')!;
const banner = (html: string) => {
  if (matchEl.innerHTML !== html) matchEl.innerHTML = html;
};
const num = (x: unknown, lo = -1e4, hi = 1e4) => (typeof x === 'number' && Number.isFinite(x) ? THREE.MathUtils.clamp(x, lo, hi) : 0);

function toggleSearch() {
  if (phase === 'lobby') {
    phase = 'searching';
    search = findOpponent({ found: onFound, message: onMessage, lost: onLost });
  } else if (phase === 'searching') {
    search?.close();
    search = null;
    phase = 'lobby';
  }
}

function onFound(l: Link) {
  link = l;
  phase = 'countdown';
  if (!menu.hidden) setMenu(true);
  phaseT = COUNTDOWN;
  inventory.locked = true;
  ui.setOpen(false);
  if (!l.host) {
    // the guest fights from the south gate: same room, half a turn round the arena
    site.side = -1;
    player.place(new THREE.Vector3(-player.pos.x, player.pos.y, -player.pos.z), player.facing + Math.PI);
    yaw += Math.PI;
    focus.set(-focus.x, focus.y, -focus.z);
  }
  site.zone = 'room';
  const there = spawnPoint(site.side === 1 ? -1 : 1);
  foe.place(there.pos, there.facing);
  remote.p.copy(there.pos);
  remote.v.set(0, 0, 0);
  remote.f = remote.a = there.facing;
  remote.mx = remote.mz = remote.bits = 0;
  remote.hp = 1;
  remote.dead = false;
  remote.at = performance.now();
  remote.attack = null;
  remote.jump = false;
  foeGateShut = false;
  for (const slot of SLOTS) foe.equip(slot, null);
  foe.root.visible = true;
  l.send({ t: 'gear', gear: { ...inventory.equipped } });
}

/** Everything here comes from another player's machine: check it before using it. */
function onMessage(m: Msg) {
  if (!link) return;
  switch (m.t) {
    case 'gear':
      for (const slot of SLOTS) {
        const id = m.gear?.[slot];
        foe.equip(slot, typeof id === 'string' && Object.hasOwn(ITEMS, id) && ITEMS[id].slot === slot ? id : null);
      }
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
      if (ATTACK_KINDS.includes(m.k)) remote.attack = { k: m.k, f: num(m.f) };
      break;
    case 'jump':
      remote.jump = true;
      break;
    case 'hit': {
      if (phase !== 'fight' || vitals.dead || !ZONE_LIST.includes(m.zone)) break;
      // armour on the struck place turns away part of the blow, and keeps the edge out of the flesh
      const prot = protection(inventory.equipped, m.zone);
      const through = num(m.d, 0, 100) * (1 - prot);
      const bleed = through * ZONES[m.zone].bleed * num(m.edge, 0, 1) * (1 - prot);
      vitals.hurt(through, bleed);
      ui.toast(`Struck in the ${ZONES[m.zone].name}${prot >= 0.5 ? ' · the armour held' : bleed >= 0.5 ? ' · bleeding' : ''}`);
      chromaPulse = 0.035;
      const x = num(m.x, -1, 1), z = num(m.z, -1, 1);
      player.vel.x += x * 3; // knocked back along the blow
      player.vel.z += z * 3;
      if (vitals.dead) die();
      break;
    }
    case 'dead':
      if (phase === 'fight') {
        remote.hp = 0;
        remote.dead = true;
        finish('<b>Victory</b>');
      }
      break;
  }
}

function onLost() {
  if (phase === 'countdown' || phase === 'fight') finish('<b>Victory</b> · your opponent fled');
  else if (phase === 'over') link = null;
}

/** Out of health, from a blow or from bleeding. */
function die() {
  if (phase !== 'fight') return;
  player.collapse();
  link?.send({ t: 'dead' });
  finish('<b>Defeat</b>');
}

function finish(html: string) {
  phase = 'over';
  phaseT = AFTERMATH;
  banner(html);
}

/** Alone on the sand with the training posts. Gear can still be changed; P goes back to the room. */
function togglePractice() {
  if (phase === 'practice') return toLobby();
  if (phase !== 'lobby') return;
  phase = 'practice';
  arena.setPractice(true);
  site.side = 1;
  site.zone = 'arena';
  const drop = new THREE.Vector3(0, 0, 9);
  drop.y = groundHeight(drop.x, drop.z);
  player.place(drop, Math.PI); // facing the posts in the middle
  focus.copy(drop);
  yaw = 0;
  pitch = -0.12;
}

/** Back to the north room, healed, gates shut, free to change gear and search again. */
function toLobby() {
  search?.close();
  search = link = null;
  phase = 'lobby';
  arena.setPractice(false);
  if (!menu.hidden) setMenu(true);
  arena.setGate(1, false);
  arena.setGate(-1, false);
  site.side = 1;
  site.zone = 'room';
  const home = spawnPoint(1);
  player.place(home.pos, home.facing);
  focus.copy(home.pos);
  yaw = 0;
  pitch = -0.12;
  vitals.restore();
  inventory.locked = false;
  foe.root.visible = false;
}

function updateMatch(dt: number) {
  const now = performance.now();
  if (phase === 'lobby') banner('<b>F</b> Find an opponent · <b>P</b> Practice');
  else if (phase === 'practice') banner('Practice · <b>P</b> back to the room');
  else if (phase === 'searching') banner('Searching for an opponent… · <b>F</b> cancel');
  else if (phase === 'countdown') {
    phaseT -= dt;
    banner(`Opponent found · the gate opens in <b>${Math.max(1, Math.ceil(phaseT))}</b>`);
    if (phaseT <= 0) {
      phase = 'fight';
      bannerT = 2.5;
      arena.setGate(1, true);
      arena.setGate(-1, true);
    }
  } else if (phase === 'fight') {
    bannerT -= dt;
    banner(bannerT > 0 ? '<b>Fight!</b>' : '');
    // each gate drops once its fighter is well out on the sand: no way back
    if (site.zone === 'room' && arena.gateOpen(site.side) && Math.hypot(player.pos.x, player.pos.z) < R - GATE_CLEAR) {
      site.zone = 'arena';
      arena.setGate(site.side, false);
    }
    if (!foeGateShut && Math.hypot(foe.pos.x, foe.pos.z) < R - GATE_CLEAR) {
      foeGateShut = true;
      arena.setGate(site.side === 1 ? -1 : 1, false);
    }
    if (now - remote.at > SILENCE_MS) {
      search?.close();
      onLost();
    }
  } else if (phase === 'over' && (phaseT -= dt) <= 0) toLobby();
  const fighting = phase === 'fight' || phase === 'over';
  foeBar.hidden = !fighting;
  if (fighting) foeFill.style.width = `${remote.hp * 100}%`;
}

/** Tell the opponent where we are. `still` = report standing at rest (the tab is in the background and nothing is moving). */
function sendState(move: { x: number; z: number }, sprint: boolean, backpedal: boolean, still = false) {
  if (!link || phase === 'lobby' || phase === 'searching') return;
  const p = player.pos, v = still ? ZERO : player.vel;
  link.send({
    t: 's', p: [p.x, p.y, p.z], v: [v.x, v.y, v.z], f: player.facing, a: yaw + Math.PI, m: [move.x, move.z],
    b: (sprint ? 1 : 0) | (backpedal ? 2 : 0) | (player.ragdolled ? 4 : 0), hp: vitals.health / vitals.maxHealth,
  });
}
const ZERO = new THREE.Vector3();

// A hidden tab gets no animation frames, which would look to the opponent like a dropped connection.
// Timers still run there (about once a second), so they keep the match clock and the heartbeat going.
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

/** Move the opponent's body: replay their inputs through the same character code, pulled toward where they say they are. */
function updateFoe(dt: number, move: { x: number; z: number }, sprint: boolean, backpedal: boolean) {
  sendT -= dt;
  if (sendT <= 0) {
    sendT = 1 / SEND_HZ;
    sendState(move, sprint, backpedal);
  }
  if (!foe.root.visible) return;
  const limp = remote.dead || (remote.bits & 4) !== 0; // a dead opponent drops whether or not their own screen has caught up
  if (!foe.ragdolled) {
    const age = Math.min(0.25, (performance.now() - remote.at) / 1000);
    const dx = remote.p.x + remote.v.x * age - foe.pos.x, dz = remote.p.z + remote.v.z * age - foe.pos.z;
    const k = Math.hypot(dx, dz) > 3 ? 1 : 1 - Math.exp(-10 * dt); // far off: snap; otherwise ease
    foe.pos.x += dx * k;
    foe.pos.z += dz * k;
  }
  foe.stayDown = limp;
  if (remote.attack) foe.forceAttack(remote.attack.k, remote.attack.f);
  remote.attack = null;
  foe.update(dt, {
    moveX: remote.mx, moveZ: remote.mz, sprint: (remote.bits & 1) !== 0, backpedal: (remote.bits & 2) !== 0,
    jump: remote.jump, attack: false, ragdoll: limp !== foe.ragdolled, aimYaw: remote.a,
    threat: foe.pos.distanceTo(player.pos),
  });
  remote.jump = false;
}

// --- landing blows: the blade (or fist) must actually pass through a body part or prop while the swing is live ---
let chromaPulse = 0;
const STRIKE_SUBSTEPS = 4; // fast swings travel far between frames: test the sweep in between too
const bladeA = new THREE.Vector3(), bladeB = new THREE.Vector3(), prevA = new THREE.Vector3(), prevB = new THREE.Vector3();
const segA = new THREE.Vector3(), segB = new THREE.Vector3(), swingDir = new THREE.Vector3();
let swingSeen = -1, wasStriking = false, foeStruck = false;
const propsStruck = new Set<object>();
/** Each frame: sweep the weapon from where it was to where it is, and see what it cut through. One hit on the opponent per swing. */
function resolveStrike() {
  if (!player.striking) {
    wasStriking = false;
    return;
  }
  if (player.swing !== swingSeen) {
    swingSeen = player.swing;
    foeStruck = wasStriking = false;
    propsStruck.clear();
  }
  const wr = player.weaponSegment(bladeA, bladeB);
  if (!wasStriking) {
    prevA.copy(bladeA);
    prevB.copy(bladeB);
  }
  wasStriking = true;
  const w = inventory.equipped.weapon, def = w ? ITEMS[w] : null;
  const power = (def?.power ?? 0.5) * vitals.power;
  swingDir.set(Math.sin(player.facing), 0, Math.cos(player.facing));
  // the attacker's own view decides whether a blow lands; the victim's machine applies armour, damage and bleeding
  const parts = !foeStruck && phase === 'fight' && link && remote.hp > 0 ? foe.bodyParts() : null;
  let hits = 0;
  for (let i = 1; i <= STRIKE_SUBSTEPS; i++) {
    segA.lerpVectors(prevA, bladeA, i / STRIKE_SUBSTEPS);
    segB.lerpVectors(prevB, bladeB, i / STRIKE_SUBSTEPS);
    hits += arena.touch(segA, segB, wr, swingDir, power, propsStruck);
    const zone = parts && !foeStruck ? touchedPart(parts, segA, segB, wr) : null;
    if (zone) {
      foeStruck = true;
      link!.send({ t: 'hit', zone, d: BASE_DAMAGE * power * ZONES[zone].damage, edge: def?.edge ?? 0, x: swingDir.x, z: swingDir.z });
      ui.toast(`You struck the ${ZONES[zone].name}`);
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
let locked = false, yaw = 0, pitch = -0.12, attackQueued = false;
const canvas = renderer.domElement;
// Pause menu: shown whenever the mouse is free and the inventory isn't, so Esc (which the browser
// spends on releasing pointer lock) brings it up. The site opens straight onto the game: click to take control.
const menu = document.getElementById('menu')!;
const menuBtn = (act: string) => menu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
function setMenu(open: boolean) {
  menu.hidden = !open;
  if (!open) return;
  // buttons follow the match state
  const idle = phase === 'lobby' || phase === 'searching' || phase === 'practice';
  menuBtn('search').hidden = !(phase === 'lobby' || phase === 'searching');
  menuBtn('search').textContent = phase === 'searching' ? 'Cancel search' : 'Find opponent';
  menuBtn('practice').hidden = !idle || phase === 'searching';
  menuBtn('practice').textContent = phase === 'practice' ? 'Back to the room' : 'Practice';
}
const lock = () =>
  void Promise.resolve(canvas.requestPointerLock()).catch(() => {
    if (!ui.open) setMenu(true); // the browser refused (e.g. just after Esc): don't leave the player stuck without a cursor or a menu
  });
menu.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (!act) return;
  if (act === 'search') toggleSearch();
  if (act === 'practice') togglePractice();
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
  if (ui.open) setInventoryOpen(false);
  else if (!locked) lock();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  setMenu(!locked && !ui.open);
  if (!locked) keys.clear();
});
document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  yaw -= e.movementX * SENS;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * SENS, -1.1, 0.45);
});
document.addEventListener('mousedown', (e) => {
  if (locked && e.button === 0) attackQueued = true;
});
document.addEventListener('keydown', (e) => {
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
    if (!e.repeat) toggleSearch();
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
  if (e.code === 'Space') e.preventDefault();
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

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
  camera.rotation.set(pitch, yaw, 0);

  const ground = groundHeight(player.pos.x, player.pos.z);
  blob.position.set(player.pos.x, ground + 0.04, player.pos.z);
  blob.material.opacity = THREE.MathUtils.clamp(1 - (player.pos.y - ground) * 0.7, 0, 1);
}

function update(dt: number) {
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const len = Math.hypot(f, s) || 1;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  // stamina gates effort: no sprint when winded, no swing or jump without the breath for it
  const sprint = keys.has('ShiftLeft') && vitals.canSprint;
  const move = { x: (-sin * f + cos * s) / len, z: (-cos * f - sin * s) / len };
  const backpedal = f < 0 && !keys.has('ShiftLeft'); // S without Shift: back up, still facing forward
  const foeNear = foe.root.visible ? foe.pos.distanceTo(player.pos) : Infinity;
  const wasAttacking = player.attacking, wasGrounded = player.grounded;
  player.speedMul = vitals.speed;
  player.update(dt, {
    moveX: move.x,
    moveZ: move.z,
    sprint,
    backpedal,
    jump: keys.has('Space') && vitals.canJump,
    attack: attackQueued && vitals.canAttack,
    ragdoll: false, // going limp is not a choice: only death drops you
    aimYaw: yaw + Math.PI, // camera looks down -Z at yaw 0; model faces +Z at 0
    threat: Math.min(arena.enemyDistance(player.pos), foeNear),
  });
  if (!wasAttacking && player.attacking) {
    vitals.attacked();
    link?.send({ t: 'atk', k: player.attackKind, f: player.facing });
  }
  if (wasGrounded && !player.grounded && player.vel.y > 2 && !player.ragdolled) {
    vitals.jumped();
    link?.send({ t: 'jump' });
  }
  vitals.update(dt, sprint && player.grounded && Math.hypot(player.vel.x, player.vel.z) > 2.4);
  if (vitals.dead) die(); // bled out
  drawBars();
  if (ui.open && ui.tab === SHEET_TAB) sheet.render();
  attackQueued = false;
  updateMatch(dt);
  updateFoe(dt, move, sprint, backpedal);
  // two bodies can't share the same patch of sand: step out of the opponent
  if (foe.root.visible && !foe.ragdolled && !player.ragdolled) {
    const dx = player.pos.x - foe.pos.x, dz = player.pos.z - foe.pos.z, d = Math.hypot(dx, dz), min = player.radius + foe.radius;
    if (d < min && d > 1e-4 && Math.abs(player.pos.y - foe.pos.y) < 1.5) {
      player.pos.x = foe.pos.x + (dx / d) * min;
      player.pos.z = foe.pos.z + (dz / d) * min;
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
  // the sheet's figure is posed and rendered before the update, which then restores the live pose
  if (ui.open && ui.tab === SHEET_TAB) {
    if (portraitStale && portrait.draw(sheet.canvas)) {
      portraitStale = false;
      portraitSettle = 1.2;
    } else if (portraitSettle > 0 && (portraitSettle -= dt) <= 0) portrait.draw(sheet.canvas);
  }
  update(dt); // runs unlocked too (no input) so the idle pose and physics stay alive
  updateCamera(dt);
  post.render();
}
frame();
