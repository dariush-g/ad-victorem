import * as THREE from 'three';
import { buildGroundMesh, disposeTree } from './items';

export interface Pickup {
  id: string;
  n: number;
  group: THREE.Group;
  ring: THREE.Mesh;
}

/** Items lying on the sand, waiting to be taken. */
export function createPickups(scene: THREE.Scene, ground: (x: number, z: number) => number) {
  const list: Pickup[] = [];
  const ringGeo = new THREE.RingGeometry(0.2, 0.225, 48).rotateX(-Math.PI / 2);
  let time = 0;

  function spawn(id: string, n: number, x: number, z: number, yaw = Math.random() * Math.PI * 2) {
    const group = new THREE.Group();
    const mesh = buildGroundMesh(id);
    mesh.rotation.y = yaw;
    // faint pulsing ring so loot reads against the sand
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.4, depthWrite: false, fog: false }));
    ring.position.y = 0.025;
    group.add(mesh, ring);
    group.position.set(x, ground(x, z), z);
    scene.add(group);
    list.push({ id, n, group, ring });
  }

  /** Closest pickup within `reach` metres of `pos`, if any. */
  function nearest(pos: THREE.Vector3, reach = 1.4): Pickup | null {
    let best: Pickup | null = null, bd = reach;
    for (const p of list) {
      const d = Math.hypot(p.group.position.x - pos.x, p.group.position.z - pos.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function remove(p: Pickup) {
    const i = list.indexOf(p);
    if (i < 0) return;
    list.splice(i, 1);
    (p.ring.material as THREE.Material).dispose();
    p.ring.geometry = new THREE.BufferGeometry(); // shared ring geometry must survive disposeTree
    disposeTree(p.group);
  }

  function update(dt: number) {
    time += dt;
    list.forEach((p, i) => {
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4 + i * 1.3);
      (p.ring.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.3 * pulse;
      p.ring.scale.setScalar(1 + 0.12 * pulse);
    });
  }

  return { spawn, nearest, remove, update };
}
