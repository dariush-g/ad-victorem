import * as THREE from 'three';
import { createArena, sandHeight, R } from './arena';
import { createPost, BASE_CHROMA } from './post';
import { loadGladiator } from './gladiator';

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

let chromaPulse = 0;
player.onStrike = (origin, dir, reach) => {
  if (arena.strike(origin, dir, reach) > 0) chromaPulse = 0.02;
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
canvas.addEventListener('click', () => {
  if (!locked) canvas.requestPointerLock();
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
document.addEventListener('keydown', (e) => {
  if (!locked) return;
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
  player.update(dt, {
    moveX: (-sin * f + cos * s) / len,
    moveZ: (-cos * f - sin * s) / len,
    sprint: keys.has('ShiftLeft'),
    backpedal: f < 0 && !keys.has('ShiftLeft'), // S without Shift: back up, still facing forward
    jump: keys.has('Space'),
    attack: attackQueued,
    ragdoll: ragdollQueued,
    aimYaw: yaw + Math.PI, // camera looks down -Z at yaw 0; model faces +Z at 0
  });
  attackQueued = false;
  ragdollQueued = false;
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
  post.render();
}
frame();
