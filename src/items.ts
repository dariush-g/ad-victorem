import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mat, solid, PALETTE } from './style';

export type Slot = 'weapon' | 'head' | 'tunic' | 'chest' | 'arm' | 'garb' | 'belt' | 'legs';
export const SLOTS: Slot[] = ['weapon', 'head', 'tunic', 'chest', 'arm', 'garb', 'belt', 'legs'];
export const SLOT_LABEL: Record<Slot, string> = { weapon: 'Weapon', head: 'Head', tunic: 'Tunic', chest: 'Chest', arm: 'Arm', garb: 'Loincloth', belt: 'Belt', legs: 'Legs' };

export interface ItemDef {
  id: string;
  name: string;
  desc: string;
  /** Equipment slot, if it can be worn or wielded. */
  slot?: Slot;
  /** How many fit in one bag space. */
  stack: number;
  icon: 'sword' | 'cloth' | 'belt' | 'coin' | 'tunic' | 'helmet' | 'plate' | 'greave' | 'arm';
  tint: string; // icon colour
  /** Weapons: multipliers on the attack's reach and on how hard it hits. */
  reach?: number;
  power?: number;
  /** Clothing: cloth colour. */
  color?: number;
  /** Points of protection while worn; each point turns away 1% of a blow. */
  armor?: number;
}

const defs: ItemDef[] = [
  { id: 'rudis', name: 'Wooden sword', desc: 'Training sword. Heavy, blunt, and yours until you earn better.', slot: 'weapon', stack: 1, icon: 'sword', tint: '#b9793f', reach: 1, power: 1 },
  { id: 'gladius', name: 'Short sword', desc: 'Iron sword of the legions. Shorter than the wooden one, and hits far harder.', slot: 'weapon', stack: 1, icon: 'sword', tint: '#cfd3da', reach: 0.94, power: 1.7 },
  { id: 'subligaculum', name: 'Loincloth', desc: 'Undyed linen. What every slave is issued.', slot: 'garb', stack: 1, icon: 'cloth', tint: '#dccdaa', color: 0xd9c9a6 },
  { id: 'subligaculum_red', name: 'Red loincloth', desc: 'Loincloth dyed with madder root. The crowd can pick you out from the top row.', slot: 'garb', stack: 1, icon: 'cloth', tint: '#b33a34', color: PALETTE.crimson },
  { id: 'cord', name: 'Rope belt', desc: 'A length of rope, knotted at the hip.', slot: 'belt', stack: 1, icon: 'belt', tint: '#b89a62' },
  { id: 'balteus', name: 'Leather belt', desc: 'Broad belt with a bronze buckle and studs.', slot: 'belt', stack: 1, icon: 'belt', tint: '#8a5433' },
  { id: 'tunica', name: 'Tunic', desc: 'Coarse undyed wool, sewn at the shoulders and belted at the waist. Falls to mid-thigh.', slot: 'tunic', stack: 1, icon: 'tunic', tint: '#cdb98f', color: 0xc8b48a, armor: 2 },
  { id: 'tunica_russa', name: 'Red tunic', desc: 'Wool tunic dyed russet. Hides the blood.', slot: 'tunic', stack: 1, icon: 'tunic', tint: '#8c3f33', color: 0x83392e, armor: 2 },
  { id: 'galea', name: 'Helmet', desc: 'Bronze helmet with cheek pieces, a neck guard and a horsehair crest.', slot: 'head', stack: 1, icon: 'helmet', tint: '#c9954a', armor: 12 },
  { id: 'pectorale', name: 'Chest plate', desc: 'Square bronze plate over the heart, held by leather straps.', slot: 'chest', stack: 1, icon: 'plate', tint: '#c9954a', armor: 15 },
  { id: 'manica', name: 'Arm guard', desc: 'Banded leather sleeve with a bronze shoulder cap, for the sword arm.', slot: 'arm', stack: 1, icon: 'arm', tint: '#8a5433', armor: 8 },
  { id: 'ocreae', name: 'Greaves', desc: 'Pair of bronze greaves, knee to ankle.', slot: 'legs', stack: 1, icon: 'greave', tint: '#c9954a', armor: 8 },
  { id: 'denarius', name: 'Silver coin', desc: 'Silver coin. Enough of these buys a man his freedom.', stack: 99, icon: 'coin', tint: '#d9dbe0' },
];
export const ITEMS: Record<string, ItemDef> = Object.fromEntries(defs.map((d) => [d.id, d]));

// ------------------------------------------------------------------ icons

const ICON_PATHS: Record<ItemDef['icon'], string> = {
  sword: '<path d="M25 3l4 4-13 14-4-4z" fill="$C"/><path d="M9 15l8 8-2 2-8-8z" fill="#5a3a22"/><path d="M10 20l2 2-6 6-2-2z" fill="#7a4d2c"/><circle cx="4.5" cy="27.5" r="2.2" fill="#5a3a22"/>',
  cloth: '<path d="M5 8h22v6c-3 2-6 2-7 5l-2 9h-4l-2-9c-1-3-4-3-7-5z" fill="$C"/><path d="M5 8h22v3H5z" fill="#0003"/><path d="M13 16l1 11M19 16l-1 11M16 15v13" stroke="#0003" fill="none"/>',
  belt: '<ellipse cx="16" cy="16" rx="12" ry="7" fill="none" stroke="$C" stroke-width="4.5"/><rect x="12" y="19.5" width="8" height="7" rx="1.5" fill="none" stroke="#d8a94e" stroke-width="2"/>',
  tunic: '<path d="M11 4h10l8 5-3 6-4-2v15H10V13l-4 2-3-6z" fill="$C"/><path d="M11 4q5 5 10 0" fill="none" stroke="#0005"/><path d="M10 19h12" stroke="#0005" stroke-width="2"/>',
  helmet: '<path d="M6 19C6 9 11 5 16 5s10 4 10 14z" fill="$C"/><path d="M5 19h22v3H5z" fill="$C" stroke="#0004"/><path d="M8 22h5v6H10z M24 22h-5v6h3z" fill="$C"/><path d="M16 5C12 1 8 4 7 9" fill="none" stroke="#b33a34" stroke-width="3"/>',
  plate: '<rect x="7" y="8" width="18" height="18" rx="2" fill="$C" stroke="#0004"/><circle cx="16" cy="17" r="5" fill="none" stroke="#0005" stroke-width="1.5"/><path d="M9 8L6 3M23 8l3-5" stroke="#7a4d2c" stroke-width="2.5"/>',
  greave: '<path d="M8 4q4-2 6 0l1 14-1 10H9L7 18z M19 4q4-2 6 0l-1 14-2 10h-5l1-10z" fill="$C" stroke="#0004"/>',
  arm: '<path d="M6 8q5-6 10-2l3 5-9 5z" fill="#c9954a"/><path d="M11 14l8-4 3 4-8 4z M14 19l8-4 3 4-8 4z M17 24l8-4 2 4-7 4z" fill="$C" stroke="#0005"/>',
  coin: '<circle cx="12" cy="19" r="7" fill="$C" stroke="#0004"/><circle cx="20" cy="13" r="7" fill="$C" stroke="#0004"/><circle cx="20" cy="13" r="4" fill="none" stroke="#0003"/>',
};
export function iconSVG(def: ItemDef) {
  return `<svg viewBox="0 0 32 32" width="100%" height="100%">${ICON_PATHS[def.icon].replaceAll('$C', def.tint)}</svg>`;
}

// ------------------------------------------------------------------ meshes

const part = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
  const mesh = solid(geo, m);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
};

/** A weapon held by its grip at the origin, blade along +Y. */
export function buildWeapon(id: string): THREE.Group {
  const g = new THREE.Group();
  if (id === 'gladius') {
    const steel = mat(PALETTE.steel, { rim: 0.2, surface: 'metal', side: THREE.DoubleSide });
    const bronze = mat(PALETTE.bronze, { rim: 0.2, surface: 'metal' });
    const grip = mat(PALETTE.woodDark, { rim: 0.2, surface: 'wood' });
    // ridged bone-style grip, round pommel, oval guard
    for (let i = 0; i < 4; i++) part(new THREE.SphereGeometry(0.023, 20, 12), grip, g, 0, -0.058 + i * 0.037, 0).scale.set(1, 0.95, 1);
    part(new THREE.SphereGeometry(0.036, 24, 18), bronze, g, 0, -0.105, 0);
    part(new THREE.SphereGeometry(0.042, 24, 16), bronze, g, 0, 0.098, 0).scale.set(1.1, 0.4, 0.7);
    // blade: flattened diamond section with a waist, tapering to a long point
    const profile = [[0.0, 0.031], [0.1, 0.03], [0.24, 0.026], [0.36, 0.03], [0.42, 0.027], [0.53, 0.0006]] as const;
    const pts: number[] = [], idx: number[] = [];
    profile.forEach(([y, w], i) => {
      const t = i === profile.length - 1 ? 0.0006 : 0.0055;
      pts.push(-w, y, 0, 0, y, t, w, y, 0, 0, y, -t);
      if (i === 0) return;
      const a = (i - 1) * 4, b = i * 4;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        idx.push(a + k, a + k2, b + k, a + k2, b + k2, b + k);
      }
    });
    const blade = new THREE.BufferGeometry();
    blade.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    blade.setIndex(idx);
    const flat = blade.toNonIndexed(); // hard edges: each facet catches the light on its own
    flat.computeVertexNormals();
    part(flat, steel, g, 0, 0.11, 0);
  } else {
    // rudis: wooden training sword
    const wood = mat(PALETTE.wood, { rim: 0.2, surface: 'wood' });
    const woodDark = mat(PALETTE.woodDark, { rim: 0.2, surface: 'wood' });
    part(new THREE.CylinderGeometry(0.02, 0.02, 0.17, 24), woodDark, g);
    part(new THREE.SphereGeometry(0.034, 24, 18), woodDark, g, 0, -0.1, 0);
    part(new RoundedBoxGeometry(0.17, 0.035, 0.055, 4, 0.014), woodDark, g, 0, 0.095, 0);
    part(new RoundedBoxGeometry(0.062, 0.62, 0.024, 4, 0.01), wood, g, 0, 0.42, 0);
    const tip = part(new THREE.ConeGeometry(0.044, 0.1, 4), wood, g, 0, 0.78, 0);
    tip.scale.z = 0.4;
    tip.rotation.y = Math.PI / 4;
  }
  return g;
}

/** How an item looks lying on the sand; origin at ground level. */
export function buildGroundMesh(id: string): THREE.Group {
  const def = ITEMS[id], g = new THREE.Group();
  if (def.slot === 'weapon') {
    const w = buildWeapon(id);
    w.rotation.set(Math.PI / 2, 0, 0.12); // flat on its side
    w.position.y = 0.035;
    g.add(w);
  } else if (def.slot === 'head' || def.slot === 'chest' || def.slot === 'legs' || def.slot === 'arm') {
    // armour lying in the sand, simplified to its main shape
    const metal = mat(PALETTE.bronze, { rim: 0.25, surface: 'metal', side: THREE.DoubleSide });
    const hide = mat(PALETTE.leather, { rim: 0.2, surface: 'leather', side: THREE.DoubleSide });
    if (def.slot === 'head') {
      part(new THREE.SphereGeometry(0.11, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), metal, g, 0, 0, 0).scale.set(0.92, 1, 1.1);
      part(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 32, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), mat(PALETTE.crimson, { surface: 'cloth', side: THREE.DoubleSide }), g, 0, 0.012, 0).scale.set(1, 1.2, 1.1);
    } else if (def.slot === 'chest') {
      const plate = part(new RoundedBoxGeometry(0.2, 0.012, 0.19, 3, 0.005), metal, g, 0, 0.012, 0);
      plate.rotation.z = 0.06;
      part(new THREE.TorusGeometry(0.058, 0.006, 8, 32).rotateX(Math.PI / 2), metal, g, 0, 0.022, 0);
      part(new RoundedBoxGeometry(0.34, 0.006, 0.026, 2, 0.002), hide, g, 0.02, 0.004, 0.11).rotation.y = 0.3;
    } else if (def.slot === 'legs') {
      for (const s of [-1, 1]) {
        const shell = part(new THREE.CylinderGeometry(0.05, 0.065, 0.4, 20, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2), metal, g, s * 0.08, 0.005, 0);
        shell.rotation.y = s * 0.2;
      }
    } else {
      for (let i = 0; i < 6; i++) part(new THREE.CylinderGeometry(0.05 - i * 0.002, 0.053 - i * 0.002, 0.07, 20, 1, true).rotateZ(Math.PI / 2), hide, g, -0.15 + i * 0.058, 0.05, 0);
      part(new THREE.SphereGeometry(0.07, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), metal, g, -0.2, 0, 0.0);
    }
  } else if (def.slot === 'garb' || def.slot === 'tunic') {
    // folded cloth: a few slumped layers
    const cloth = mat(def.color ?? PALETTE.linen, { rim: 0.2, surface: 'cloth' });
    for (let i = 0; i < 3; i++) {
      const big = def.slot === 'tunic' ? 1.35 : 1;
      const layer = part(new RoundedBoxGeometry((0.3 - i * 0.03) * big, 0.028, (0.2 - i * 0.02) * big, 3, 0.013), cloth, g, i * 0.008, 0.016 + i * 0.024, -i * 0.006);
      layer.rotation.y = (i - 1) * 0.09;
    }
  } else if (def.slot === 'belt') {
    if (id === 'balteus') {
      const leather = mat(PALETTE.leather, { rim: 0.2, surface: 'leather' });
      const coil = part(new THREE.TorusGeometry(0.1, 0.012, 8, 40), leather, g, 0, 0.03, 0);
      coil.rotation.x = Math.PI / 2;
      coil.scale.set(1.25, 1, 2.6); // a strap coiled on edge
      part(new RoundedBoxGeometry(0.05, 0.055, 0.012, 3, 0.005), mat(PALETTE.bronze, { surface: 'metal' }), g, 0, 0.03, 0.105);
    } else {
      const rope = mat(PALETTE.rope, { rim: 0.2, surface: 'cloth' });
      for (let i = 0; i < 2; i++) {
        const coil = part(new THREE.TorusGeometry(0.09 - i * 0.022, 0.009, 8, 32), rope, g, i * 0.01, 0.011 + i * 0.012, 0);
        coil.rotation.x = Math.PI / 2;
      }
    }
  } else {
    // small spill of coins
    const silver = mat(PALETTE.steel, { surface: 'metal' });
    const coin = new THREE.CylinderGeometry(0.014, 0.014, 0.003, 20);
    for (let i = 0; i < 6; i++) {
      const c = part(coin, silver, g, Math.cos(i * 2.4) * 0.025 * (1 + i * 0.25), 0.004 + (i % 3) * 0.003, Math.sin(i * 2.4) * 0.025 * (1 + i * 0.25));
      c.rotation.set(Math.sin(i * 1.7) * 0.25, 0, Math.cos(i * 1.3) * 0.25);
    }
  }
  return g;
}

/** Free everything a built item mesh owns. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
  root.removeFromParent();
}
