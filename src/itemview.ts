import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ITEMS, buildGroundMesh, buildWeapon } from './items';
import { createPost } from './post';

/**
 * A turntable for one item: its real model, lit softly and finished with the game's pixel pass,
 * that the player can spin (drag), move (right-drag) and zoom (wheel). It has its own small
 * renderer and only draws while it is on screen.
 */
export function createItemView(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15110f);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
  // The game's materials put the first directional light (the sun) in the stadium's shade. A dark
  // stand-in takes that place, so the lights that follow shine on the item as they are.
  scene.add(new THREE.DirectionalLight(0xffffff, 0));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
  key.position.set(2, 3, 2.5);
  const fill = new THREE.DirectionalLight(0x9aa6ff, 0.7);
  fill.position.set(-3, 1, -1);
  scene.add(key, fill, new THREE.HemisphereLight(0xfff4e6, 0x2a1d16, 0.6));

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
  const post = createPost(renderer, scene, camera);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2.2;
  controls.screenSpacePanning = true;
  // the player has taken hold of it: stop turning it for them
  controls.addEventListener('start', () => (controls.autoRotate = false));

  const holder = new THREE.Group();
  scene.add(holder);
  let item: THREE.Object3D | null = null, active = false, raf = 0;

  function dispose(o: THREE.Object3D) {
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const mt of ([] as THREE.Material[]).concat(mesh.material)) mt.dispose();
    });
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      post.resize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function loop() {
    raf = active ? requestAnimationFrame(loop) : 0;
    resize();
    controls.update();
    post.render();
  }

  return {
    /** Put an item on the turntable (null clears it), framed to fit, turning slowly. */
    show(id: string | null) {
      if (item) {
        holder.remove(item);
        dispose(item);
        item = null;
      }
      if (!id || !Object.hasOwn(ITEMS, id)) return;
      const def = ITEMS[id];
      if (def.slot === 'weapon') {
        item = buildWeapon(id); // standing on its pommel, blade up, turned to show the flat
        item.rotation.set(0, 0, -0.35);
      } else {
        item = buildGroundMesh(id);
        item.rotation.x = 0.25; // tipped toward the viewer, so a folded or flat piece reads
      }
      holder.add(item);
      // centre it and back the camera off until it fits
      const box = new THREE.Box3().setFromObject(item), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
      item.position.sub(centre);
      const r = Math.max(size.length() / 2, 0.05);
      const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
      camera.near = dist / 100;
      camera.far = dist * 10;
      camera.position.set(dist * 0.55, dist * 0.35, dist * 0.76);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.minDistance = dist * 0.35;
      controls.maxDistance = dist * 2.5;
      controls.autoRotate = true;
      controls.update();
    },
    /** Draw only while visible. */
    setActive(on: boolean) {
      active = on;
      if (on && !raf) raf = requestAnimationFrame(loop);
    },
  };
}
