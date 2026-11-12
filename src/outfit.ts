import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mat, solid, PALETTE } from './style';
import { ClothPanel, type Capsule, type Colliders } from './cloth';
import { ITEMS, disposeTree, type Slot } from './items';
import { type Body, type Chest, boneBox, limbRadius, buildTunicTop, buildBriefs, buildHelmet, buildGreave, buildArmBands, buildShoulderCap, buildPectoral } from './garments';

// --- fit of the loincloth on the pelvis (hips-local; model faces +Z) ---
const FIT = { y: 0.02, z: 0.012, sx: 1.16, sz: 0.95 };
const WAIST_R = 0.148; // wrap radius at the waistband, before the oval scale
const BELT_Y = FIT.y + 0.085;

interface LegJoints {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  foot: THREE.Object3D;
}
/** The parts of the driver rig that clothing hangs on, plus the measured body. Must be handed over in the bind pose. */
export interface Rig {
  root: THREE.Object3D;
  hips: THREE.Object3D;
  upperChest: THREE.Object3D;
  head: THREE.Object3D;
  armR: { upper: THREE.Object3D; lower: THREE.Object3D };
  legs: LegJoints[];
  body: Body;
  /** Bind-pose position of a bone of the model. */
  bone: (name: string) => THREE.Vector3;
}
const TUNIC_SKIRT = 0.4; // length below the belt, metres
const OVER_TUNIC = 1.09; // belts are let out this much to go over a tunic

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Cloth rolled over at the waist, lumpy like a hand-tied roll. */
function rollGeometry() {
  const geo = new THREE.TorusGeometry(WAIST_R - 0.004, 0.015, 14, 96).rotateX(Math.PI / 2);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), th = Math.atan2(x, z);
    const k = 1 + Math.sin(th * 17 + Math.sin(th * 5)) * 0.012;
    pos.setXYZ(i, x * k, pos.getY(i) * (1 + Math.sin(th * 9 + 1) * 0.18), z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Point on the (oval) waist at angle `th` from straight ahead, pushed `out` beyond the cloth. */
const onWaist = (th: number, y: number, out = 0) =>
  new THREE.Vector3(Math.sin(th) * (WAIST_R + out) * FIT.sx, y, Math.cos(th) * (WAIST_R + out) * FIT.sz + FIT.z);

/**
 * What the gladiator wears, swapped by item id: a loincloth (snug wrap + simulated hanging
 * panels), a belt, a tunic (skinned top + simulated skirt), and rigid armour for the head,
 * chest, sword arm and shins.
 */
export class Outfit {
  private garb: THREE.Group | null = null;
  private briefs: THREE.SkinnedMesh | null = null;
  private briefsFit: { topY: number; hemY: number };
  private guard = { center: new THREE.Vector3(0, 0, FIT.z), min: 0.075 };
  private belt: THREE.Group | null = null;
  private panels: ClothPanel[] = [];
  private garbId: string | null = null;
  private beltId: string | null = null;
  private capsules: Capsule[] = [];
  private colliders: Colliders;
  private root: THREE.Object3D;
  private hips: THREE.Object3D;
  private legs: LegJoints[];
  private tunicId: string | null = null;
  private tunicTop: THREE.SkinnedMesh | null = null;
  private skirt: ClothPanel | null = null;
  private armour: Partial<Record<Slot, { id: string; parts: THREE.Object3D[] }>> = {};
  // body measurements, taken once in the bind pose
  private headBox: THREE.Box3;
  private chest: Chest;
  private shinLen: number;
  private shinR: number;
  private arm: { upperLen: number; lowerLen: number; upperR: number; elbowR: number; wristR: number };
  private tunicFit: { cutY: number; neckY: number; shoulders: THREE.Vector3[]; elbows: THREE.Vector3[] };

  constructor(private rig: Rig, ground: (x: number, z: number) => number) {
    const { root, hips, legs, body, bone } = rig;
    this.root = root;
    this.hips = hips;
    this.legs = legs;
    root.updateMatrixWorld(true);
    const at = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

    const headAt = at(rig.head);
    this.headBox = boneBox(body, ['Head']).translate(headAt.clone().negate());
    const knee = bone('calf_l'), ankle = bone('foot_l');
    this.shinLen = knee.distanceTo(ankle);
    this.shinR = limbRadius(body, ['calf_l'], knee, ankle, 0.12, 0.55, 0.6, 0.055);
    const sh = bone('upperarm_r'), el = bone('lowerarm_r'), wr = bone('hand_r');
    this.arm = {
      upperLen: sh.distanceTo(el),
      lowerLen: el.distanceTo(wr),
      upperR: limbRadius(body, ['upperarm_r'], sh, el, 0.3, 0.85, 0.9, 0.055),
      elbowR: limbRadius(body, ['lowerarm_r'], el, wr, 0.08, 0.4, 0.9, 0.048),
      wristR: limbRadius(body, ['lowerarm_r'], el, wr, 0.7, 0.95, 0.9, 0.035),
    };
    const cj = at(rig.upperChest), cy = cj.y + 0.055; // middle of the breast
    const ribs = ['spine_02', 'spine_03'];
    const mid = boneBox(body, ribs, cy - 0.05, cy + 0.05, 0, 0.05), wide = boneBox(body, ribs, cy - 0.05, cy - 0.01);
    const shoulder = boneBox(body, ['spine_03', 'clavicle_l', 'clavicle_r'], cy, Infinity, 0.06, 0.09);
    this.chest = { front: mid.max.z - cj.z, back: wide.min.z - cj.z, half: wide.max.x, y: cy - cj.y, shoulderY: shoulder.max.y - cj.y };
    this.tunicFit = {
      cutY: at(hips).y + BELT_Y - 0.04,
      neckY: headAt.y,
      shoulders: [bone('upperarm_l'), bone('upperarm_r')],
      elbows: [bone('lowerarm_l'), bone('lowerarm_r')],
    };

    // what the cloth collides with, sized from the body: thighs, calves, and the hips as a squashed ball
    const hipJ = bone('thigh_l'), kneeJ = bone('calf_l'), ankleJ = bone('foot_l'), hipsAt = at(hips);
    const thighR = limbRadius(body, ['thigh_l'], hipJ, kneeJ, 0.15, 0.6, 0.92, 0.1);
    const calfR = limbRadius(body, ['calf_l'], kneeJ, ankleJ, 0.1, 0.5, 0.92, 0.062);
    for (const r of [thighR, calfR, thighR, calfR]) this.capsules.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r });
    const seat = boneBox(body, ['pelvis', 'spine_01', 'thigh_l', 'thigh_r'], hipJ.y - 0.09, hipJ.y + 0.1);
    const seatC = seat.getCenter(new THREE.Vector3()), seatS = seat.getSize(new THREE.Vector3());
    this.colliders = {
      capsules: this.capsules,
      // (tall enough to cover the seat, but narrowing to well inside the waistband, where the cloth is pinned)
      ellipsoids: [{ frame: hips, center: new THREE.Vector3(0, hipJ.y - hipsAt.y, seatC.z - hipsAt.z), radii: new THREE.Vector3(seatS.x / 2 + 0.004, (BELT_Y - (hipJ.y - hipsAt.y)) / 0.8, seatS.z / 2 + 0.004) }],
      ground,
    };
    const crotch = boneBox(body, ['pelvis'], -Infinity, Infinity, 0, 0.02).min.y;
    this.briefsFit = { topY: hipsAt.y + FIT.y + 0.11, hemY: crotch - 0.035 };
  }

  /** Put an item in a clothing slot (null = take it off). */
  set(slot: Slot, id: string | null) {
    if (slot === 'garb') this.setGarb(id);
    else if (slot === 'belt') this.setBelt(id);
    else if (slot === 'tunic') this.setTunic(id);
    else if (slot !== 'weapon') this.setArmour(slot, id);
  }

  private setTunic(id: string | null) {
    if (id === this.tunicId) return;
    this.tunicId = id;
    if (this.tunicTop) {
      this.tunicTop.removeFromParent();
      this.tunicTop.geometry.dispose();
    }
    this.skirt?.dispose();
    this.tunicTop = this.skirt = null;
    if (id) {
      const color = ITEMS[id]?.color ?? PALETTE.linen, f = this.tunicFit;
      this.tunicTop = buildTunicTop(this.rig.body, mat(color, { rim: 0.2, surface: 'cloth', side: THREE.DoubleSide }), f.cutY, f.neckY, f.shoulders, f.elbows);
      // skirt: a tube of cloth gathered at the waist, hanging to mid-thigh
      const cols = 36, out = 0.013, pins: THREE.Vector3[] = [];
      for (let c = 0; c < cols; c++) pins.push(onWaist((c / cols) * Math.PI * 2 + Math.PI, BELT_Y - 0.004, out)); // seam at the back
      const a = (WAIST_R + out) * FIT.sx, b = (WAIST_R + out) * FIT.sz, round = 2 * Math.PI * Math.sqrt((a * a + b * b) / 2);
      this.skirt = new ClothPanel(cols, 12, round * 1.22, TUNIC_SKIRT, mat(color, { rim: 0.2, surface: 'cloth', side: THREE.DoubleSide, rest: true }), this.hips, pins, true, this.guard);
      this.root.add(this.skirt.mesh);
    }
    // the loincloth's hanging panels tuck away under a tunic, and the belt goes over it
    const garb = this.garbId, belt = this.beltId, chest = this.armour.chest?.id ?? null;
    this.garbId = this.beltId = null;
    this.setGarb(garb);
    this.setBelt(belt);
    this.setArmour('chest', null);
    this.setArmour('chest', chest);
  }

  private setArmour(slot: Slot, id: string | null) {
    const old = this.armour[slot];
    if ((old?.id ?? null) === id) return;
    if (old) for (const p of old.parts) disposeTree(p);
    delete this.armour[slot];
    if (!id) return;
    const parts: THREE.Object3D[] = [];
    const hang = (piece: THREE.Object3D, on: THREE.Object3D) => {
      on.add(piece);
      parts.push(piece);
    };
    if (slot === 'head') hang(buildHelmet(this.headBox), this.rig.head);
    else if (slot === 'chest') {
      // worn over the tunic, if there is one: let the straps out by the thickness of the cloth
      const c = this.chest, pad = this.tunicId ? 0.024 : 0;
      hang(buildPectoral({ front: c.front + pad, back: c.back - pad, half: c.half + pad, y: c.y, shoulderY: c.shoulderY + pad }), this.rig.upperChest);
    }
    else if (slot === 'legs') for (const leg of this.legs) hang(buildGreave(this.shinLen, this.shinR), leg.lower);
    else if (slot === 'arm') {
      const a = this.arm;
      hang(buildShoulderCap(a.upperR), this.rig.armR.upper);
      hang(buildArmBands(a.upperLen, a.upperR, a.upperR * 0.9, 0.3, 0.9, 4), this.rig.armR.upper);
      hang(buildArmBands(a.lowerLen, a.elbowR, a.wristR, 0.06, 0.9, 5), this.rig.armR.lower);
    }
    this.armour[slot] = { id, parts };
  }

  private setGarb(id: string | null) {
    if (id === this.garbId) return;
    this.garbId = id;
    if (this.garb) disposeTree(this.garb);
    if (this.briefs) {
      this.briefs.removeFromParent();
      this.briefs.geometry.dispose();
      this.briefs = null;
    }
    for (const p of this.panels) p.dispose();
    this.garb = null;
    this.panels = [];
    if (!id) return;

    const color = ITEMS[id]?.color ?? PALETTE.linen;
    const cloth = mat(color, { rim: 0.2, surface: 'cloth' });
    const sheet = mat(color, { rim: 0.2, surface: 'cloth', side: THREE.DoubleSide, rest: true });
    const g = (this.garb = new THREE.Group());
    this.hips.add(g);
    // the wrap is grown from the body's own skin, so it moves with the hips and thighs
    this.briefs = buildBriefs(this.rig.body, mat(color, { rim: 0.2, surface: 'cloth', side: THREE.DoubleSide }), this.briefsFit.topY, this.briefsFit.hemY);
    const roll = solid(rollGeometry(), cloth);
    roll.position.set(0, FIT.y + 0.1, FIT.z);
    roll.scale.set(FIT.sx, 1, FIT.sz);
    g.add(roll);

    // hanging panels, pinned along an arc of the waist and cut wider than the arc so they fold
    const hang = (dir: number, arc: number, width: number, length: number) => {
      const cols = 13, pins: THREE.Vector3[] = [];
      for (let c = 0; c < cols; c++) {
        const th = (c / (cols - 1) - 0.5) * arc;
        pins.push(onWaist(dir > 0 ? th : Math.PI + th, FIT.y + 0.072, 0.007));
      }
      const panel = new ClothPanel(cols, 12, width, length, sheet, this.hips, pins, false, this.guard);
      this.root.add(panel.mesh);
      this.panels.push(panel);
    };
    if (this.tunicId) return; // under a tunic only the wrap is worn
    hang(1, 1.15, 0.225, 0.31);
    hang(-1, 1.3, 0.25, 0.27);
  }

  private setBelt(id: string | null) {
    if (id === this.beltId) return;
    this.beltId = id;
    if (this.belt) disposeTree(this.belt);
    this.belt = null;
    if (!id) return;
    const g = (this.belt = new THREE.Group());
    this.hips.add(g);
    if (this.tunicId) g.scale.set(OVER_TUNIC, 1, OVER_TUNIC);
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, at: THREE.Vector3) => {
      const mesh = solid(geo, m);
      mesh.position.copy(at);
      g.add(mesh);
      return mesh;
    };

    if (id === 'balteus') {
      const leather = mat(PALETTE.leather, { rim: 0.2, surface: 'leather', side: THREE.DoubleSide });
      const bronze = mat(PALETTE.bronze, { rim: 0.2, surface: 'metal' });
      // broad strap with rolled edges
      const prof = [[0.151, -0.031], [0.158, -0.028], [0.1595, -0.02], [0.1595, 0.02], [0.158, 0.028], [0.151, 0.031]].map(([r, y]) => new THREE.Vector2(r, y));
      const strap = add(new THREE.LatheGeometry(prof, 96), leather, new THREE.Vector3(0, BELT_Y, FIT.z));
      strap.scale.set(FIT.sx, 1, FIT.sz);
      // square buckle frame with a prong, and the strap's free end tucked beside it
      const front = onWaist(0, BELT_Y, 0.014);
      const frame = add(new THREE.TorusGeometry(0.034, 0.0055, 10, 4), bronze, front);
      frame.rotation.z = Math.PI / 4;
      add(new THREE.CylinderGeometry(0.003, 0.003, 0.05, 8).rotateZ(Math.PI / 2), bronze, front.clone().add(new THREE.Vector3(0, 0, 0.003)));
      const tail = add(new RoundedBoxGeometry(0.03, 0.1, 0.006, 3, 0.0028), leather, onWaist(0.34, BELT_Y - 0.055, 0.016));
      tail.rotation.set(0.05, 0.34, 0.08);
      const stud = new THREE.SphereGeometry(0.0075, 14, 10);
      for (let i = 2; i < 22; i++) {
        if (i === 12) continue; // every 15° round the sides and back
        add(stud, bronze, onWaist((i / 24) * Math.PI * 2, BELT_Y, 0.0115)).scale.setScalar(1);
      }
    } else {
      // hemp cord: two turns round the waist, knotted at the left hip, ends hanging
      const rope = mat(PALETTE.rope, { rim: 0.2, surface: 'cloth' });
      for (const [dy, tilt] of [[0.008, 0.02], [-0.008, -0.025]]) {
        const turn = add(new THREE.TorusGeometry(WAIST_R + 0.006, 0.0085, 10, 96).rotateX(Math.PI / 2), rope, new THREE.Vector3(0, BELT_Y + dy, FIT.z));
        turn.scale.set(FIT.sx, 1, FIT.sz);
        turn.rotation.z = tilt;
      }
      const knotAt = onWaist(0.55, BELT_Y, 0.012);
      add(new THREE.SphereGeometry(0.019, 16, 12), rope, knotAt).scale.set(1.1, 0.9, 0.8);
      for (const [len, lean] of [[0.13, 0.16], [0.1, -0.2]]) {
        const end = add(new THREE.CylinderGeometry(0.0075, 0.0085, len, 10).translate(0, -len / 2, 0), rope, knotAt.clone().add(new THREE.Vector3(0, -0.008, 0.004)));
        end.rotation.set(0.06, 0, lean);
        add(new THREE.SphereGeometry(0.011, 10, 8), rope, new THREE.Vector3(Math.sin(lean) * len, -Math.cos(lean) * len, 0).add(end.position)).scale.y = 1.5; // frayed tuft
      }
    }
  }

  /** Simulate the hanging cloth. Call after the rig has been posed for this frame. */
  update(dt: number) {
    if (!this.panels.length && !this.skirt) return;
    this.root.updateMatrixWorld(true);
    this.legs.forEach((leg, i) => {
      const thigh = this.capsules[i * 2], calf = this.capsules[i * 2 + 1];
      thigh.a.setFromMatrixPosition(leg.upper.matrixWorld);
      thigh.b.setFromMatrixPosition(leg.lower.matrixWorld);
      calf.a.copy(thigh.b);
      calf.b.setFromMatrixPosition(leg.foot.matrixWorld);
    });
    for (const p of this.panels) p.update(dt, this.colliders);
    this.skirt?.update(dt, this.colliders);
  }
}
