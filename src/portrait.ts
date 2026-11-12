import * as THREE from 'three';
import type { Gladiator } from './gladiator';

/** Framing shared by the render and the diagram drawn over it, in units of the figure's height. */
export const FRAME = { margin: 0.07, circle: 0.608 }; // circle radius: navel-centred, touching the ground
const VIEW = FRAME.circle * 2 + FRAME.margin * 2; // side of the square view, in heights

const filmic = (c: number) => (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * Renders the player alone — the real model, lit by the arena, wearing whatever is
 * equipped — front-on in the two poses of a proportion study, and composites them onto
 * a 2D canvas. Uses the game's renderer, so the figure looks exactly as it does in play.
 */
export function createPortrait(renderer: THREE.WebGLRenderer, scene: THREE.Scene, player: Gladiator, size = 720) {
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
  const raw = new Uint16Array(size * size * 4);
  const layer = document.createElement('canvas');
  layer.width = layer.height = size;
  const lctx = layer.getContext('2d')!;
  const image = lctx.createImageData(size, size);
  const clear = new THREE.Color();

  function shoot(spread: boolean) {
    if (!player.posePortrait(spread)) return false;
    const h = player.height, half = (VIEW * h) / 2, ry = player.root.rotation.y;
    camera.left = -half; camera.right = half; camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix();
    const cy = player.root.position.y + (FRAME.circle * h);
    camera.position.set(player.root.position.x + Math.sin(ry) * 8, cy, player.root.position.z + Math.cos(ry) * 8);
    camera.lookAt(player.root.position.x, cy, player.root.position.z);

    // everything but the player and the lights sits this one out
    const hidden = scene.children.filter((o) => o !== player.root && !(o as THREE.Light).isLight && o.visible);
    for (const o of hidden) o.visible = false;
    const { background, fog } = scene, alpha = renderer.getClearAlpha(), auto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(clear);
    scene.background = null;
    scene.fog = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, raw);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    renderer.shadowMap.autoUpdate = auto;
    scene.background = background;
    scene.fog = fog;
    for (const o of hidden) o.visible = true;

    // same finish as the game's post pass: filmic curve, a little saturation, display encoding
    const out = image.data, f = THREE.DataUtils.fromHalfFloat;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const s = ((size - 1 - y) * size + x) * 4, d = (y * size + x) * 4; // GL rows run bottom-up
        const a = Math.min(1, f(raw[s + 3]));
        if (a <= 0.003) {
          out[d + 3] = 0;
          continue;
        }
        const r = filmic(f(raw[s]) / a), g = filmic(f(raw[s + 1]) / a), b = filmic(f(raw[s + 2]) / a);
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        out[d] = encode(l + (r - l) * 1.12) * 255;
        out[d + 1] = encode(l + (g - l) * 1.12) * 255;
        out[d + 2] = encode(l + (b - l) * 1.12) * 255;
        out[d + 3] = a * 255;
      }
    lctx.putImageData(image, 0, 0);
    return true;
  }

  /**
   * Draw the study onto `canvas`. Leaves the rig in a diagram pose, so call it before the
   * frame's player update, which re-poses the body. Returns false if the player can't be
   * posed right now (ragdolled).
   */
  function draw(canvas: HTMLCanvasElement): boolean {
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // second pose first, ghosted: arms raised, legs apart
    if (!shoot(true)) return false;
    ctx.clearRect(0, 0, size, size);
    ctx.globalAlpha = 0.38;
    ctx.drawImage(layer, 0, 0);
    shoot(false);
    ctx.globalAlpha = 1;
    ctx.drawImage(layer, 0, 0);
    return true;
  }

  return { draw };
}
