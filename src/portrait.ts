import * as THREE from 'three';
import type { Gladiator } from './gladiator';
import { createPost } from './post';

/**
 * The player's live model on a turntable, for the character tab: drawn every frame (idle pose,
 * swinging cloth, everything worn and wielded) through the game's pixel pass, with nothing else
 * in the scene. Drag to turn and tilt, right-drag to move, scroll to zoom; it turns slowly by
 * itself until grabbed.
 */
export function createTurntable(renderer: THREE.WebGLRenderer, scene: THREE.Scene, player: Gladiator) {
  const el = document.createElement('div');
  el.className = 'turntable';
  const canvas = el.appendChild(document.createElement('canvas'));
  const hint = el.appendChild(document.createElement('div'));
  hint.className = 'turntable-hint';
  hint.textContent = 'Drag to turn · scroll to zoom';
  hint.title = 'Right-drag or Shift-drag to move · double-click to reset';
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  camera.rotation.order = 'YXZ';
  const post = createPost(renderer, scene, camera);
  const backdrop = new THREE.Color(0x17120f), clear = new THREE.Color();
  const view = { yaw: 0.35, pitch: 0.08, zoom: 1, panX: 0, panY: 0, spin: true };
  let lastW = 0, lastH = 0;

  // --- input on the canvas ---
  let drag: { x: number; y: number; button: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, button: e.button };
    view.spin = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.button === 2 || e.shiftKey) {
      const k = (player.height * 1.2 * view.zoom) / Math.max(1, canvas.clientHeight);
      view.panX -= dx * k;
      view.panY += dy * k;
      view.panX = THREE.MathUtils.clamp(view.panX, -0.8, 0.8);
      view.panY = THREE.MathUtils.clamp(view.panY, -0.9, 0.9);
    } else {
      view.yaw -= dx * 0.01;
      view.pitch = THREE.MathUtils.clamp(view.pitch + dy * 0.006, -0.5, 1.1);
    }
  });
  const release = () => (drag = null);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(e.deltaY * 0.0012), 0.35, 1.6);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => Object.assign(view, { yaw: 0.35, pitch: 0.08, zoom: 1, panX: 0, panY: 0, spin: true }));

  /** Render one frame of the turntable into its canvas. Call after the frame's update, before the main render. */
  function draw(dt: number) {
    const w = canvas.clientWidth, h = canvas.clientHeight, pr = renderer.getPixelRatio();
    if (!w || !h || !player.root.visible || !el.isConnected) return;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      canvas.width = Math.round(w * pr);
      canvas.height = Math.round(h * pr);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      post.resize(w, h);
    }
    if (view.spin) view.yaw += dt * 0.5;

    // orbit the fighter's middle, starting from in front of them
    const hgt = player.height, root = player.root.position;
    const dist = ((hgt * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * view.zoom;
    const a = player.root.rotation.y + view.yaw, cp = Math.cos(view.pitch);
    const target = new THREE.Vector3(root.x, root.y + hgt * 0.52, root.z);
    camera.position.set(target.x + Math.sin(a) * cp * dist, target.y + Math.sin(view.pitch) * dist, target.z + Math.cos(a) * cp * dist);
    camera.lookAt(target);
    camera.translateX(view.panX * hgt * 0.5);
    camera.translateY(view.panY * hgt * 0.5);

    // everything but the player and the lights sits this one out
    const hidden = scene.children.filter((o) => o !== player.root && !(o as THREE.Light).isLight && o.visible);
    for (const o of hidden) o.visible = false;
    const { background, fog } = scene, auto = renderer.shadowMap.autoUpdate;
    scene.background = backdrop;
    scene.fog = null;
    renderer.shadowMap.autoUpdate = false;
    // draw into the bottom-left corner of the game's own canvas, then copy it out before the frame ends
    const vp = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissorTest();
    renderer.getClearColor(clear);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(true);
    post.render();
    const src = renderer.domElement;
    canvas.getContext('2d')!.drawImage(src, 0, src.height - canvas.height, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    renderer.setScissorTest(scissor);
    renderer.setViewport(vp);
    renderer.setClearColor(clear);
    renderer.shadowMap.autoUpdate = auto;
    scene.background = background;
    scene.fog = fog;
    for (const o of hidden) o.visible = true;
  }

  return { el, draw };
}
