import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mat, simplifyTexture, PALETTE } from './style';
import { Verlet } from './ragdoll';
import { Outfit } from './outfit';
import { analyzeBody } from './garments';
import { ITEMS, SLOTS, buildWeapon, disposeTree, type Slot } from './items';
import type { Part } from './hits';

// Body: "Universal Base Characters" by Quaternius (CC0) — see public/models/gladiator/LICENSE.txt
const MODEL_DIR = '/models/gladiator/';

// --- movement ---
const WALK = 1.5, RUN = 5.0, JUMP = 3.8, GRAVITY = 16; // jump: ~0.45 m high, ~0.48 s in the air
const ACCEL = 16, DECEL = 20, AIR_ACCEL = 3, TURN = 9;
const BACKPEDAL = 0.62; // backward walking speed, as a fraction of WALK
const SETTLE_RATE = 7; // radians of gait phase per second while finishing the last step on stopping
// --- ragdoll ---
const RAG_MIN_TIME = 1.2, RAG_MAX_TIME = 6, GETUP_TIME = 0.9;

export type Ground = (x: number, z: number) => number;

export interface Controls {
  moveX: number; // world-space desired direction (unit or zero)
  moveZ: number;
  sprint: boolean;
  jump: boolean;
  attack: boolean;
  backpedal: boolean; // walking backward: keep facing the aim direction instead of turning round
  ragdoll: boolean; // toggle: go limp / get up
  aimYaw: number; // facing angle to snap to when attacking
  threat: number; // distance to the nearest enemy, metres (Infinity if none)
}

interface Arm {
  upper: THREE.Group;
  lower: THREE.Group;
  hand: THREE.Group;
}
interface Leg {
  upper: THREE.Group;
  lower: THREE.Group;
  foot: THREE.Group;
  side: number; // +1 left, -1 right
  tz: number; // smoothed IK target (ankle, relative to hip joint)
  ty: number;
}
interface Finger {
  bone: THREE.Object3D;
  bind: THREE.Quaternion;
  weight: number; // share of a full grip
  relaxed: number; // share of a loose, hanging hand (mostly the middle joints)
  right: boolean;
  axis: THREE.Vector3; // local hinge axis; a positive angle closes the finger toward the palm
}
/** A driver joint steering one bone of the skinned model. */
interface BoneLink {
  driver: THREE.Object3D;
  bone: THREE.Object3D;
  offset: THREE.Quaternion; // bone world rotation = driver world rotation * offset
}

// ragdoll particle indices
const HEAD = 0, NECK = 1, PELV = 2, SHL = 3, ELL = 4, HAL = 5, SHR = 6, ELR = 7, HAR = 8,
  HIPL = 9, KNL = 10, FTL = 11, HIPR = 12, KNR = 13, FTR = 14;

const { lerp, clamp } = THREE.MathUtils;
const ease = (t: number) => t * t * (3 - 2 * t);

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const FORWARD = new THREE.Vector3(0, 0, 1);

/** Rotation of a driver limb joint (hangs along local -Y, hinge faces `hint`) aimed along from→to. */
function aimLimb(from: THREE.Vector3, to: THREE.Vector3, hint: THREE.Vector3, out: THREE.Quaternion) {
  _y.subVectors(from, to).normalize();
  _z.copy(hint).addScaledVector(_y, -hint.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(_y.y, -_y.x, 0); // any perpendicular
  _z.normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

export type Confine = (p: THREE.Vector3, r: number) => void;

export async function loadGladiator(ground: Ground, confine: Confine, spawn: THREE.Vector3): Promise<Gladiator> {
  const loader = new GLTFLoader();
  const [body, hair] = await Promise.all([
    loader.loadAsync(MODEL_DIR + 'body.gltf'),
    loader.loadAsync(MODEL_DIR + 'hair.gltf'),
  ]);
  return new Gladiator(ground, confine, spawn, body.scene, hair.scene);
}

/**
 * Player character. An invisible "driver" rig (plain joint hierarchy: model faces +Z,
 * its left is +X, limbs hang along -Y) is animated procedurally or by the ragdoll, and
 * the skinned body's bones copy it every frame.
 */
export class Gladiator {
  root = new THREE.Group();
  pos = new THREE.Vector3(); // feet / physics position
  vel = new THREE.Vector3();
  radius = 0.35;
  facing = Math.PI;
  /** Counts swings, so a blow can be matched to the swing that dealt it (one hit per swing). */
  swing = 0;
  /** While set, a limp body stays down: nothing gets it back on its feet. */
  stayDown = false;

  private onGround = true;
  private attackT = -1; // seconds into the attack; <0 = not attacking
  private attack: Attack = ATTACKS.stand;
  private attackV0 = 0; // ground speed when the attack began
  private prevStance = [0, 0];
  private phase = 0;
  private time = 0;
  private squat = 0; // landing compression
  private accF = 0; // smoothed acceleration, character-local
  private accL = 0;
  private prevVel = new THREE.Vector3();
  private lastDt = 1 / 60;
  private moveW = 0; // eased share of the walk cycle in the pose
  private backTarget = false; // last clear reading of whether we are stepping backward

  // skeleton dimensions, measured from the model's bind pose
  private pelvisY = 0.95;
  private pelvisZ = 0;
  private hipX = 0.1;
  private hipDY = 0;
  private thigh = 0.43;
  private shin = 0.43;
  private ankle = 0.08;

  private hips = new THREE.Group();
  private spine = new THREE.Group(); // lower back
  private chest = new THREE.Group();
  private upperChest = new THREE.Group();
  private head = new THREE.Group();
  private headCenter = new THREE.Object3D();
  private armL: Arm;
  private armR: Arm;
  private legL: Leg;
  private legR: Leg;
  private joints: THREE.Object3D[];
  private links: BoneLink[] = [];
  private fingers: Finger[] = [];
  private curlL = 0.72; // left-hand finger curl, radians
  private smoothed: Record<string, number> = {};
  private pelvisBone: THREE.Object3D;
  private outfit: Outfit;
  private weaponMount: THREE.Group;
  private weapon: THREE.Object3D | null = null;
  private worn = Object.fromEntries(SLOTS.map((s) => [s, null])) as Record<Slot, string | null>;
  /** Standing height in metres, measured from the model. */
  height = 1.8;
  /** Multiplier on walking and running speed (agility). */
  speedMul = 1;
  private onGuard = false; // an enemy is near (or we just swung): weapon up
  private guardHold = 0; // seconds the guard stays up after a swing

  private rag: Verlet | null = null;
  private ragT = 0;
  private blendT = GETUP_TIME; // < GETUP_TIME while getting up
  private blendFrom: THREE.Quaternion[] = [];
  private blendHips = new THREE.Vector3();
  private hipsQ = new THREE.Quaternion();
  private spineQ = new THREE.Quaternion();
  private limbQ = new THREE.Quaternion();
  private limbQ2 = new THREE.Quaternion();

  constructor(private ground: Ground, private confine: Confine, spawn: THREE.Vector3, model: THREE.Object3D, hair: THREE.Object3D) {
    this.pos.copy(spawn);
    // ---- skinned body: house-style materials, bind-pose measurements ----
    this.root.add(model);
    model.updateMatrixWorld(true);
    const restyle = (o: THREE.Object3D, alphaTest = 0) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshStandardMaterial;
      const hairy = /hair/i.test(old.name), eye = /eye/i.test(old.name);
      // painted muscle detail is simplified to broad shapes so the body matches the clean arena
      const map = old.map && !hairy && !eye ? simplifyTexture(old.map) : old.map;
      const m = mat(hairy ? PALETTE.hair : 0xffffff, { rim: eye ? 0 : 0.3, map, surface: 'skin' });
      if (eye) m.roughness = 0.2; // hair texture is greyscale, meant to be tinted
      if (alphaTest) {
        m.alphaTest = alphaTest;
        m.side = THREE.DoubleSide;
      }
      mesh.material = m;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // skinned bounds don't follow the pose
    };
    model.traverse((o) => restyle(o));
    this.height = new THREE.Box3().setFromObject(model).max.y;

    const bone = (name: string) => {
      const b = model.getObjectByName(name);
      if (!b) throw new Error(`gladiator model is missing bone "${name}"`);
      return b;
    };
    const wp = (name: string) => bone(name).getWorldPosition(new THREE.Vector3());
    const wq = (name: string) => bone(name).getWorldQuaternion(new THREE.Quaternion());

    // hair is authored in model space: glue it to the head bone as-is
    hair.updateMatrixWorld(true);
    const headBone = bone('Head');
    const hairMeshes: THREE.Object3D[] = [];
    hair.traverse((o) => (o as THREE.Mesh).isMesh && hairMeshes.push(o));
    for (const h of hairMeshes) {
      restyle(h, 0.4);
      headBone.attach(h);
    }

    const P = wp('pelvis'), S = wp('spine_01'), S2 = wp('spine_02'), S3 = wp('spine_03'), N = wp('neck_01');
    this.pelvisBone = bone('pelvis');
    this.pelvisY = P.y;
    this.pelvisZ = P.z;

    const group = (parent: THREE.Object3D, at: THREE.Vector3) => {
      const g = new THREE.Group();
      g.position.copy(at);
      parent.add(g);
      return g;
    };
    const down = (len: number) => new THREE.Vector3(0, -len, 0);
    const link = (driver: THREE.Object3D, name: string, bindDriverQ?: THREE.Quaternion) => {
      const offset = wq(name);
      if (bindDriverQ) offset.premultiply(bindDriverQ.clone().invert());
      this.links.push({ driver, bone: bone(name), offset });
    };

    // ---- driver rig, sized to the model ----
    this.root.add(this.hips);
    this.hips.position.copy(P);
    this.spine.position.subVectors(S, P);
    this.hips.add(this.spine);
    this.chest.position.subVectors(S2, S);
    this.spine.add(this.chest);
    this.upperChest.position.subVectors(S3, S2);
    this.chest.add(this.upperChest);
    this.head.position.subVectors(N, S3);
    this.upperChest.add(this.head);
    this.headCenter.position.subVectors(wp('Head'), N).add(new THREE.Vector3(0, 0.09, 0.01));
    this.head.add(this.headCenter);
    link(this.hips, 'pelvis');
    link(this.spine, 'spine_01');
    link(this.chest, 'spine_02');
    link(this.upperChest, 'spine_03');
    link(this.head, 'neck_01');

    const makeArm = (s: 'l' | 'r'): Arm => {
      const a = wp('upperarm_' + s), b = wp('lowerarm_' + s), c = wp('hand_' + s);
      const upper = group(this.upperChest, a.clone().sub(S3));
      const lower = group(upper, down(a.distanceTo(b)));
      const hand = group(lower, down(b.distanceTo(c)));
      link(upper, 'upperarm_' + s, aimLimb(a, b, FORWARD, new THREE.Quaternion()));
      link(lower, 'lowerarm_' + s, aimLimb(b, c, FORWARD, new THREE.Quaternion()));
      link(hand, 'hand_' + s, aimLimb(c, wp('middle_01_' + s), FORWARD, new THREE.Quaternion()));
      return { upper, lower, hand };
    };
    const makeLeg = (s: 'l' | 'r', side: number): Leg => {
      const a = wp('thigh_' + s), b = wp('calf_' + s), c = wp('foot_' + s);
      const upper = group(this.hips, a.clone().sub(P));
      const lower = group(upper, down(a.distanceTo(b)));
      const foot = group(lower, down(b.distanceTo(c)));
      link(upper, 'thigh_' + s, aimLimb(a, b, FORWARD, new THREE.Quaternion()));
      link(lower, 'calf_' + s, aimLimb(b, c, FORWARD, new THREE.Quaternion()));
      link(foot, 'foot_' + s);
      if (side > 0) {
        this.hipX = a.x - P.x;
        this.hipDY = a.y - P.y;
        this.thigh = a.distanceTo(b);
        this.shin = b.distanceTo(c);
        this.ankle = c.y;
      }
      return { upper, lower, foot, side, tz: 0, ty: -(a.distanceTo(b) + b.distanceTo(c)) };
    };
    this.armL = makeArm('l');
    this.armR = makeArm('r');
    // yaw applied last, so a raised arm can sweep horizontally
    this.armL.upper.rotation.order = 'YXZ';
    this.armR.upper.rotation.order = 'YXZ';
    this.legL = makeLeg('l', 1);
    this.legR = makeLeg('r', -1);
    // order ZYX: a leg can undo the pelvis's twist and tilt before swinging, so a planted foot stays put
    this.legL.upper.rotation.order = 'ZYX';
    this.legR.upper.rotation.order = 'ZYX';

    // fingers: remember the bind pose so they can be curled every frame
    const fingerNames: [string, number][] = [['index', 0.85], ['middle', 0.95], ['ring', 1.05], ['pinky', 1.15]];
    // Work out each joint's hinge from the hand's geometry instead of trusting bone axes
    // (left and right hand bones are mirrored, so a fixed axis bends one hand backward).
    const hinge = (b: THREE.Object3D, toward: THREE.Vector3) => {
      const tip = b.children.find((c) => (c as THREE.Bone).isBone) ?? b.children[0];
      const q = b.getWorldQuaternion(new THREE.Quaternion());
      let best = new THREE.Vector3(0, 0, 1), score = -Infinity;
      for (const ax of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]) {
        // where the next joint moves if this one turns a little about ax
        const sc = ax.clone().cross(tip.position).applyQuaternion(q).normalize().dot(toward);
        if (sc > score) { score = sc; best = ax; }
      }
      return best;
    };
    for (const s of ['l', 'r']) {
      const along = wp('middle_01_' + s).sub(wp('hand_' + s)).normalize(); // wrist → fingers
      const across = wp('pinky_01_' + s).sub(wp('index_01_' + s)).normalize(); // index → pinky
      const palm = s === 'r' ? along.clone().cross(across) : across.clone().cross(along); // out of the palm
      palm.normalize();
      const thumbIn = across.clone().addScaledVector(palm, 0.7).normalize(); // thumb folds across the palm
      for (const [f, fw] of fingerNames)
        for (const [n, jw] of [['01', 0.8], ['02', 1.0], ['03', 0.85]] as [string, number][]) {
          const b = bone(`${f}_${n}_${s}`);
          this.fingers.push({ bone: b, bind: b.quaternion.clone(), weight: fw * jw, relaxed: fw * (n === '01' ? 0.45 : n === '02' ? 1.0 : 0.75), right: s === 'r', axis: hinge(b, palm) });
        }
      for (const n of ['02', '03']) {
        const b = bone(`thumb_${n}_${s}`);
        this.fingers.push({ bone: b, bind: b.quaternion.clone(), weight: 0.4, relaxed: 0.25, right: s === 'r', axis: hinge(b, thumbIn) });
      }
    }

    // ---- gear that rides on the driver rig: clothing, and a mount in the right fist ----
    let skin: THREE.SkinnedMesh | null = null; // the body proper: the biggest skinned mesh
    model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && (!skin || sm.geometry.getAttribute('position').count > skin.geometry.getAttribute('position').count)) skin = sm;
    });
    if (!skin) throw new Error('gladiator model has no skinned mesh');
    this.outfit = new Outfit(
      { root: this.root, hips: this.hips, upperChest: this.upperChest, head: this.head, armR: this.armR, legs: [this.legL, this.legR], body: analyzeBody(skin), bone: wp },
      ground,
    );
    this.weaponMount = group(this.armR.hand, new THREE.Vector3(GRIP.x, GRIP.y, GRIP.z));
    this.weaponMount.rotation.x = Math.PI / 2; // weapons are built blade-along-+Y

    this.joints = [
      this.hips, this.spine, this.head,
      this.chest, this.upperChest,
      this.armL.upper, this.armL.lower, this.armL.hand, this.armR.upper, this.armR.lower, this.armR.hand,
      this.legL.upper, this.legL.lower, this.legL.foot,
      this.legR.upper, this.legR.lower, this.legR.foot,
    ];
    this.blendFrom = this.joints.map(() => new THREE.Quaternion());

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.facing;
  }

  /**
   * Stand square for the character sheet: arms straight out and feet together, or (`spread`)
   * arms raised and legs apart. Only poses the rig — the next update() takes over again.
   * Returns false while ragdolled.
   */
  posePortrait(spread: boolean): boolean {
    if (this.rag) return false;
    const { hips, armL, armR, legL, legR } = this;
    hips.position.set(0, this.pelvisY, this.pelvisZ);
    for (const j of this.joints) j.rotation.set(0, 0, 0);
    const arm = Math.PI / 2 + (spread ? 0.42 : 0), leg = spread ? 0.3 : 0.03;
    armL.upper.rotation.z = arm;
    armR.upper.rotation.z = -arm;
    this.weaponMount.visible = false; // empty hands for the study; update() brings it back
    legL.upper.rotation.z = leg;
    legR.upper.rotation.z = -leg;
    this.root.updateMatrixWorld(true);
    this.syncModel();
    return true;
  }

  /** Wear or wield an item (null = take it off). */
  equip(slot: Slot, id: string | null) {
    if (this.worn[slot] === id) return;
    this.worn[slot] = id;
    if (slot !== 'weapon') this.outfit.set(slot, id);
    else {
      if (this.weapon) disposeTree(this.weapon);
      this.weapon = id ? buildWeapon(id) : null;
      if (this.weapon) this.weaponMount.add(this.weapon);
    }
  }

  get attacking() {
    return this.attackT >= 0;
  }
  /** Which swing is in progress (or was last thrown). */
  get attackKind(): AttackKind {
    return (Object.keys(ATTACKS) as AttackKind[]).find((k) => ATTACKS[k] === this.attack || PUNCHES[k] === this.attack)!;
  }
  /** The attacks on offer: sword swings with a weapon in hand, punches without. */
  private get moves() {
    return this.worn.weapon ? ATTACKS : PUNCHES;
  }
  /** Fall limp on the spot and stay down (death). */
  collapse() {
    this.stayDown = true;
    if (!this.rag) this.startRagdoll();
  }
  /** Start a given swing now, whatever the controls say. Used to replay a remote fighter's attack. */
  forceAttack(kind: AttackKind, facing: number) {
    if (this.rag) return;
    this.attack = this.moves[kind];
    this.attackT = 0;
    this.swing++;
    this.attackV0 = Math.hypot(this.vel.x, this.vel.z);
    this.facing = facing;
  }
  /** Stand somewhere else, on your feet and at rest: drops any ragdoll, swing or momentum. */
  place(pos: THREE.Vector3, facing: number) {
    this.rag = null;
    this.stayDown = false;
    this.blendT = GETUP_TIME;
    this.attackT = -1;
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.prevVel.set(0, 0, 0);
    this.onGround = true;
    this.facing = facing;
    this.root.position.copy(pos);
    this.root.rotation.set(0, facing, 0);
  }
  get grounded() {
    return this.onGround;
  }
  get ragdolled() {
    return this.rag !== null;
  }

  /** The cutting part of the swing: the blade (or fist) can wound only around the moment of impact. */
  get striking() {
    if (!this.attacking || this.rag) return false;
    const t = this.attackT / this.attack.time, at = this.attack.strikeAt;
    return t > at - STRIKE_LEAD && t < at + STRIKE_FOLLOW;
  }

  /** World-space ends of whatever strikes: the blade's edge, or the right fist. Returns its radius. */
  weaponSegment(a: THREE.Vector3, b: THREE.Vector3): number {
    this.root.updateMatrixWorld(true);
    const blade = this.worn.weapon ? ITEMS[this.worn.weapon].blade : undefined;
    if (blade) {
      this.weaponMount.localToWorld(a.set(0, blade[0], 0));
      this.weaponMount.localToWorld(b.set(0, blade[1], 0));
      return 0.02;
    }
    this.armR.hand.getWorldPosition(a);
    this.weaponMount.localToWorld(b.set(0, 0.03, 0)); // knuckles, just past the grip point in the palm
    return 0.055;
  }

  /** The body as capsules, one or more per hit zone, in world space (posed as currently drawn). */
  bodyParts(): Part[] {
    this.root.updateMatrixWorld(true);
    const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const skull = at(this.headCenter), neckBase = at(this.head), pelvis = at(this.hips);
    const parts: Part[] = [
      { zone: 'head', a: skull, b: skull.clone(), r: 0.115 },
      { zone: 'neck', a: neckBase.clone().lerp(skull, -0.15), b: neckBase.clone().lerp(skull, 0.4), r: 0.06 },
      { zone: 'torso', a: pelvis, b: pelvis.clone().lerp(neckBase, 0.8), r: 0.15 },
    ];
    for (const [arm, zone] of [[this.armL, 'armL'], [this.armR, 'armR']] as const) {
      const sh = at(arm.upper), el = at(arm.lower), wr = at(arm.hand);
      parts.push({ zone, a: sh, b: el, r: 0.055 }, { zone, a: el, b: wr, r: 0.045 }, { zone, a: wr, b: wr.clone().lerp(el, -0.4), r: 0.05 });
    }
    for (const leg of [this.legL, this.legR]) {
      const hip = at(leg.upper), knee = at(leg.lower), ankle = at(leg.foot);
      parts.push({ zone: 'thigh', a: hip, b: knee, r: 0.085 }, { zone: 'leg', a: knee, b: ankle, r: 0.06 });
    }
    return parts;
  }

  update(dt: number, c: Controls) {
    if (dt <= 0) return;
    this.weaponMount.visible = true;
    this.time += dt;
    this.lastDt = dt;

    // guard goes up when an enemy comes close and drops once they are well clear
    this.guardHold = this.attacking ? GUARD_HOLD : Math.max(0, this.guardHold - dt);
    this.onGuard = c.threat < (this.onGuard ? GUARD_EXIT : GUARD_ENTER) || this.guardHold > 0;

    if (this.rag) this.updateRagdoll(dt, c);
    else if (c.ragdoll && this.blendT >= GETUP_TIME) this.startRagdoll();
    else this.updateActive(dt, c);
    this.syncModel();
    this.outfit.update(dt);
  }

  /** Copy the driver rig's pose onto the skinned body's bones. */
  private syncModel() {
    const pb = this.pelvisBone;
    this.hips.getWorldPosition(pb.position);
    pb.parent!.worldToLocal(pb.position);
    for (const l of this.links) {
      l.driver.getWorldQuaternion(_q).multiply(l.offset);
      l.bone.parent!.getWorldQuaternion(_q2).invert();
      l.bone.quaternion.copy(_q2).multiply(_q);
    }
    for (const f of this.fingers) {
      const curl = f.right ? FIST_CURL * f.weight : this.curlL * f.relaxed;
      f.bone.quaternion.copy(f.bind).multiply(_q.setFromAxisAngle(f.axis, curl));
    }
  }

  /** Exponentially ease a named value toward its target (gives limbs follow-through). */
  private ease(key: string, target: number, rate: number, dt: number) {
    const cur = this.smoothed[key] ?? target;
    return (this.smoothed[key] = cur + (target - cur) * (1 - Math.exp(-rate * dt)));
  }

  private updateActive(dt: number, c: Controls) {
    const gettingUp = this.blendT < GETUP_TIME;
    const groundY = this.ground(this.pos.x, this.pos.z);
    let grounded = this.onGround;
    const speed = Math.hypot(this.vel.x, this.vel.z);

    // --- attack: which one depends on how fast you were moving when you swung ---
    if (c.attack && !this.attacking && !gettingUp && grounded) {
      this.attack = this.moves[speed > RUN_ATTACK_SPEED ? 'run' : speed > WALK_ATTACK_SPEED ? 'walk' : 'stand'];
      this.attackT = 0;
      this.swing++;
      this.attackV0 = speed;
      // a running lunge carries on along your path; the others turn to where you're aiming
      this.facing = this.attack === this.moves.run ? Math.atan2(this.vel.x, this.vel.z) : c.aimYaw;
    }
    if (this.attacking) {
      this.attackT += dt;
      if (this.attackT / this.attack.time >= 1) this.attackT = -1;
    }

    // --- movement ---
    const moving = !gettingUp && !this.attacking && (c.moveX !== 0 || c.moveZ !== 0);
    if (this.attacking) {
      // committed: no steering, the attack itself moves you
      const sp = this.attack.speed(this.attackT / this.attack.time, this.attackV0);
      this.vel.x = Math.sin(this.facing) * sp;
      this.vel.z = Math.cos(this.facing) * sp;
    } else {
      // finite acceleration, so starts, stops and turns carry weight
      const top = (c.backpedal ? WALK * BACKPEDAL : c.sprint ? RUN : WALK) * this.speedMul;
      const tx = moving ? c.moveX * top : 0, tz = moving ? c.moveZ * top : 0;
      const dvx = tx - this.vel.x, dvz = tz - this.vel.z;
      const dv = Math.hypot(dvx, dvz);
      if (dv > 1e-5) {
        const rate = grounded ? (moving ? ACCEL : DECEL) : AIR_ACCEL;
        const k = Math.min(1, (rate * dt) / dv);
        this.vel.x += dvx * k;
        this.vel.z += dvz * k;
      }
    }
    const jumped = grounded && c.jump && !this.attacking && !gettingUp;
    if (jumped) this.vel.y = JUMP;
    this.vel.y -= GRAVITY * dt;
    const fallSpeed = -this.vel.y;
    this.pos.addScaledVector(this.vel, dt);

    // Land, or stay glued to the sand when walking downhill.
    const gap = this.pos.y - groundY;
    if (gap <= 0 || (grounded && !jumped && gap < 0.4)) {
      if (!grounded) this.squat = Math.min(0.28, fallSpeed * 0.035); // absorb the landing
      this.pos.y = groundY;
      this.vel.y = 0;
      grounded = true;
    } else grounded = false;
    this.onGround = grounded;
    this.squat *= Math.exp(-7 * dt);

    // --- facing: travel direction, or held on the aim while backing up ---
    if (moving) this.facing = c.backpedal ? c.aimYaw : Math.atan2(c.moveX, c.moveZ);
    let diff = this.facing - this.root.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.root.rotation.y += clamp(diff * (1 - Math.exp(-11 * dt)), -TURN * dt, TURN * dt);
    this.root.position.copy(this.pos);

    this.animate(dt, grounded);

    // --- blend out of the ragdoll pose while getting up ---
    if (gettingUp) {
      this.blendT += dt;
      const k = ease(Math.min(1, this.blendT / GETUP_TIME));
      this.joints.forEach((j, i) => {
        _q.copy(j.quaternion);
        j.quaternion.copy(this.blendFrom[i]).slerp(_q, k);
      });
      this.hips.position.lerpVectors(this.blendHips, this.hips.position, k);
    }
  }

  // ---------------------------------------------------------------- animation

  private animate(dt: number, grounded: boolean) {
    const { hips, spine, head, armL, armR, legL, legR } = this;
    const yaw = this.root.rotation.y, sy = Math.sin(yaw), cy = Math.cos(yaw);
    const v = Math.hypot(this.vel.x, this.vel.z);
    const TAU = Math.PI * 2;
    // Gait weights are eased rather than read straight off the speed, so starting, stopping,
    // breaking into a run and turning round blend over a few frames instead of popping.
    const amtNow = ease(Math.min(1, v / 1.2));
    this.moveW += (amtNow - this.moveW) * (1 - Math.exp(-(amtNow > this.moveW ? 12 : 6) * dt)); // in quick, out gentler
    const amt = this.moveW;
    const run = this.ease('run', ease(clamp((v - WALK) / (RUN - WALK), 0, 1)), 5, dt);
    const idle = 1 - amt;
    // stepping backward; below a crawl, keep whatever we were doing (direction is noise there)
    if (v > 0.3) this.backTarget = this.vel.x * sy + this.vel.z * cy < -0.25 * v;
    const back = this.ease('back', this.backTarget ? 1 : 0, 8, dt);
    const dirSign = 1 - 2 * back; // eases through zero instead of flipping the stride

    // character-local acceleration drives lean
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const ax = (this.vel.x - this.prevVel.x) * inv, az = (this.vel.z - this.prevVel.z) * inv;
    this.prevVel.copy(this.vel);
    const s = 1 - Math.exp(-8 * dt);
    this.accF += (ax * sy + az * cy - this.accF) * s;
    this.accL += (ax * cy - az * sy - this.accL) * s;

    // attack overlay weight: fades in fast, out slower
    const atk = this.attacking ? this.attack : null;
    const at = atk ? this.attackT / atk.time : 0;
    const w = atk ? Math.min(ease(Math.min(1, at / 0.14)), ease(Math.min(1, (1 - at) / 0.26))) : 0;
    const gait = amt * (1 - w); // how much the walk cycle drives the legs

    // Gait: each foot travels 2A backward during stance, so phase speed is tied to
    // ground speed and feet don't skate. Runs in reverse when backing up.
    // Each foot is on the ground for a share D of the cycle: half of it walking, under a third
    // running (the rest is flight). It travels 2A backward in that time, so for the feet not to skate
    // the cycle must cover 2A / D of ground: that sets how fast the phase turns.
    const D = lerp(0.5, 0.3, run);
    // A is capped by what the legs can reach from the current hip height (pelvis lowest at contact
    // when walking, a touch high at touchdown when running); a foot asked to go further would stop
    // short and slide.
    const bobContact = lerp(-0.03, 0.015, run) * amt;
    const hipH = this.pelvisY + this.hipDY - this.ankle - (this.smoothed.drop ?? READY.drop) + bobContact;
    const reach = 0.94 * (this.thigh + this.shin);
    const A = Math.min(lerp(0.33, 0.4, run) * lerp(1, 0.7, back), Math.sqrt(Math.max(0.0025, reach * reach - hipH * hipH)));
    this.phase += (dirSign * dt * v * TAU * D) / (2 * A);
    // Coming to a halt: finish the step so the feet arrive side by side (phase π/2 + kπ, where both
    // stride offsets are zero) instead of being dragged together across the sand.
    if (v < 0.5 && amt > 0.02 && !this.attacking) {
      const dir = this.backTarget ? -1 : 1, k = (this.phase - Math.PI / 2) / Math.PI;
      const left = Math.abs((dir > 0 ? Math.ceil(k) : Math.floor(k)) - k) * Math.PI;
      this.phase += dir * Math.min(left, dt * SETTLE_RATE);
    }
    const ph = this.phase, cph = Math.cos(ph), sph = Math.sin(ph);
    const breath = Math.sin(this.time * 1.9);
    // Idle life: layered slow waves at unrelated rates, so the ready stance never loops visibly.
    const t = this.time;
    const shift = Math.sin(t * 0.7); // weight drifting from foot to foot
    // still pose: arms hanging at ease, or the ready stance while on guard
    const guard = ease(this.ease('guard', this.onGuard ? 1 : 0, this.onGuard ? 7 : 3.5, dt));
    for (const ch of CHANNELS) _still[ch] = lerp(RELAXED[ch], READY[ch], guard);
    const live = 0.35 + 0.65 * guard; // hanging arms drift less than a held guard
    const bounce = Math.sin(t * 2.7) * guard; // fighter's weight bounce on the knees
    const swordBob = (Math.sin(t * 1.3 + 0.4) + 0.4 * Math.sin(t * 2.9)) * live;
    const guardBob = (Math.sin(t * 1.1 + 2.0) + 0.4 * Math.sin(t * 2.3 + 1.0)) * live;
    const pos = (x: number) => 0.25 * (1 + x) * (1 + x); // smooth "positive part" of a -1..1 wave (no kinks)

    // ---- base pose: ready stance when still, blending into the stride when moving ----
    const swing = (0.38 + 0.5 * run) * lerp(1, 0.6, back);
    const lagE = Math.cos(ph - 0.55), lagW = Math.cos(ph - 1.1);
    const R = _still;
    const pose: Pose = {
      // right arm: sword up in guard, or a relaxed carry swinging with the stride
      rS: lerp(R.rS, -0.12 + cph * swing * 0.6, amt) + (breath * 0.025 + swordBob * 0.045) * idle,
      rO: lerp(R.rO, -0.28, amt) + Math.sin(t * 0.9 + 1.2) * 0.03 * idle,
      rY: lerp(R.rY, 0, amt),
      rE: lerp(R.rE, -0.7 - run * 0.5 - pos(-lagE) * 0.3, amt) + Math.sin(t * 1.3 + 1.3) * 0.07 * live * idle,
      rR: 0,
      rW: lerp(R.rW, 0.08 + lagW * 0.12, amt) + Math.sin(t * 1.7 + 0.2) * 0.09 * live * idle, // sword tip circles
      // left arm: forward for balance, or a pendulum trailing the stride
      lS: lerp(R.lS, -cph * swing + 0.04, amt) + (breath * 0.025 + guardBob * 0.04) * idle,
      lO: lerp(R.lO, 0.13 + 0.06 * run - pos(cph) * 0.05, amt) + Math.sin(t * 0.8 + 0.5) * 0.03 * idle,
      lE: lerp(R.lE, -(0.42 + run) - pos(lagE) * 0.4, amt) + Math.sin(t * 1.1 + 2.9) * 0.08 * live * idle,
      twist: lerp(R.twist, -cph * 0.26, amt) + Math.sin(t * 0.55 + 1.0) * 0.05 * idle,
      lean: lerp(R.lean, 0.04 + run * 0.42, amt) + clamp(this.accF * 0.012, -0.16, 0.2) - 0.07 * amt * back + (bounce * 0.012 + breath * 0.012) * idle,
      roll: clamp(-this.accL * 0.01, -0.18, 0.18) + sph * 0.035 * amt + shift * 0.022 * idle, // shoulders stay level over the dropping pelvis
      drop: lerp(R.drop, 0.09 + 0.08 * run, amt) + this.squat + (bounce * 0.013 + breath * 0.007) * idle,
      hipYaw: lerp(R.hipYaw, cph * 0.14, amt) - Math.sin(t * 0.55 + 1.0) * 0.025 * idle,
      fzL: R.fzL * idle,
      fzR: R.fzR * idle,
      width: R.width * idle,
    };
    if (atk) {
      const a = samplePose(atk, at);
      for (const ch of CHANNELS) pose[ch] = lerp(pose[ch], a[ch], w);
    }
    // ease every channel so pose changes flow instead of snapping (attacks stay crisp)
    const rate = atk ? 40 : 14;
    const E = (key: string, val: number, r = rate) => this.ease(key, val, r, dt);
    for (const ch of CHANNELS) pose[ch] = E(ch, pose[ch]);

    // ---- legs: stride + stance offsets, planted on the sand under each foot ----
    const liftH = lerp(0.07, 0.2, run);
    const plan = (leg: Leg, phi: number, stance: number, i: number) => {
      const u = ((phi % TAU) + TAU) % TAU, sw = TAU * (1 - D);
      const inAir = u < sw, n = inAir ? u / sw : (u - sw) / (TAU - sw); // 0..1 through swing or stance
      // stance: straight line back at ground speed. swing: Hermite cubic from -1 to +1 whose end
      // slopes match that ground speed, so the foot leaves and meets the sand without a jolt.
      const r = (1 - D) / D;
      const stride = inAir ? ((-4 * n + 6) * n) * n - 1 - 2 * r * (((2 * n - 3) * n + 1) * n) : 1 - 2 * n; // in units of A
      const sp = inAir ? Math.sin(Math.PI * n) : 0;
      const fz = stride * A * gait + stance;
      const lx = leg.side * (this.hipX + 0.012 + pose.width - 0.04 * gait); // striding feet land close to the centre line, not out at the hips
      const gy = clamp(this.ground(this.pos.x + lx * cy + fz * sy, this.pos.z - lx * sy + fz * cy) - this.pos.y, -0.3, 0.3);
      // a foot being repositioned (stance change, lunge, step-in) lifts instead of dragging
      const stepLift = Math.min(0.1, Math.abs(stance - this.prevStance[i]) * inv * 0.035);
      this.prevStance[i] = stance;
      const comp = inAir ? 0 : Math.sin(Math.PI * n); // how deep into its stance (weight on it)
      return { fz, gy, lift: (sp > 0 ? sp * sp * liftH * 1.15 * gait : 0) + stepLift, phi, comp }; // sin²: soft takeoff and landing
    };
    const L = plan(legL, ph, pose.fzL, 0), Rr = plan(legR, ph + Math.PI, pose.fzR, 1);

    const bob = lerp(-Math.cos(2 * ph) * 0.03, 0.015 - (L.comp + Rr.comp) * 0.05, run) * gait;
    const pelvisY = this.pelvisY - pose.drop + bob + (grounded ? Math.min(0, L.gy, Rr.gy) * 0.8 : 0);
    // weight shifts over the planted foot; idle: slow sway
    hips.position.set(-sph * 0.014 * gait + shift * 0.016 * idle, pelvisY, this.pelvisZ);
    hips.rotation.set(0, pose.hipYaw, -sph * 0.04 * gait);

    const k = 1 - Math.exp(-40 * dt);
    const hipY = pelvisY + this.hipDY;
    // heel strikes toes-up, rolls flat, pushes off toes-down
    const footPitch = (phi: number) => {
      const u = ((phi % TAU) + TAU) % TAU, sw = TAU * (1 - D);
      if (u < sw) return 0.07 + 0.38 * Math.cos((Math.PI * u) / sw);
      const st = (u - sw) / (TAU - sw);
      return st < 0.2 ? lerp(-0.31, 0, ease(st / 0.2)) : st > 0.7 ? lerp(0, 0.45, ease((st - 0.7) / 0.3)) : 0;
    };
    // While striding, targets are in the body's frame, not the pelvis's: the hip joint moves as the
    // pelvis twists and tilts, so take that shift off the target and let the leg undo the rotation.
    const hipYawNow = hips.rotation.y, hipRollNow = hips.rotation.z;
    const place = (leg: Leg, t: { fz: number; gy: number; lift: number; phi: number }, airZ: number, airY: number) => {
      _a.copy(leg.upper.position).applyQuaternion(hips.quaternion).sub(leg.upper.position);
      const tz = grounded ? t.fz - _a.z * gait : airZ;
      const ty = grounded ? t.gy + this.ankle + t.lift - hipY - _a.y * gait : airY;
      leg.tz += (tz - leg.tz) * k;
      leg.ty += (ty - leg.ty) * k;
      this.solveLeg(leg, grounded ? footPitch(t.phi) * gait * (0.7 + 0.3 * run) * lerp(1, 0.3, back) : 0.35, -hipYawNow * gait, -hipRollNow * gait);
    };
    place(legL, L, 0.14, -0.6);
    place(legR, Rr, -0.1, -0.72);

    // ---- arms ----
    armL.upper.rotation.set(pose.lS, 0, pose.lO);
    armL.lower.rotation.set(pose.lE, 0, 0);
    armL.hand.rotation.set(E('lW', -0.04 - lagW * 0.1 * amt, 11), 0, 0);
    armR.upper.rotation.set(pose.rS, pose.rY, pose.rO);
    armR.lower.rotation.set(pose.rE, pose.rR, 0);
    armR.hand.rotation.set(pose.rW, 0, 0);
    this.curlL = E('curl', 0.75 + 0.45 * run + (atk ? 0.4 : 0) + breath * 0.04, 6); // loose fist, tightening with effort

    // ---- torso: bend spread over three spine segments so it flexes instead of hinging ----
    spine.rotation.set(pose.lean * 0.3, pose.twist * 0.25, pose.roll * 0.3);
    this.chest.rotation.set(pose.lean * 0.35 + breath * 0.008, pose.twist * 0.35, pose.roll * 0.35);
    this.upperChest.rotation.set(pose.lean * 0.35 + breath * 0.012, pose.twist * 0.4, pose.roll * 0.35);
    // eyes stay level and on the target, whatever the hips and shoulders do
    // idle: the head scans the arena, nods with the breath, and tilts a little (fades out when moving or striking)
    const look = E('look', idle * (1 - w), 5);
    head.rotation.set(
      -pose.lean * 0.55 + (Math.sin(t * 0.61 + 0.5) * 0.05 + breath * 0.015) * look,
      -(pose.twist + pose.hipYaw) * 0.8 + (Math.sin(t * 0.43) * 0.2 + Math.sin(t * 1.07 + 1.3) * 0.07) * look,
      -pose.roll * 0.6 + Math.sin(t * 0.37 + 2.0) * 0.04 * look,
    );
  }

  /** Two-bone IK in the leg's sagittal plane: put the ankle at (tz, ty) from the hip. */
  private solveLeg(leg: Leg, toePitch: number, yaw = 0, roll = 0) {
    const T = this.thigh, S = this.shin;
    const full = T + S, soft = 0.95 * full, raw = Math.hypot(leg.tz, leg.ty);
    // approach full extension asymptotically: the knee never snaps straight (that pop reads as jerky)
    const d = Math.max(0.25, raw <= soft ? raw : soft + (full - soft) * 0.985 * (1 - Math.exp(-(raw - soft) / (full - soft))));
    const toTarget = Math.atan2(-leg.tz, -leg.ty);
    const hipIn = Math.acos(clamp((T * T + d * d - S * S) / (2 * T * d), -1, 1));
    const kneeIn = Math.acos(clamp((T * T + S * S - d * d) / (2 * T * S), -1, 1));
    const hipRot = toTarget - hipIn; // knee forward
    const kneeRot = Math.PI - kneeIn;
    leg.upper.rotation.set(hipRot, yaw, roll);
    leg.lower.rotation.set(kneeRot, 0, 0);
    leg.foot.rotation.set(-(hipRot + kneeRot) + toePitch, 0, 0); // sole stays flat
  }

  // ------------------------------------------------------------------ ragdoll

  private startRagdoll() {
    this.root.updateMatrixWorld(true);
    const rag = new Verlet();
    const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const { armL, armR, legL, legR } = this;
    // order must match the particle index constants
    rag.add(at(this.headCenter), 0.25, 0.11);
    rag.add(at(this.head), 0.08, 0.1);
    rag.add(at(this.hips), 0.08, 0.11);
    for (const arm of [armL, armR]) {
      rag.add(at(arm.upper), 0.15, 0.08);
      rag.add(at(arm.lower), 0.4, 0.05);
      rag.add(at(arm.hand), 0.7, 0.045);
    }
    for (const leg of [legL, legR]) {
      rag.add(at(leg.upper), 0.12, 0.1);
      rag.add(at(leg.lower), 0.3, 0.06);
      rag.add(at(leg.foot), 0.5, 0.05);
    }
    // rigid torso
    const torso = [NECK, PELV, SHL, SHR, HIPL, HIPR];
    for (let i = 0; i < torso.length; i++) for (let j = i + 1; j < torso.length; j++) rag.link(torso[i], torso[j]);
    // neck: rigid length, springy direction
    rag.link(HEAD, NECK);
    rag.link(HEAD, SHL, 0.25);
    rag.link(HEAD, SHR, 0.25);
    // limbs
    for (const [a, b, c] of [[SHL, ELL, HAL], [SHR, ELR, HAR], [HIPL, KNL, FTL], [HIPR, KNR, FTR]]) {
      rag.link(a, b);
      rag.link(b, c);
    }
    // crude joint limits
    rag.limit(SHL, HAL, 0.1);
    rag.limit(SHR, HAR, 0.1);
    rag.limit(HIPL, FTL, 0.32);
    rag.limit(HIPR, FTR, 0.32);
    rag.limit(KNL, KNR, 0.15);
    rag.limit(FTL, FTR, 0.13);
    rag.limit(HAL, PELV, 0.2);
    rag.limit(HAR, PELV, 0.2);
    rag.limit(HEAD, PELV, 0.45);

    // carry current momentum; upper body gets a shove so a standing body topples
    const h = this.lastDt / 3;
    const fx = Math.sin(this.root.rotation.y), fz = Math.cos(this.root.rotation.y);
    const dirn = Math.hypot(this.vel.x, this.vel.z) > 1 ? 0.6 : Math.random() < 0.5 ? 1.3 : -1.1;
    rag.p.forEach((p, i) => {
      const upper = i === HEAD || i === NECK || i === SHL || i === SHR ? dirn : 0;
      rag.prev[i].set(
        p.x - (this.vel.x + fx * upper + (Math.random() - 0.5) * 0.3) * h,
        p.y - this.vel.y * h,
        p.z - (this.vel.z + fz * upper + (Math.random() - 0.5) * 0.3) * h,
      );
    });

    this.rag = rag;
    this.ragT = 0;
    this.attackT = -1;
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.poseFromRagdoll();
  }

  private updateRagdoll(dt: number, c: Controls) {
    const rag = this.rag!;
    this.ragT += dt;
    for (let i = 0; i < 3; i++) rag.step(dt / 3, this.ground, this.confine);
    this.poseFromRagdoll();

    const pel = rag.p[PELV];
    this.pos.set(pel.x, this.ground(pel.x, pel.z), pel.z); // camera + arena follow the body
    this.vel.set(0, 0, 0);

    const wants = c.ragdoll || c.jump || c.moveX !== 0 || c.moveZ !== 0;
    if (!this.stayDown && ((wants && this.ragT > RAG_MIN_TIME) || this.ragT > RAG_MAX_TIME)) this.getUp();
  }

  /** Drive the rig's joint rotations from particle positions (root is identity here). */
  private poseFromRagdoll() {
    const P = this.rag!.p;
    const { hips, spine, head, hipsQ, spineQ } = this;
    const axes = (out: THREE.Quaternion) => out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));

    // pelvis
    _x.subVectors(P[HIPL], P[HIPR]).normalize();
    _a.subVectors(P[NECK], P[PELV]);
    _z.crossVectors(_x, _a).normalize();
    _y.crossVectors(_z, _x);
    axes(hipsQ);
    hips.quaternion.copy(hipsQ);
    hips.position.copy(P[PELV]);
    const fwd = _z.clone();

    // chest
    _y.subVectors(P[NECK], P[PELV]).normalize();
    _a.subVectors(P[SHL], P[SHR]);
    _z.crossVectors(_a, _y).normalize();
    _x.crossVectors(_y, _z);
    axes(spineQ);
    spine.quaternion.copy(hipsQ).invert().multiply(spineQ);
    const chestFwd = _z.clone(), chestX = _x.clone();

    // head
    _y.subVectors(P[HEAD], P[NECK]).normalize();
    _z.crossVectors(chestX, _y).normalize();
    _x.crossVectors(_y, _z);
    head.quaternion.copy(spineQ).invert().multiply(axes(_q));

    this.poseLimb(this.armL, SHL, ELL, HAL, spineQ, chestFwd, -1);
    this.poseLimb(this.armR, SHR, ELR, HAR, spineQ, chestFwd, -1);
    this.poseLimb(this.legL, HIPL, KNL, FTL, hipsQ, fwd, 1);
    this.poseLimb(this.legR, HIPR, KNR, FTR, hipsQ, fwd, 1);
    for (const j of [this.chest, this.upperChest, this.armL.hand, this.armR.hand, this.legL.foot, this.legR.foot]) j.quaternion.identity();
  }

  /** Aim a two-bone limb along a→b→c. `bendSign` +1: joint points forward (knee), -1: back (elbow). */
  private poseLimb(limb: { upper: THREE.Group; lower: THREE.Group }, a: number, b: number, c: number, parentQ: THREE.Quaternion, fallback: THREE.Vector3, bendSign: number) {
    const P = this.rag!.p;
    // hinge "forward" hint: direction the middle joint sticks out, if it's bent enough to tell
    _a.addVectors(P[a], P[c]).multiplyScalar(0.5);
    _b.subVectors(P[b], _a).multiplyScalar(bendSign);
    const hint = _b.lengthSq() > 0.0012 ? _b : fallback;
    aimLimb(P[a], P[b], hint, this.limbQ);
    limb.upper.quaternion.copy(parentQ).invert().multiply(this.limbQ);
    aimLimb(P[b], P[c], hint, this.limbQ2);
    limb.lower.quaternion.copy(this.limbQ).invert().multiply(this.limbQ2);
  }

  private getUp() {
    const P = this.rag!.p;
    // stand facing the way the chest points, if it isn't staring at the sky or the sand
    _z.set(0, 0, 1).applyQuaternion(this.spineQ);
    if (Math.hypot(_z.x, _z.z) > 0.5) this.facing = Math.atan2(_z.x, _z.z);
    this.pos.set(P[PELV].x, this.ground(P[PELV].x, P[PELV].z), P[PELV].z);
    this.vel.set(0, 0, 0);
    this.prevVel.set(0, 0, 0);
    this.onGround = true;

    // re-express the pelvis under the restored root, keep every other joint's local pose
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.facing, 0);
    _q.copy(this.root.quaternion).invert();
    this.hips.quaternion.copy(_q).multiply(this.hipsQ);
    this.hips.position.copy(P[PELV]).sub(this.pos).applyQuaternion(_q);

    this.joints.forEach((j, i) => this.blendFrom[i].copy(j.quaternion));
    this.blendHips.copy(this.hips.position);
    this.blendT = 0;
    this.rag = null;
  }
}

// ------------------------------------------------------------------ poses
// Angles in radians on the driver rig. Arms: S = shoulder pitch (negative = forward/up),
// O = out from the side (right arm: negative = outward), Y = horizontal sweep (negative =
// toward the right), E = elbow (negative = bent), R = forearm roll, W = wrist (positive lays
// the blade in line with the forearm). twist/hipYaw: positive brings the right side forward.
// fzL/fzR: foot offsets forward (+) or back (-), metres. drop: how far the pelvis sinks.
const CHANNELS = ['rS', 'rO', 'rY', 'rE', 'rR', 'rW', 'lS', 'lO', 'lE', 'twist', 'lean', 'roll', 'drop', 'hipYaw', 'fzL', 'fzR', 'width'] as const;
type Pose = Record<(typeof CHANNELS)[number], number>;

/** Ready stance: left foot forward, body bladed, knees soft, sword up, free hand out. */
const READY: Pose = {
  rS: -0.55, rO: -0.3, rY: 0, rE: -1.3, rR: 0, rW: 0.15,
  lS: -0.18, lO: 0.2, lE: -0.55,
  twist: 0.16, lean: 0.11, roll: 0, drop: 0.075, hipYaw: -0.34,
  fzL: 0.21, fzR: -0.18, width: 0.04,
};

interface Attack {
  time: number; // seconds
  strikeAt: number; // fraction of `time` when the blow lands
  /** Forward speed during the attack; t = 0..1, v0 = ground speed when it began. */
  speed: (t: number, v0: number) => number;
  /** [fraction of time, pose]; channels left out fall back to READY. */
  keys: [number, Partial<Pose>][];
}

const bell = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));
const WALK_ATTACK_SPEED = 0.8, RUN_ATTACK_SPEED = 4.0;

export type AttackKind = 'stand' | 'walk' | 'run';
const ATTACKS: Record<AttackKind, Attack> = {
  // Standing: feet planted, flat cut from right to left powered by the hips.
  stand: {
    time: 0.62, strikeAt: 0.5,
    speed: (t) => 0.5 * bell(t, 0.3, 0.6),
    keys: [
      [0.28, { rS: -1.45, rY: -1.25, rO: -0.15, rE: -1.5, rR: -1.3, rW: -0.35, twist: -0.55, hipYaw: -0.5, lean: 0.05, drop: 0.1, lS: -0.9, lE: -0.9, lO: 0.3, fzL: 0.22, fzR: -0.2 }],
      [0.52, { rS: -1.4, rY: 0.55, rO: -0.1, rE: -0.25, rR: -1.4, rW: 0.45, twist: 0.55, hipYaw: -0.1, lean: 0.2, drop: 0.13, lS: -0.1, lE: -1.4, lO: 0.45, fzL: 0.25, fzR: -0.2 }],
      [0.72, { rS: -1.15, rY: 1.0, rO: -0.1, rE: -0.7, rR: -1.3, rW: 0.5, twist: 0.7, hipYaw: 0, lean: 0.22, drop: 0.12, lS: 0.1, lE: -1.3, lO: 0.45 }],
      [1, {}],
    ],
  },
  // Walking: step in on the lead foot and chop down from overhead.
  walk: {
    time: 0.72, strikeAt: 0.5,
    speed: (t) => 2.3 * bell(t, 0.12, 0.6),
    keys: [
      [0.3, { rS: -2.6, rO: -0.45, rE: -1.7, rW: -0.5, twist: -0.4, hipYaw: -0.45, lean: -0.08, drop: 0.05, lS: -1.2, lE: -0.5, lO: 0.15, fzL: 0.05, fzR: -0.22 }],
      [0.52, { rS: -0.95, rO: 0.2, rY: 0.25, rE: -0.2, rW: 0.55, twist: 0.5, hipYaw: -0.1, lean: 0.36, drop: 0.17, lS: 0.35, lE: -0.7, lO: 0.3, fzL: 0.48, fzR: -0.38 }],
      [0.72, { rS: -0.4, rO: 0.45, rY: 0.3, rE: -0.4, rW: 0.65, twist: 0.62, hipYaw: 0, lean: 0.4, drop: 0.18, lS: 0.4, lE: -0.8, lO: 0.3, fzL: 0.45, fzR: -0.35 }],
      [1, {}],
    ],
  },
  // Running: momentum carries into a long lunge, sword arm driven straight out.
  run: {
    time: 0.85, strikeAt: 0.46,
    speed: (t, v0) => Math.max(v0, 4.5) * (1 - ease(Math.min(1, t / 0.62))),
    keys: [
      [0.17, { rS: 0.55, rO: -0.25, rE: -1.95, rW: 1.0, twist: -0.5, hipYaw: -0.3, lean: 0.3, drop: 0.1, lS: -1.4, lE: -0.25, lO: 0.15, fzL: -0.15, fzR: 0.2 }],
      [0.38, { rS: -1.9, rY: -0.7, rO: 0.05, rE: -0.05, rW: 1.35, twist: 0.6, hipYaw: 0.25, lean: 0.5, drop: 0.3, lS: 0.9, lE: -0.2, lO: 0.4, fzL: -0.55, fzR: 0.6 }],
      [0.7, { rS: -1.8, rY: -0.6, rO: 0.05, rE: -0.15, rW: 1.25, twist: 0.5, hipYaw: 0.2, lean: 0.45, drop: 0.3, lS: 0.8, lE: -0.3, lO: 0.4, fzL: -0.5, fzR: 0.55 }],
      [1, {}],
    ],
  },
};

/** Bare-handed versions of the same three attacks: quicker, shorter, thrown with the right fist. */
const PUNCHES: Record<AttackKind, Attack> = {
  // Standing: a straight right. Fist chambers by the jaw, hips and shoulders turn it out, left hand stays up.
  stand: {
    time: 0.44, strikeAt: 0.45,
    speed: (t) => 2.4 * bell(t, 0.15, 0.55), // a short step in behind it
    keys: [
      [0.22, { rS: -0.75, rO: -0.4, rE: -2.15, rW: 0, twist: -0.4, hipYaw: -0.5, lean: 0.06, drop: 0.1, lS: -0.95, lE: -1.9, lO: 0.3, fzL: 0.22, fzR: -0.2 }],
      [0.46, { rS: -1.75, rO: 0.12, rE: -0.02, rW: 0, twist: 0.8, hipYaw: 0.15, lean: 0.26, drop: 0.12, lS: -0.85, lE: -2.0, lO: 0.35, fzL: 0.32, fzR: -0.22 }],
      [0.64, { rS: -1.7, rO: 0.12, rE: -0.2, rW: 0, twist: 0.6, hipYaw: 0.05, lean: 0.2, drop: 0.12, lS: -0.85, lE: -2.0, lO: 0.35, fzL: 0.26, fzR: -0.22 }],
      [1, {}],
    ],
  },
  // Walking: step in behind a looping overhand, elbow high, arm still bent as it comes across.
  walk: {
    time: 0.56, strikeAt: 0.5,
    speed: (t) => 3.0 * bell(t, 0.1, 0.6),
    keys: [
      [0.28, { rS: -0.5, rO: -1.0, rE: -1.9, rW: 0, twist: -0.6, hipYaw: -0.5, lean: 0, drop: 0.06, lS: -1.0, lE: -1.8, lO: 0.3, fzL: 0.05, fzR: -0.22 }],
      [0.52, { rS: -1.7, rO: 0.25, rY: 0.45, rE: -0.45, rW: 0, twist: 0.75, hipYaw: 0.05, lean: 0.32, drop: 0.16, lS: -0.7, lE: -1.9, lO: 0.4, fzL: 0.46, fzR: -0.36 }],
      [0.72, { rS: -1.25, rO: 0.3, rY: 0.9, rE: -1.0, rW: 0, twist: 0.85, hipYaw: 0.1, lean: 0.36, drop: 0.17, lS: -0.6, lE: -1.8, lO: 0.4, fzL: 0.44, fzR: -0.34 }],
      [1, {}],
    ],
  },
  // Running: momentum thrown into one long diving right, left arm flung back for balance.
  run: {
    time: 0.72, strikeAt: 0.44,
    speed: (t, v0) => Math.max(v0, 4.5) * (1 - ease(Math.min(1, t / 0.62))),
    keys: [
      [0.17, { rS: -0.35, rO: -0.45, rE: -2.1, rW: 0, twist: -0.55, hipYaw: -0.3, lean: 0.3, drop: 0.1, lS: -1.3, lE: -0.6, lO: 0.15, fzL: -0.15, fzR: 0.2 }],
      [0.4, { rS: -1.62, rO: 0.1, rE: -0.05, rW: 0, twist: 0.75, hipYaw: 0.25, lean: 0.55, drop: 0.28, lS: 0.8, lE: -0.3, lO: 0.4, fzL: -0.55, fzR: 0.6 }],
      [0.68, { rS: -1.55, rO: 0.1, rE: -0.2, rW: 0, twist: 0.65, hipYaw: 0.2, lean: 0.48, drop: 0.28, lS: 0.7, lE: -0.4, lO: 0.4, fzL: -0.5, fzR: 0.55 }],
      [1, {}],
    ],
  },
};

/** At ease: feet nearly level, both arms hanging, sword carried low with its tip forward. */
const RELAXED: Pose = {
  rS: 0.04, rO: -0.1, rY: 0, rE: -0.22, rR: 0, rW: 0.42,
  lS: 0.03, lO: 0.09, lE: -0.2,
  twist: 0.03, lean: 0.02, roll: 0, drop: 0.015, hipYaw: -0.08,
  fzL: 0.07, fzR: -0.05, width: 0.02,
};
const GUARD_ENTER = 4.5, GUARD_EXIT = 5.5; // metres to the nearest enemy
const GUARD_HOLD = 1.5; // seconds the guard stays up after a swing

const _pose = { ...READY };
const _still = { ...READY };
/** Pose of an attack at t = 0..1 (holds the first key before it is reached). */
function samplePose(atk: Attack, t: number): Pose {
  const keys = atk.keys;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [t0, a] = keys[i], [t1, b] = keys[i + 1];
  const e = ease(clamp((t - t0) / (t1 - t0), 0, 1));
  for (const ch of CHANNELS) _pose[ch] = lerp(a[ch] ?? READY[ch], b[ch] ?? READY[ch], e);
  return _pose;
}

// --- fit tuning for props on the body ---
// a blade only cuts for a short stretch around each attack's strike moment (fractions of the attack)
const STRIKE_LEAD = 0.16, STRIKE_FOLLOW = 0.1;
const FIST_CURL = 1.3; // right hand gripping the sword, radians per finger joint
const GRIP = { x: 0.03, y: -0.09, z: 0.0 }; // sword grip, relative to the right wrist
