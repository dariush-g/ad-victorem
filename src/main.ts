import * as THREE from 'three';
import { createArena, sandHeight, R } from './arena';
import { createPost, BASE_CHROMA } from './post';
import { loadGladiator } from './gladiator';
import { ITEMS, SLOTS } from './items';
import { Inventory, createInventoryUI } from './inventory';
import { createPickups } from './pickups';
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
const player = await loadGladiator(sandHeight, R);
scene.add(player.root);

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

// --- inventory: bag + equipment, loot lying in the arena ---
const inventory = new Inventory();
const pickups = createPickups(scene, sandHeight);
const ui = createInventoryUI(inventory, (s) => {
  // dropped items land on the sand just ahead of the player
  const a = player.facing + (Math.random() - 0.5) * 0.8;
  pickups.spawn(s.id, s.n, player.pos.x + Math.sin(a) * 0.75, player.pos.z + Math.cos(a) * 0.75);
  ui.toast(`Dropped ${ITEMS[s.id].name}`);
});
// --- attributes, health and stamina ---
const vitals = new Vitals();
const drawBars = createVitalBars(vitals, document.getElementById('rank')!);
const sheet = createCharacterSheet(vitals);
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
  vitals.armor = inventory.armor;
  portraitStale = true;
  const w = inventory.equipped.weapon;
  rankSub.textContent = `Slave · ${w ? ITEMS[w].name : 'Bare hands'}`;
  ui.render();
};
for (const id of ['rudis', 'subligaculum', 'cord']) inventory.wear(id);
pickups.spawn('gladius', 1, -1.6, 9.2);
pickups.spawn('balteus', 1, 8.7, 6.6);
pickups.spawn('subligaculum_red', 1, -5.9, -0.9);
pickups.spawn('tunica', 1, 1.6, 11.2);
pickups.spawn('tunica_russa', 1, 9.4, -3.2);
pickups.spawn('galea', 1, -3.4, 6.2);
pickups.spawn('pectorale', 1, 3.6, 4.4);
pickups.spawn('manica', 1, -6.6, 3.4);
pickups.spawn('ocreae', 1, 5.4, 9.0);
pickups.spawn('denarius', 3, 2.2, 10.4);
pickups.spawn('denarius', 5, -8.2, 7.1);
pickups.spawn('denarius', 8, 6.1, -6.3);

let chromaPulse = 0;
player.onStrike = (origin, dir, reach) => {
  const w = inventory.equipped.weapon;
  if (arena.strike(origin, dir, reach, (w ? (ITEMS[w].power ?? 1) : 0.5) * vitals.power) > 0) chromaPulse = 0.02;
};

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
let locked = false, yaw = 0, pitch = -0.12, attackQueued = false, ragdollQueued = false;
const canvas = renderer.domElement;
const hint = document.getElementById('hint')!;
const lock = () => void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
function setInventoryOpen(open: boolean, tab?: number) {
  ui.setOpen(open, tab);
  if (open) document.exitPointerLock();
  else lock();
}
canvas.addEventListener('click', () => {
  if (ui.open) setInventoryOpen(false);
  else if (!locked) lock();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  hint.style.opacity = locked ? '0.55' : '1';
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
function takeNearest() {
  const p = pickups.nearest(player.pos);
  if (!p || player.ragdolled) return;
  const left = inventory.add(p.id, p.n), got = p.n - left;
  if (got === 0) return ui.toast('Bag is full');
  ui.toast(`Took ${ITEMS[p.id].name}${got > 1 ? ' ×' + got : ''}`);
  if (left > 0) p.n = left;
  else pickups.remove(p);
}
document.addEventListener('keydown', (e) => {
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
  if (!locked) return;
  if (e.code === 'KeyE' && !e.repeat) takeNearest();
  keys.add(e.code);
  if (e.code === "KeyG" && !e.repeat) ragdollQueued = true;
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
  const d = Math.hypot(p.x, p.z), lim = R - 0.35;
  if (d > lim) {
    p.x *= lim / d;
    p.z *= lim / d;
  }
  const floor = sandHeight(p.x, p.z) + 0.3;
  if (p.y < floor) p.y = floor;
  camera.rotation.set(pitch, yaw, 0);

  const ground = sandHeight(player.pos.x, player.pos.z);
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
  const wasAttacking = player.attacking, wasGrounded = player.grounded;
  player.speedMul = vitals.speed;
  player.update(dt, {
    moveX: (-sin * f + cos * s) / len,
    moveZ: (-cos * f - sin * s) / len,
    sprint,
    backpedal: f < 0 && !keys.has('ShiftLeft'), // S without Shift: back up, still facing forward
    jump: keys.has('Space') && vitals.canJump,
    attack: attackQueued && vitals.canAttack,
    ragdoll: ragdollQueued,
    aimYaw: yaw + Math.PI, // camera looks down -Z at yaw 0; model faces +Z at 0
    threat: arena.enemyDistance(player.pos),
  });
  if (!wasAttacking && player.attacking) vitals.attacked();
  if (wasGrounded && !player.grounded && player.vel.y > 2 && !player.ragdolled) vitals.jumped();
  vitals.update(dt, sprint && player.grounded && Math.hypot(player.vel.x, player.vel.z) > 2.4);
  drawBars();
  if (ui.open && ui.tab === SHEET_TAB) sheet.render();
  attackQueued = false;
  ragdollQueued = false;
  arena.update(dt, player);
  pickups.update(dt);
  const near = locked && !player.ragdolled ? pickups.nearest(player.pos) : null;
  ui.prompt(near ? `<b>E</b> Take ${ITEMS[near.id].name}${near.n > 1 ? ' ×' + near.n : ''}` : '');

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
