import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ITEMS, ICON_URLS, buildGroundMesh, buildWeapon } from './items';

/** Output size in pixels (shown at 48 css px, so sharp on 2x screens), and the size it is rendered at before reducing. */
const OUT = 96, RENDER = 192;
/** Light level going into the tone curve. */
const EXPOSURE = 1.15;
/** Per slot: camera height and distance (looking at the item lying on the ground), and how it is turned. */
const VIEW: Record<string, [[number, number], number]> = {
  head: [[2.5, 7], -0.6], // from the side, a little above: dome, cheek pieces and crest
  chest: [[8, 4], -0.3],
  shield: [[8, 3], -0.2], // from above and in front: the painted face and the boss
  arm: [[4, 7], -0.4],
  legs: [[7, 5], -0.3],
  belt: [[8, 4], -0.4],
  garb: [[6, 6], -0.5],
  tunic: [[6, 6], -0.5],
};
const filmic = (c: number) => (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
const enc = (v: number) => Math.min(1, Math.max(0, v) ** (1 / 2.2));
const canvas2d = (size: number) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
};

/**
 * Render every item's own 3D model into its icon, filling ICON_URLS: a smooth render in the game's
 * tone (its filmic curve and a little extra saturation) on a clear background, with a soft drop shadow.
 * Weapons are shown on the diagonal, everything else lying down, from the angle it reads best.
 * Without WebGL to spare, the flat drawings in items.ts stay.
 */
export function renderIcons() {
  const gl = canvas2d(RENDER);
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: gl, alpha: true, antialias: true, preserveDrawingBuffer: true });
  } catch {
    return;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(RENDER, RENDER, false);
  renderer.setClearColor(0x000000, 0);
  // linear output: the tone curve and encoding are applied below, as the game's post pass does
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();
  // the game's materials shade the first directional light (the sun) by the stadium: a dark stand-in takes it
  scene.add(new THREE.DirectionalLight(0xffffff, 0));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.6);
  key.position.set(-2, 3, 2.5); // top-left, as icons are lit
  const fill = new THREE.DirectionalLight(0x9aa6ff, 0.6);
  fill.position.set(3, -1, 1);
  scene.add(key, fill, new THREE.HemisphereLight(0xfff4e6, 0x2a1d16, 0.7));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);

  const read = canvas2d(RENDER), rctx = read.getContext('2d', { willReadFrequently: true })!;
  const base = canvas2d(RENDER), bctx = base.getContext('2d')!;
  const big = canvas2d(RENDER), ctx = big.getContext('2d')!;
  const out = canvas2d(OUT), octx = out.getContext('2d')!;
  octx.imageSmoothingQuality = 'high';

  for (const id of Object.keys(ITEMS)) {
    const def = ITEMS[id];
    const item = def.slot === 'weapon' ? buildWeapon(id) : buildGroundMesh(id);
    const holder = new THREE.Group();
    holder.add(item);
    if (def.slot === 'weapon') {
      item.rotation.set(0, 0.5, -Math.PI / 4); // blade up to the right, turned a little to catch the light
      camera.position.set(0, 0, 10);
    } else {
      holder.rotation.y = VIEW[def.slot ?? 'garb'][1];
      camera.position.set(0, ...VIEW[def.slot ?? 'garb'][0]);
    }
    scene.add(holder);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    // centre the model and fit the view to it, with room round it for the shadow
    const box = new THREE.Box3().setFromObject(holder);
    holder.position.sub(box.getCenter(new THREE.Vector3()));
    holder.updateMatrixWorld(true);
    const inv = camera.matrixWorldInverse, pts = new THREE.Box3();
    holder.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox!;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        pts.expandByPoint(p.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv));
      }
    });
    const half = (Math.max(pts.max.x - pts.min.x, pts.max.y - pts.min.y) / 2) * 1.22;
    const cx = (pts.max.x + pts.min.x) / 2, cy = (pts.max.y + pts.min.y) / 2;
    camera.left = cx - half;
    camera.right = cx + half;
    camera.top = cy + half;
    camera.bottom = cy - half;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    scene.remove(holder);
    holder.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) m.dispose();
    });

    // the game's tone: exposure, filmic curve, a little saturation, display encoding
    rctx.clearRect(0, 0, RENDER, RENDER);
    rctx.drawImage(gl, 0, 0);
    const img = rctx.getImageData(0, 0, RENDER, RENDER), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      let r = filmic((d[i] / 255) * EXPOSURE), g = filmic((d[i + 1] / 255) * EXPOSURE), b = filmic((d[i + 2] / 255) * EXPOSURE);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * 1.12;
      g = l + (g - l) * 1.12;
      b = l + (b - l) * 1.12;
      d[i] = enc(r) * 255;
      d[i + 1] = enc(g) * 255;
      d[i + 2] = enc(b) * 255;
    }
    bctx.putImageData(img, 0, 0);
    // set down on a soft shadow, then reduced to size
    ctx.clearRect(0, 0, RENDER, RENDER);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = RENDER * 0.05;
    ctx.shadowOffsetY = RENDER * 0.03;
    ctx.drawImage(base, 0, 0);
    octx.clearRect(0, 0, OUT, OUT);
    octx.drawImage(big, 0, 0, OUT, OUT);
    ICON_URLS[id] = out.toDataURL('image/png');
  }
  scene.environment?.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}
