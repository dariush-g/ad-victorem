import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mat, solid, PALETTE, vnoise } from './style';

// ---------------------------------------------------------------------------------------
// Fitted clothing and armour. Everything here is sized from the body mesh itself, measured
// once in its bind pose (model space: +Y up, +Z forward, the figure's left at +X), so the
// pieces sit on the skin whatever the model's proportions.
// ---------------------------------------------------------------------------------------

/** The skinned body, sampled in its bind pose. */
export interface Body {
  mesh: THREE.SkinnedMesh;
  /** Vertex positions in model space. */
  pos: Float32Array;
  /** Name of the bone with the most pull on each vertex. */
  bone: string[];
}

export function analyzeBody(mesh: THREE.SkinnedMesh): Body {
  const geo = mesh.geometry, p = geo.getAttribute('position'), n = p.count;
  const si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
  const pos = new Float32Array(n * 3), bone: string[] = new Array(n), v = new THREE.Vector3();
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    pos.set([v.x, v.y, v.z], i * 3);
    let best = 0;
    for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
    bone[i] = mesh.skeleton.bones[si.getComponent(i, best)].name;
  }
  return { mesh, pos, bone };
}

/** The `q`-quantile of a list (0..1). */
function quantile(values: number[], q: number, fallback: number) {
  if (!values.length) return fallback;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(q * values.length))];
}

/** How thick a limb is: typical distance of its skin from the line a→b, over the stretch t0..t1 of that line. */
export function limbRadius(body: Body, bones: string[], a: THREE.Vector3, b: THREE.Vector3, t0 = 0, t1 = 1, q = 0.85, fallback = 0.05) {
  const ab = b.clone().sub(a), len2 = ab.lengthSq(), d: number[] = [], v = new THREE.Vector3();
  for (let i = 0; i < body.bone.length; i++) {
    if (!bones.includes(body.bone[i])) continue;
    v.fromArray(body.pos, i * 3).sub(a);
    const t = v.dot(ab) / len2;
    if (t < t0 || t > t1) continue;
    d.push(v.addScaledVector(ab, -t).length());
  }
  return quantile(d, q, fallback);
}

/** Bounding box of the skin moved by the given bones, optionally limited to a slab of height and a band of |x|. */
export function boneBox(body: Body, bones: string[], yMin = -Infinity, yMax = Infinity, xMin = 0, xMax = Infinity) {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (let i = 0; i < body.bone.length; i++) {
    if (!bones.includes(body.bone[i])) continue;
    v.fromArray(body.pos, i * 3);
    if (v.y >= yMin && v.y <= yMax && Math.abs(v.x) >= xMin && Math.abs(v.x) <= xMax) box.expandByPoint(v);
  }
  return box;
}

const TORSO = ['spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r', 'pelvis'];

/**
 * A second skin: the body faces whose corners are all marked in `keep`, pushed out along
 * their normals by `offset(x, y, z)` metres and bound to the body's own skeleton, so the
 * garment bends exactly as the body under it does and can never be poked through.
 * (The offset must depend only on position, so vertices split along UV seams stay together.)
 */
function growShell(body: Body, material: THREE.Material, keep: Uint8Array, offset: (x: number, y: number, z: number) => number) {
  const src = body.mesh.geometry, n = body.bone.length;
  // faces whose three corners all survive; vertices renumbered
  const remap = new Int32Array(n).fill(-1), order: number[] = [], index: number[] = [];
  const srcIndex = src.getIndex()!;
  for (let f = 0; f < srcIndex.count; f += 3) {
    const a = srcIndex.getX(f), b = srcIndex.getX(f + 1), c = srcIndex.getX(f + 2);
    if (!keep[a] || !keep[b] || !keep[c]) continue;
    for (const i of [a, b, c]) {
      if (remap[i] < 0) {
        remap[i] = order.length;
        order.push(i);
      }
      index.push(remap[i]);
    }
  }
  const P = src.getAttribute('position'), N = src.getAttribute('normal'), SI = src.getAttribute('skinIndex'), SW = src.getAttribute('skinWeight');
  const m = order.length;
  const pos = new Float32Array(m * 3), nor = new Float32Array(m * 3), si = new Uint16Array(m * 4), sw = new Float32Array(m * 4);
  order.forEach((i, k) => {
    const wx = body.pos[i * 3], wy = body.pos[i * 3 + 1], wz = body.pos[i * 3 + 2];
    const off = offset(wx, wy, wz);
    for (let a = 0; a < 3; a++) {
      nor[k * 3 + a] = N.getComponent(i, a);
      pos[k * 3 + a] = P.getComponent(i, a) + N.getComponent(i, a) * off;
    }
    for (let a = 0; a < 4; a++) {
      si[k * 4 + a] = SI.getComponent(i, a);
      sw[k * 4 + a] = SW.getComponent(i, a);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setIndex(index);
  const top = new THREE.SkinnedMesh(geo, material);
  top.bind(body.mesh.skeleton, body.mesh.bindMatrix);
  top.position.copy(body.mesh.position);
  top.quaternion.copy(body.mesh.quaternion);
  top.scale.copy(body.mesh.scale);
  top.castShadow = top.receiveShadow = true;
  top.frustumCulled = false;
  body.mesh.parent!.add(top);
  return top;
}

/**
 * The upper half of a tunic: a second skin grown from the body's own torso and upper-arm
 * faces, pushed out to sit loose, and bound to the same skeleton so it bends with him.
 * `cutY`: waist height where it ends (the skirt takes over). `shoulders`: the two shoulder
 * joints; sleeves reach `sleeve` metres down the arm from them. `neckY`: base of the neck.
 */
export function buildTunicTop(body: Body, material: THREE.Material, cutY: number, neckY: number, shoulders: THREE.Vector3[], elbows: THREE.Vector3[], sleeve = 0.15) {
  const n = body.bone.length;
  const keep = new Uint8Array(n), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const b = body.bone[i];
    v.fromArray(body.pos, i * 3);
    if (TORSO.includes(b)) keep[i] = v.y >= cutY && v.y <= neckY + 0.012 ? 1 : 0;
    else if (b === 'upperarm_l' || b === 'upperarm_r') {
      const s = b.endsWith('_l') ? 0 : 1, along = elbows[s].clone().sub(shoulders[s]).normalize();
      keep[i] = v.sub(shoulders[s]).dot(along) < sleeve ? 1 : 0;
    }
  }
  // loose weave: sits off the skin, bagging a little more toward the waist, with soft folds
  return growShell(body, material, keep, (x, y, z) => {
    const sag = THREE.MathUtils.clamp((neckY - y) / (neckY - cutY), 0, 1);
    const fold = vnoise(x * 14 + 40, y * 9 + z * 7 + 40, 64) - 0.5;
    return 0.015 + 0.012 * sag + fold * 0.008 * (0.4 + sag);
  });
}

/** The wrapped part of a loincloth: a snug shell over the hips and the tops of the thighs, from `hemY` up to `topY`. */
export function buildBriefs(body: Body, material: THREE.Material, topY: number, hemY: number) {
  const n = body.bone.length, keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = body.bone[i], y = body.pos[i * 3 + 1];
    if (b === 'pelvis' || b === 'spine_01') keep[i] = y >= hemY && y <= topY ? 1 : 0;
    else if (b === 'thigh_l' || b === 'thigh_r') keep[i] = y >= hemY ? 1 : 0;
  }
  // wound cloth: a few layers thick, creased where it is pulled round the hips
  return growShell(body, material, keep, (x, y, z) => 0.008 + (vnoise(x * 22 + 9, y * 30 + z * 12 + 9, 64) - 0.5) * 0.006);
}

// ------------------------------------------------------------------ armour
// Rigid pieces. Each builder returns a group to hang on one joint of the driver rig;
// coordinates are relative to that joint (limbs run down -Y from their joint).

const bronze = () => mat(PALETTE.bronze, { rim: 0.25, surface: 'metal', side: THREE.DoubleSide });
const leather = () => mat(PALETTE.leather, { rim: 0.2, surface: 'leather', side: THREE.DoubleSide });
const put = (g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const mesh = solid(geo, m);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
};

/** Bronze helmet with brow band, neck guard, cheek pieces and a horsehair crest. `box`: the head's bounds relative to the joint. */
export function buildHelmet(box: THREE.Box3) {
  const g = new THREE.Group(), metal = bronze();
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const pad = 0.014, rx = size.x / 2 + pad, rz = size.z / 2 + pad * 0.6, top = box.max.y + pad;
  const brow = top - size.y * 0.42; // rim sits just above the eyes
  const ry = top - brow;
  const z0 = c.z - 0.006;
  // bowl
  const bowl = put(g, new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), metal, 0, brow, z0);
  bowl.scale.set(rx, ry, rz);
  // brow band round the rim
  const band = put(g, new THREE.LatheGeometry([new THREE.Vector2(1, -0.013), new THREE.Vector2(1.07, -0.004), new THREE.Vector2(1.07, 0.004), new THREE.Vector2(1, 0.013)], 64), metal, 0, brow, z0);
  band.scale.set(rx, 1, rz);
  // neck guard: the back of the rim swept down and out
  const guardProf = [new THREE.Vector2(1, 0), new THREE.Vector2(1.02, -0.045), new THREE.Vector2(1.12, -0.085), new THREE.Vector2(1.3, -0.1)];
  const guard = put(g, new THREE.LatheGeometry(guardProf, 32, Math.PI * 0.62, Math.PI * 0.76), metal, 0, brow, z0);
  guard.scale.set(rx, 1, rz);
  // cheek pieces, hinged at the temples
  for (const s of [-1, 1]) {
    const cheek = put(g, new RoundedBoxGeometry(0.008, 0.105, 0.062, 3, 0.004), metal, s * (rx - 0.004), brow - 0.052, z0 + rz * 0.28);
    cheek.rotation.set(0, s * 0.18, s * 0.07);
  }
  // crest: a fan of dyed horsehair from brow to nape
  const crest = put(g, new THREE.CylinderGeometry(1, 1, 0.022, 40, 1, false, -Math.PI * 0.08, Math.PI * 1.02).rotateZ(Math.PI / 2), mat(PALETTE.crimson, { rim: 0.3, surface: 'cloth', side: THREE.DoubleSide }), 0, brow + ry * 0.06, z0);
  crest.scale.set(1, ry + 0.055, rz + 0.045);
  return g;
}

/** Bronze greave: a shell over the front of the shin with a domed knee. Hangs on the knee joint. */
export function buildGreave(shin: number, radius: number) {
  const g = new THREE.Group(), metal = bronze();
  const r = radius + 0.007;
  const prof = [[0.78, -0.035], [1.0, -0.09], [1.04, -0.2], [0.93, -0.5], [0.72, -0.82], [0.66, -0.93]].map(([k, t]) => new THREE.Vector2(r * k, t * shin));
  prof.reverse(); // lathe wants ascending y
  const shell = put(g, new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(24), 28, -Math.PI * 0.56, Math.PI * 1.12), metal, 0, 0, 0.004);
  shell.scale.z = 1.06;
  // raised spine down the front
  put(g, new THREE.CylinderGeometry(0.0045, 0.0035, shin * 0.8, 8), metal, 0, -shin * 0.5, r * 1.02 + 0.004).rotation.x = 0.045;
  // knee cap
  put(g, new THREE.SphereGeometry(r * 0.72, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(Math.PI / 2), metal, 0, -0.02, r * 0.5).scale.set(1, 1.15, 0.6);
  // straps behind the calf
  const strap = leather();
  for (const t of [0.22, 0.72]) {
    const k = t < 0.5 ? 1.02 : 0.78;
    put(g, new THREE.TorusGeometry(r * k, 0.0045, 6, 24, Math.PI * 0.95).rotateX(Math.PI / 2).rotateY(Math.PI * 0.975), strap, 0, -shin * t, 0).scale.y = 2.4;
  }
  return g;
}

/** One length of a manica: overlapping leather bands down a limb segment. Hangs on that segment's joint. */
export function buildArmBands(length: number, rTop: number, rBottom: number, from: number, to: number, bands: number) {
  const g = new THREE.Group(), hide = leather();
  for (let i = 0; i < bands; i++) {
    const t0 = from + ((to - from) * i) / bands, t1 = from + ((to - from) * (i + 1.25)) / bands;
    const r = (t: number) => rTop + (rBottom - rTop) * t + 0.009;
    // each band flares at its lower edge and tucks under the one above
    const prof = [new THREE.Vector2(r(t1) + 0.006, -t1 * length), new THREE.Vector2(r(t1) + 0.0075, -(t1 - 0.01) * length), new THREE.Vector2(r(t0) + 0.001, -t0 * length)];
    put(g, new THREE.LatheGeometry(prof, 28), hide);
  }
  return g;
}

/** Bronze shoulder cap for the manica. Hangs on the shoulder joint. */
export function buildShoulderCap(radius: number) {
  const g = new THREE.Group();
  const cap = put(g, new THREE.SphereGeometry(radius + 0.014, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), bronze(), 0, -0.02, 0);
  cap.scale.set(1, 0.9, 1.08);
  return g;
}

export interface Chest {
  /** Chest surface at the breastbone / between the shoulder blades, and half-width at the ribs; relative to the upper-chest joint. */
  front: number;
  back: number;
  half: number;
  /** Height of the centre of the plate, and of the top of the shoulders beside the neck. */
  y: number;
  shoulderY: number;
}

/** Pectorale: a square bronze heart-guard on leather straps round the ribs and over the shoulders. Hangs on the upper-chest joint. */
export function buildPectoral(c: Chest) {
  const g = new THREE.Group(), metal = bronze(), strap = leather();
  const depth = c.front - c.back, zc = (c.front + c.back) / 2;
  // plate: gently curved to the chest, with a raised boss and rim
  const w = 0.2, h = 0.19, R = 0.3, arc = w / R;
  const plate = put(g, new THREE.CylinderGeometry(R, R, h, 24, 1, true, -arc / 2, arc), metal, 0, c.y, c.front + 0.012 - R);
  const face = c.front + 0.014;
  put(g, new THREE.TorusGeometry(0.058, 0.006, 8, 40), metal, 0, c.y, face);
  put(g, new THREE.SphereGeometry(0.03, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), metal, 0, c.y, face - 0.004).scale.z = 0.5;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) put(g, new THREE.SphereGeometry(0.008, 12, 8), metal, sx * (w / 2 - 0.02), c.y + sy * (h / 2 - 0.02), face - 0.004 - (0.08 * 0.08) / (2 * R));
  // strap round the ribs
  const bandProf = [new THREE.Vector2(1, -0.014), new THREE.Vector2(1.012, 0), new THREE.Vector2(1, 0.014)];
  const belt = put(g, new THREE.LatheGeometry(bandProf, 64), strap, 0, c.y - 0.03, zc);
  belt.scale.set(c.half + 0.008, 1, depth / 2 + 0.008);
  // straps over the shoulders: half-hoops from the plate's top corners to the back strap
  const rise = c.shoulderY + 0.012 - (c.y - 0.03);
  for (const s of [-1, 1]) {
    const hoop = put(g, new THREE.LatheGeometry(bandProf, 40, 0, Math.PI).rotateZ(Math.PI / 2), strap, s * 0.075, c.y - 0.03, zc);
    hoop.scale.set(1, rise, depth / 2 + 0.007);
    hoop.rotation.z = -s * 0.1;
  }
  return g;
}
