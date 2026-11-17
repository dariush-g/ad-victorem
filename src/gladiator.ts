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
const WALK = 1.5, RUN = 5.0, GRAVITY = 16; // gait reference speeds (the stride blends from a walk toward a run between them)
const TRAVEL = 2.4; // walking top speed, m/s
const JOG = 3.9; // top speed with Shift held, m/s
// stepping sideways: stride length (share of a forward one) and how far apart the feet part (share of
// the stride). Cadence follows speed / stride, so these set how hurried it looks.
const SIDE_STRIDE = 0.85, SIDE_SPREAD = 0.75;
const ACCEL = 16, DECEL = 20, AIR_ACCEL = 3, TURN = 9;
const BACKPEDAL = 0.62; // backward walking speed, as a fraction of WALK
const SETTLE_RATE = 7; // radians of gait phase per second while finishing the last step on stopping
// --- ragdoll ---
const RAG_MIN_TIME = 1.2, RAG_MAX_TIME = 6, GETUP_TIME = 0.9;

export type Ground = (x: number, z: number) => number;

export interface Controls {
  moveX: number; // world-space desired direction (unit or zero)
  moveZ: number;
  /** Shift: jog, faster than the walk, facing where you go. */
  free?: boolean;
  attack: boolean; // attack pressed this frame (buffered inside, so an early press still counts)
  attackHeld?: boolean; // attack button still down: a held press becomes a heavy blow, and charges it
  dodge?: boolean; // dodge pressed this frame
  parry?: boolean; // parry pressed this frame
  block?: boolean; // guard held up
  canAct?: boolean; // has the stamina to start an attack, dodge or parry (default true)
  /** Where the opponent stands, for the swing to turn toward (soft aim assist). */
  target?: THREE.Vector3 | null;
  backpedal: boolean; // walking backward: keep facing the aim direction instead of turning round
  ragdoll: boolean; // toggle: go limp / get up
  aimYaw: number; // facing angle to snap to when attacking
  aim: number; // how high to swing: -1 low (legs) .. 0 chest .. 1 high (head, neck); fixed when the swing starts
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
  tx: number; // sideways (left +), for side-steps
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
  /** The timed action in progress (attack, dodge, parry, stagger...), or null when free. */
  private move: Move | null = null;
  private moveKind: MoveKind = 'l1';
  private moveT = 0; // seconds into the move
  private attackV0 = 0; // ground speed when the move began
  private attackAim = 0; // -1..1, how high this swing was aimed
  private moveDir = 0; // world yaw a dodge travels along
  private chargeT = 0; // seconds a heavy blow has been held at the top of its windup
  private charging = false; // a heavy is waiting at the top for the button to be let go
  private chargeLocal = false; // this heavy came from our own held press (else a remote replay, released by message)
  private chained = false; // the current move cut in on another one
  /** The current roll: forward over the shoulder, backward over it, or sideways across the back (-1 right, 1 left). */
  private rollKind: 'fwd' | 'back' | 'side' = 'fwd';
  private rollSide = 1;
  private latTarget = 0; // last clear reading of sideways travel, -1 right .. 1 left
  private chainFrom: Pose = { ...READY }; // pose at that moment
  private pressT = -1; // seconds since the attack press that started the current swing (-1: not from a press)
  /** Presses waiting for the fighter to be free: seconds left before each is forgotten. */
  private buffer = { attack: 0, dodge: 0, parry: 0 };
  private blockW = 0; // eased 0..1 weight of the guard pose
  private blockHeld = false;
  /** Moves started since the owner last looked (main.ts spends stamina and tells the opponent). */
  readonly started: MoveKind[] = [];
  /** A heavy blow was released after charging (to tell the opponent). */
  released = false;
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
      return { upper, lower, foot, side, tz: 0, ty: -(a.distanceTo(b) + b.distanceTo(c)), tx: 0 };
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
    return this.move !== null && isAttack(this.moveKind);
  }
  /** Which move is in progress (or was last made). */
  get currentMove(): MoveKind {
    return this.moveKind;
  }
  /** Busy with any timed move (attack, dodge, parry, stagger). */
  get busy() {
    return this.move !== null;
  }
  /** Inside a dodge's invulnerable stretch: blows pass through. */
  get invulnerable() {
    return this.inWindow(this.move?.iframes);
  }
  /** Inside a parry's deflecting stretch. */
  get parrying() {
    return this.inWindow(this.move?.parry);
  }
  /** Guard up and set (not mid-move). */
  get blocking() {
    return this.move === null && this.blockHeld && this.blockW > 0.45 && !this.rag;
  }
  /** Reeling after a parry or a broken guard: open to a riposte. */
  get exposed() {
    return this.move !== null && (this.moveKind === 'parried' || this.moveKind === 'guardbreak');
  }
  /** How far a heavy blow has been charged, 0..1 (0 for anything else). */
  get charge() {
    return this.moveKind === 'heavy' ? clamp(this.chargeT / HEAVY_CHARGE, 0, 1) : 0;
  }
  private inWindow(w?: [number, number]) {
    if (!w || !this.move || this.rag) return false;
    return this.moveT >= w[0] && this.moveT <= w[1];
  }
  /** Something in hand: bare-fisted fighters can only punch (no block, no parry). */
  get armed() {
    return !!this.worn.weapon;
  }
  /** The attacks on offer: sword swings with a weapon in hand, punches without. */
  private get moves() {
    return this.armed ? ATTACKS : PUNCHES;
  }
  private moveDef(kind: MoveKind): Move {
    return isAttack(kind) ? this.moves[kind] : REACTIONS[kind];
  }
  /** Fall limp on the spot and stay down (death). */
  collapse() {
    this.stayDown = true;
    if (!this.rag) this.startRagdoll();
  }
  /** Begin a move now. `dir` is the world yaw a dodge travels along. */
  private begin(kind: MoveKind, facing: number, aim = 0, dir = facing) {
    // cut straight from one move into the next (a combo, a dodge out of a swing): start the new one from
    // the pose the body is in now, at full weight, instead of fading back toward the stance first
    this.chained = this.move !== null;
    if (this.chained) for (const ch of CHANNELS) this.chainFrom[ch] = this.smoothed[ch] ?? (this.armed ? READY : READY_BARE)[ch];
    this.move = this.moveDef(kind);
    this.moveKind = kind;
    this.moveT = 0;
    this.chargeT = 0;
    this.charging = kind === 'heavy';
    this.attackAim = clamp(aim, -1, 1);
    this.attackV0 = Math.hypot(this.vel.x, this.vel.z);
    this.facing = facing;
    this.moveDir = dir;
    if (kind === 'dodge') {
      // which roll depends on where it goes relative to the facing: roughly ahead, a forward roll (turning
      // square to its line); roughly behind, a backward roll; otherwise a side roll. Back and side rolls keep
      // the facing, so you never turn your back on the enemy to get away
      const d = dir - facing, ahead = Math.cos(d);
      this.rollKind = ahead > ROLL_CONE ? 'fwd' : ahead < -ROLL_CONE ? 'back' : 'side';
      this.rollSide = Math.sin(d) > 0 ? 1 : -1;
      if (this.rollKind === 'fwd') this.facing = this.root.rotation.y = dir;
      if (this.rollKind === 'side') this.move = SIDE_ROLL;
    }
    this.chargeLocal = false;
    if (isAttack(kind)) this.swing++;
    this.started.push(kind);
  }
  /** Where a swing should face: the opponent, if they stand close and roughly where you're looking; otherwise your aim. */
  /**
   * Start a given move now, whatever the controls say: replaying a remote fighter, or a reaction
   * to being struck (stagger, recoil off a guard, reeling from a parry).
   */
  forceMove(kind: MoveKind, facing = this.facing, aim = 0, dir = facing) {
    if (this.rag) return;
    this.begin(kind, facing, aim, dir);
    this.pressT = -1;
  }
  /** World yaw the current (or last) dodge travels along. */
  get dodgeDir() {
    return this.moveDir;
  }
  /** A remote fighter let go of a charging heavy blow. */
  releaseCharge() {
    this.charging = false;
  }
  /** Stand somewhere else, on your feet and at rest: drops any ragdoll, swing or momentum. */
  place(pos: THREE.Vector3, facing: number) {
    this.rag = null;
    this.stayDown = false;
    this.blendT = GETUP_TIME;
    this.move = null;
    this.buffer.attack = this.buffer.dodge = this.buffer.parry = 0;
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
    if (!this.attacking || this.rag || this.charging) return false;
    const t = this.moveT / this.move!.time, at = this.move!.strikeAt;
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

  /** Middle of the skull in world space, as currently drawn. */
  headPosition(out = new THREE.Vector3()) {
    return this.headCenter.getWorldPosition(out);
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
    this.guardHold = this.move || this.blockHeld ? GUARD_HOLD : Math.max(0, this.guardHold - dt);
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
      const curl = f.right && this.armed ? FIST_CURL * f.weight : this.curlL * f.relaxed;
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

    // --- input buffer: a press made a little early (mid-swing, mid-dodge) is kept until it can happen ---
    const b = this.buffer;
    b.attack = c.attack ? BUFFER : Math.max(0, b.attack - dt);
    b.dodge = c.dodge ? BUFFER : Math.max(0, b.dodge - dt);
    b.parry = c.parry && this.armed ? BUFFER : Math.max(0, b.parry - dt);
    if (c.attack) this.pressT = 0;
    else if (this.pressT >= 0) this.pressT += dt;
    if (!c.attackHeld) this.pressT = -1; // let go: no heavy from this press
    this.blockHeld = !!c.block && this.armed;

    // --- starting moves: free, or in the recovery of a move that allows cancelling into this one ---
    const able = !gettingUp && grounded && c.canAct !== false;
    const mt = this.move ? this.moveT / this.move.time : 1;
    const recovered = !this.move || (this.move.cancel !== undefined && mt >= this.move.cancel);
    const aimYaw = c.aimYaw; // no lock-on: moves go where you aim
    if (able && b.dodge > 0 && recovered) {
      b.dodge = b.attack = 0;
      // dodge where you're steering; with no direction held, hop straight back
      const face = c.aimYaw;
      const dir = c.moveX !== 0 || c.moveZ !== 0 ? Math.atan2(c.moveX, c.moveZ) : face + Math.PI;
      this.begin('dodge', face, 0, dir);
    } else if (able && b.parry > 0 && recovered && this.armed) {
      b.parry = b.attack = 0;
      this.begin('parry', aimYaw);
    } else if (able && b.attack > 0 && recovered) {
      b.attack = 0;
      // chain lights into a combo
      const k = this.moveKind;
      const next: MoveKind = this.move && isAttack(k) && k !== 'heavy' ? (k === 'l1' ? 'l2' : k === 'l2' ? 'l3' : 'l1') : 'l1';
      this.begin(next, aimYaw, c.aim);
    }
    // a press still held before the blow lands turns the first light into a heavy
    if (this.move && this.pressT >= HOLD_HEAVY && c.attackHeld && (this.moveKind === 'l1' || this.moveKind === 'l2' || this.moveKind === 'l3')) {
      const t = this.moveT / this.move.time;
      if (t < this.move.strikeAt - STRIKE_LEAD) {
        this.begin('heavy', aimYaw, c.aim);
        this.chargeLocal = true;
        this.moveT = this.move!.time * 0.1; // the windup already under way carries over
      }
    }
    if (this.move) {
      const m = this.move;
      // a heavy waits at the top of its windup while the button stays down (local) or until told (remote)
      if (this.chargeLocal && this.charging && !c.attackHeld) {
        this.charging = false;
        this.released = true;
      }
      const atTop = this.moveKind === 'heavy' && this.moveT / m.time >= (m.chargeAt ?? 1);
      if (atTop && this.charging && this.chargeT < HEAVY_CHARGE) this.chargeT += dt;
      else {
        if (atTop && this.charging) {
          this.charging = false; // fully charged: it goes on its own
          if (this.chargeLocal) this.released = true;
        }
        this.moveT += dt;
      }
      if (this.moveT >= m.time) this.move = null;
    }


    // --- movement ---
    const moving = !gettingUp && !this.move && (c.moveX !== 0 || c.moveZ !== 0);
    if (this.move) {
      // committed: no steering, the move itself carries you (a dodge along its own line, the rest along your facing)
      const sp = this.move.speed(this.moveT / this.move.time, this.attackV0);
      const yaw = this.moveKind === 'dodge' ? this.moveDir : this.facing;
      this.vel.x = Math.sin(yaw) * sp;
      this.vel.z = Math.cos(yaw) * sp;
    } else {
      // finite acceleration, so starts, stops and turns carry weight; the guard slows you to a shuffle, Shift jogs
      const top =
        (this.blockHeld ? WALK * BLOCK_SPEED : c.free ? JOG : c.backpedal ? WALK * BACKPEDAL : TRAVEL) * this.speedMul;
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
    this.vel.y -= GRAVITY * dt;
    const fallSpeed = -this.vel.y;
    this.pos.addScaledVector(this.vel, dt);

    // Land, or stay glued to the sand when walking downhill.
    const gap = this.pos.y - groundY;
    if (gap <= 0 || (grounded && gap < 0.4)) {
      if (!grounded) this.squat = Math.min(0.28, fallSpeed * 0.035); // absorb the landing
      this.pos.y = groundY;
      this.vel.y = 0;
      grounded = true;
    } else grounded = false;
    this.onGround = grounded;
    this.squat *= Math.exp(-7 * dt);

    // --- facing: the way you travel, or held on your aim while backing up or with the guard up ---
    // (no lock-on: an enemy nearby never turns you)
    if (!this.move && !gettingUp) {
      if (moving) this.facing = (c.backpedal || this.blockHeld) && !c.free ? c.aimYaw : Math.atan2(c.moveX, c.moveZ);
      else if (this.blockHeld) this.facing = c.aimYaw;
    }
    let diff = this.facing - this.root.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.root.rotation.y += clamp(diff * (1 - Math.exp(-11 * dt)), -TURN * dt, TURN * dt);
    this.root.position.copy(this.pos);

    this.blockW += ((this.blockHeld && !this.move ? 1 : 0) - this.blockW) * (1 - Math.exp(-BLOCK_RATE * dt));
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
    // stepping sideways (squared up to an enemy): the stride turns to run along the line of travel
    if (v > 0.3) this.latTarget = (this.vel.x * cy - this.vel.z * sy) / v;
    const lat = this.ease('lat', this.latTarget, 8, dt);
    const ux = lat * dirSign, uz = Math.sqrt(Math.max(0, 1 - lat * lat)); // stride direction, body frame (left +, forward +)

    // character-local acceleration drives lean
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const ax = (this.vel.x - this.prevVel.x) * inv, az = (this.vel.z - this.prevVel.z) * inv;
    this.prevVel.copy(this.vel);
    const s = 1 - Math.exp(-8 * dt);
    this.accF += (ax * sy + az * cy - this.accF) * s;
    this.accL += (ax * cy - az * sy - this.accL) * s;

    // attack overlay weight: fades in fast, out slower
    const atk = this.move;
    const at = atk ? this.moveT / atk.time : 0;
    const w = atk ? Math.min(this.chained ? 1 : ease(Math.min(1, at / 0.14)), ease(Math.min(1, (1 - at) / 0.26))) : 0;
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
    const A = Math.min(lerp(0.33, 0.4, run) * lerp(1, 0.7, back) * lerp(1, SIDE_STRIDE, Math.abs(lat)), Math.sqrt(Math.max(0.0025, reach * reach - hipH * hipH)));
    this.phase += (dirSign * dt * v * TAU * D) / (2 * A);
    // Coming to a halt: finish the step so the feet arrive side by side (phase π/2 + kπ, where both
    // stride offsets are zero) instead of being dragged together across the sand.
    if (v < 0.5 && amt > 0.02 && !this.move) {
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
    const armed = this.armed;
    const rest = armed ? RELAXED : RELAXED_BARE, ready = armed ? READY : READY_BARE;
    for (const ch of CHANNELS) _still[ch] = lerp(rest[ch], ready[ch], guard);
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
      // (bare-handed: the right arm mirrors the left, opposite in the stride, and the wrist stays straight)
      rS: armed
        ? lerp(R.rS, -0.12 + cph * swing * 0.6, amt) + (breath * 0.025 + swordBob * 0.045) * idle
        : lerp(R.rS, cph * swing + 0.04, amt) + (breath * 0.025 + swordBob * 0.04) * idle,
      rO: armed
        ? lerp(R.rO, -0.28, amt) + Math.sin(t * 0.9 + 1.2) * 0.03 * idle
        : lerp(R.rO, -(0.13 + 0.06 * run - pos(-cph) * 0.05), amt) + Math.sin(t * 0.9 + 1.2) * 0.03 * idle,
      rY: lerp(R.rY, 0, amt),
      rE: armed
        ? lerp(R.rE, -0.7 - run * 0.5 - pos(-lagE) * 0.3, amt) + Math.sin(t * 1.3 + 1.3) * 0.07 * live * idle
        : lerp(R.rE, -(0.42 + run) - pos(-lagE) * 0.4, amt) + Math.sin(t * 1.3 + 1.3) * 0.08 * live * idle,
      rR: 0,
      rW: armed
        ? lerp(R.rW, 0.08 + lagW * 0.12, amt) + Math.sin(t * 1.7 + 0.2) * 0.09 * live * idle // sword tip circles
        : lerp(R.rW, 0, amt),
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
      const a = samplePose(atk, at, this.chained ? this.chainFrom : null, ready);
      // aim: the whole swing tilts up or down at the shoulder; a low swing also bends at the waist and
      // knees to get under the guard, a high one comes more upright
      const aim = isAttack(this.moveKind) ? this.attackAim : 0;
      a.rS -= aim * AIM_ARM;
      a.lean -= aim * AIM_LEAN;
      a.drop += Math.max(0, -aim) * AIM_CROUCH;
      for (const ch of CHANNELS) pose[ch] = lerp(pose[ch], a[ch], w);
    }
    // guard up: blade held across the body, free arm raised; strafing legs still come from the gait
    if (this.blockW > 0.01) {
      const k = this.blockW * (1 - w);
      for (const ch of GUARD_CHANNELS) pose[ch] = lerp(pose[ch], BLOCK[ch], k);
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
      const fz = stride * A * gait * uz + stance;
      // side-steps: the feet also part, so the trailing one never has to cross over the leading one
      const fx = stride * A * gait * ux + leg.side * SIDE_SPREAD * A * gait * Math.abs(ux);
      // striding feet land close to the centre line, not out at the hips (but a side-step keeps them apart)
      const lx = leg.side * (this.hipX + 0.012 + pose.width - 0.04 * gait * uz) + fx;
      const gy = clamp(this.ground(this.pos.x + lx * cy + fz * sy, this.pos.z - lx * sy + fz * cy) - this.pos.y, -0.3, 0.3);
      // a foot being repositioned (stance change, lunge, step-in) lifts instead of dragging
      const stepLift = Math.min(0.1, Math.abs(stance - this.prevStance[i]) * inv * 0.035);
      this.prevStance[i] = stance;
      const comp = inAir ? 0 : Math.sin(Math.PI * n); // how deep into its stance (weight on it)
      return { fz, fx, gy, lift: (sp > 0 ? sp * sp * liftH * 1.15 * gait : 0) + stepLift, phi, comp }; // sin²: soft takeoff and landing
    };
    const L = plan(legL, ph, pose.fzL, 0), Rr = plan(legR, ph + Math.PI, pose.fzR, 1);

    const bob = lerp(-Math.cos(2 * ph) * 0.03, 0.015 - (L.comp + Rr.comp) * 0.05, run) * gait;
    const pelvisY = this.pelvisY - pose.drop + bob + (grounded ? Math.min(0, L.gy, Rr.gy) * 0.8 : 0);
    // weight shifts over the planted foot; idle: slow sway
    hips.position.set(-sph * 0.014 * gait + shift * 0.016 * idle, pelvisY, this.pelvisZ);
    hips.rotation.set(0, pose.hipYaw, -sph * 0.04 * gait);
    // Roll (after real shoulder rolls: lead shoulder dropped to the sand, contact running diagonally across
    // the back from that shoulder to the opposite hip, up onto one knee, then stand). While tucked, the body
    // turns about its middle, whose height follows the roll's shape: dropping onto the shoulder, lowest across
    // the back, rising onto the knee. The kneel and the rise are ordinary poses on planted feet.
    const rolling = atk !== null && this.moveKind === 'dodge';
    const tuck = !rolling ? 0 : at < ROLL_TUCK[0] ? ease(at / ROLL_TUCK[0]) : at > ROLL_TUCK[1] ? 1 - ease(clamp((at - ROLL_TUCK[1]) / (ROLL_TUCK[2] - ROLL_TUCK[1]), 0, 1)) : 1;
    if (tuck > 0) {
      const turn = Math.PI * 2 * ease(clamp((at - ROLL_SPIN[0]) / (ROLL_SPIN[1] - ROLL_SPIN[0]), 0, 1));
      // forward/back: about the hips' left-right line, swung round so the roll runs from the left shoulder to
      // the right hip; sideways: about the line the body faces, head first toward the side it rolls to
      if (this.rollKind === 'side') _x.set(0, 0, 1);
      else _x.set(Math.cos(ROLL_SHOULDER), 0, -Math.sin(ROLL_SHOULDER));
      const spin = this.rollKind === 'back' ? -turn : this.rollKind === 'side' ? -this.rollSide * turn : turn;
      _q.setFromAxisAngle(_x, spin);
      const standing = hips.position.y + ROLL_CENTRE;
      _a.set(hips.position.x, lerp(standing, rollHeight(at), tuck), hips.position.z); // the middle of the body
      hips.position.copy(_a).add(_b.set(0, -ROLL_CENTRE, 0).applyQuaternion(_q));
      hips.quaternion.premultiply(_q);
    }

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
    const place = (leg: Leg, t: { fz: number; fx: number; gy: number; lift: number; phi: number }, airZ: number, airY: number) => {
      _a.copy(leg.upper.position).applyQuaternion(hips.quaternion).sub(leg.upper.position);
      // (rolling: knees drawn up to the chest instead of reaching for the sand)
      // (rolling: each leg follows its own path through the roll instead of reaching for the sand)
      if (tuck > 0) rollLeg(this.rollKind === 'side' ? SIDE_ROLL_LEGS : ROLL_LEGS, at, leg.side, _y);
      const tz = lerp(grounded ? t.fz - _a.z * gait : airZ, _y.x, tuck);
      const ty = lerp(grounded ? t.gy + this.ankle + t.lift - hipY - _a.y * gait : airY, _y.y, tuck);
      leg.tz += (tz - leg.tz) * k;
      leg.ty += (ty - leg.ty) * k;
      leg.tx += (lerp(grounded ? t.fx - _a.x * gait : 0, 0, tuck) - leg.tx) * k;
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
      // the head normally stays level over a leaning body; curled in a roll, the chin tucks to the chest instead
      -pose.lean * 0.55 * (1 - tuck) + tuck * CHIN_TUCK + (Math.sin(t * 0.61 + 0.5) * 0.05 + breath * 0.015) * look,
      -(pose.twist + pose.hipYaw) * 0.8 + (Math.sin(t * 0.43) * 0.2 + Math.sin(t * 1.07 + 1.3) * 0.07) * look,
      -pose.roll * 0.6 + Math.sin(t * 0.37 + 2.0) * 0.04 * look,
    );
  }

  /** Two-bone IK in the leg's sagittal plane: put the ankle at (tz, ty) from the hip. */
  private solveLeg(leg: Leg, toePitch: number, yaw = 0, roll = 0) {
    const T = this.thigh, S = this.shin;
    // a sideways target swings the whole leg out at the hip; the knee then works in that tilted plane
    const abduct = Math.atan2(leg.tx, -leg.ty), ty = -Math.hypot(leg.ty, leg.tx);
    const full = T + S, soft = 0.95 * full, raw = Math.hypot(leg.tz, ty);
    // approach full extension asymptotically: the knee never snaps straight (that pop reads as jerky)
    const d = Math.max(0.25, raw <= soft ? raw : soft + (full - soft) * 0.985 * (1 - Math.exp(-(raw - soft) / (full - soft))));
    const toTarget = Math.atan2(-leg.tz, -ty);
    const hipIn = Math.acos(clamp((T * T + d * d - S * S) / (2 * T * d), -1, 1));
    const kneeIn = Math.acos(clamp((T * T + S * S - d * d) / (2 * T * S), -1, 1));
    const hipRot = toTarget - hipIn; // knee forward
    const kneeRot = Math.PI - kneeIn;
    leg.upper.rotation.set(hipRot, yaw, roll + abduct);
    leg.lower.rotation.set(kneeRot, 0, 0);
    leg.foot.rotation.set(-(hipRot + kneeRot) + toePitch, 0, -abduct); // sole stays flat
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
    this.move = null;
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

    const wants = c.ragdoll || c.dodge || c.moveX !== 0 || c.moveZ !== 0;
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

interface Move {
  time: number; // seconds
  strikeAt: number; // fraction of `time` when the blow lands (attacks only)
  /** Forward speed during the move; t = 0..1, v0 = ground speed when it began. */
  speed: (t: number, v0: number) => number;
  /** [fraction of time, pose]; channels left out fall back to READY. */
  keys: [number, Partial<Pose>][];
  /** Fraction of `time` from which another move can start (the recovery can be cancelled). Unset: must play out. */
  cancel?: number;
  /** A heavy blow pauses here (fraction of time) while it charges. */
  chargeAt?: number;
  /** Seconds into the move during which blows pass through (dodge). */
  iframes?: [number, number];
  /** Seconds into the move during which a blow from the front is deflected (parry). */
  parry?: [number, number];
}

const bell = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));
// cancelling: a swing's recovery opens just after the blade has passed
const AFTER = (strikeAt: number) => strikeAt + 0.14;

/** Light combo (l1 → l2 → l3 → l1...) and a held, charged heavy. */
export type AttackKind = 'l1' | 'l2' | 'l3' | 'heavy';
/** Everything else a fighter can be busy doing: defence, and reeling from a blow. */
export type ReactionKind = 'dodge' | 'parry' | 'stagger' | 'recoil' | 'parried' | 'guardbreak';
export type MoveKind = AttackKind | ReactionKind;
const ATTACK_KINDS: readonly MoveKind[] = ['l1', 'l2', 'l3', 'heavy'];
export const MOVE_KINDS: readonly MoveKind[] = [...ATTACK_KINDS, 'dodge', 'parry', 'stagger', 'recoil', 'parried', 'guardbreak'];
export const isAttack = (k: MoveKind): k is AttackKind => ATTACK_KINDS.includes(k);

/**
 * Per move: stamina cost to start it, damage multiplier, and how much poise it breaks on the victim.
 * A heavy's cost is on top of the light it grew out of.
 */
export const MOVE_INFO: Record<MoveKind, { cost: number; dmg: number; poise: number }> = {
  l1: { cost: 13, dmg: 1, poise: 12 },
  l2: { cost: 13, dmg: 1, poise: 12 },
  l3: { cost: 16, dmg: 1.25, poise: 18 },
  heavy: { cost: 14, dmg: 1.7, poise: 34 }, // fully charged: see HEAVY_CHARGE_BONUS
  dodge: { cost: 17, dmg: 0, poise: 0 },
  parry: { cost: 10, dmg: 0, poise: 0 },
  stagger: { cost: 0, dmg: 0, poise: 0 },
  recoil: { cost: 0, dmg: 0, poise: 0 },
  parried: { cost: 0, dmg: 0, poise: 0 },
  guardbreak: { cost: 0, dmg: 0, poise: 0 },
};
/** A fully charged heavy hits this much harder (scaled by how long it was held). */
export const HEAVY_CHARGE_BONUS = 0.6;

const ATTACKS: Record<AttackKind, Move> = {
  // 1st light: feet planted, flat cut from right to left powered by the hips.
  l1: {
    time: 0.62, strikeAt: 0.5, cancel: AFTER(0.5),
    speed: (t) => 1.6 * bell(t, 0.2, 0.6),
    keys: [
      [0.28, { rS: -1.45, rY: -1.25, rO: -0.15, rE: -1.5, rR: -1.3, rW: -0.35, twist: -0.55, hipYaw: -0.5, lean: 0.05, drop: 0.1, lS: -0.9, lE: -0.9, lO: 0.3, fzL: 0.22, fzR: -0.2 }],
      [0.52, { rS: -1.4, rY: 0.55, rO: -0.1, rE: -0.25, rR: -1.4, rW: 0.45, twist: 0.55, hipYaw: -0.1, lean: 0.2, drop: 0.13, lS: -0.1, lE: -1.4, lO: 0.45, fzL: 0.25, fzR: -0.2 }],
      [0.72, { rS: -1.15, rY: 1.0, rO: -0.1, rE: -0.7, rR: -1.3, rW: 0.5, twist: 0.7, hipYaw: 0, lean: 0.22, drop: 0.12, lS: 0.1, lE: -1.3, lO: 0.45 }],
      [1, {}],
    ],
  },
  // 2nd light: the blade comes back the other way, a backhand cut from left to right.
  l2: {
    time: 0.6, strikeAt: 0.48, cancel: AFTER(0.48),
    speed: (t) => 1.6 * bell(t, 0.15, 0.55),
    keys: [
      // (solved so the blade leads the hand the whole way, on one forearm roll, with no twist of the wrist mid-swing)
      // cock: hand up by the left shoulder, blade raised up and to the left
      [0.24, { rS: -0.97, rY: 1.37, rO: -1.2, rE: -1.33, rR: -1.17, rW: 1.4, twist: 0.7, hipYaw: 0.05, lean: 0.08, drop: 0.11, lS: 0.05, lE: -1.3, lO: 0.4, fzL: 0.22, fzR: -0.2 }],
      // contact: arm straight out in front, tip forward at chest height, sweeping to the right
      [0.5, { rS: -1.66, rY: 0.52, rO: -0.07, rE: 0, rR: -1.17, rW: 0.99, twist: -0.1, hipYaw: -0.25, lean: 0.2, drop: 0.13, lS: -0.8, lE: -1.0, lO: 0.3, fzL: 0.26, fzR: -0.2 }],
      // follow-through: blade carried on out to the right
      [0.72, { rS: -1.63, rY: 0.13, rO: 0.06, rE: -0.01, rR: -1.15, rW: 1.17, twist: -0.5, hipYaw: -0.45, lean: 0.18, drop: 0.12, lS: -0.9, lE: -0.9, lO: 0.3 }],
      [1, {}],
    ],
  },
  // 3rd light: step in on the lead foot and chop down from overhead, arm reaching out so the blade travels a wide arc.
  l3: {
    time: 0.72, strikeAt: 0.5, cancel: AFTER(0.5),
    speed: (t) => 2.8 * bell(t, 0.12, 0.6),
    keys: [
      [0.3, { rS: -2.6, rO: -0.45, rE: -1.1, rW: -0.1, twist: -0.4, hipYaw: -0.45, lean: -0.08, drop: 0.05, lS: -1.2, lE: -0.5, lO: 0.15, fzL: 0.05, fzR: -0.22 }],
      [0.52, { rS: -1.35, rO: 0.05, rY: 0.1, rE: -0.02, rW: 1.05, twist: 0.5, hipYaw: -0.1, lean: 0.36, drop: 0.17, lS: 0.35, lE: -0.7, lO: 0.3, fzL: 0.48, fzR: -0.38 }],
      [0.72, { rS: -0.75, rO: 0.25, rY: 0.2, rE: -0.1, rW: 1.0, twist: 0.62, hipYaw: 0, lean: 0.4, drop: 0.18, lS: 0.4, lE: -0.8, lO: 0.3, fzL: 0.45, fzR: -0.35 }],
      [1, {}],
    ],
  },
  // Heavy: sword raised high behind the head (held there while charging), then a full-body chop.
  heavy: {
    time: 1.15, strikeAt: 0.58, chargeAt: 0.34, cancel: AFTER(0.62),
    speed: (t) => 3.2 * bell(t, 0.4, 0.68),
    keys: [
      [0.34, { rS: -2.9, rO: -0.5, rE: -1.25, rW: -0.25, twist: -0.6, hipYaw: -0.55, lean: -0.14, drop: 0.12, lS: -1.0, lE: -0.6, lO: 0.2, fzL: 0.1, fzR: -0.3 }],
      [0.6, { rS: -1.2, rO: 0.05, rY: 0.1, rE: -0.02, rW: 1.1, twist: 0.6, hipYaw: -0.05, lean: 0.48, drop: 0.24, lS: 0.4, lE: -0.7, lO: 0.3, fzL: 0.55, fzR: -0.42 }],
      [0.8, { rS: -0.6, rO: 0.25, rY: 0.2, rE: -0.1, rW: 1.0, twist: 0.65, hipYaw: 0, lean: 0.45, drop: 0.24, lS: 0.4, lE: -0.8, lO: 0.3, fzL: 0.5, fzR: -0.4 }],
      [1, {}],
    ],
  },
};

/** Bare-handed versions of the same attacks: quicker, shorter, thrown with the right fist. */
const PUNCHES: Record<AttackKind, Move> = {
  // straight right. Fist chambers by the jaw, hips and shoulders turn it out, left hand stays up.
  l1: {
    time: 0.44, strikeAt: 0.45, cancel: AFTER(0.45),
    speed: (t) => 2.4 * bell(t, 0.15, 0.55), // a short step in behind it
    keys: [
      [0.22, { rS: -0.75, rO: -0.4, rE: -2.15, rW: 0, twist: -0.4, hipYaw: -0.5, lean: 0.06, drop: 0.1, lS: -0.95, lE: -1.9, lO: 0.3, fzL: 0.22, fzR: -0.2 }],
      [0.46, { rS: -1.75, rO: 0.12, rE: -0.02, rW: 0, twist: 0.8, hipYaw: 0.15, lean: 0.26, drop: 0.12, lS: -0.85, lE: -2.0, lO: 0.35, fzL: 0.32, fzR: -0.22 }],
      [0.64, { rS: -1.7, rO: 0.12, rE: -0.2, rW: 0, twist: 0.6, hipYaw: 0.05, lean: 0.2, drop: 0.12, lS: -0.85, lE: -2.0, lO: 0.35, fzL: 0.26, fzR: -0.22 }],
      [1, {}],
    ],
  },
  // step in behind a looping overhand, elbow high, arm still bent as it comes across.
  l2: {
    time: 0.56, strikeAt: 0.5, cancel: AFTER(0.5),
    speed: (t) => 3.0 * bell(t, 0.1, 0.6),
    keys: [
      [0.28, { rS: -0.5, rO: -1.0, rE: -1.9, rW: 0, twist: -0.6, hipYaw: -0.5, lean: 0, drop: 0.06, lS: -1.0, lE: -1.8, lO: 0.3, fzL: 0.05, fzR: -0.22 }],
      [0.52, { rS: -1.7, rO: 0.25, rY: 0.45, rE: -0.45, rW: 0, twist: 0.75, hipYaw: 0.05, lean: 0.32, drop: 0.16, lS: -0.7, lE: -1.9, lO: 0.4, fzL: 0.46, fzR: -0.36 }],
      [0.72, { rS: -1.25, rO: 0.3, rY: 0.9, rE: -1.0, rW: 0, twist: 0.85, hipYaw: 0.1, lean: 0.36, drop: 0.17, lS: -0.6, lE: -1.8, lO: 0.4, fzL: 0.44, fzR: -0.34 }],
      [1, {}],
    ],
  },
  // another straight right to finish the string.
  l3: {
    time: 0.48, strikeAt: 0.45, cancel: AFTER(0.45),
    speed: (t) => 2.8 * bell(t, 0.15, 0.55),
    keys: [
      [0.22, { rS: -0.75, rO: -0.4, rE: -2.15, rW: 0, twist: -0.4, hipYaw: -0.5, lean: 0.06, drop: 0.1, lS: -0.95, lE: -1.9, lO: 0.3, fzL: 0.22, fzR: -0.2 }],
      [0.46, { rS: -1.75, rO: 0.12, rE: -0.02, rW: 0, twist: 0.8, hipYaw: 0.15, lean: 0.26, drop: 0.12, lS: -0.85, lE: -2.0, lO: 0.35, fzL: 0.32, fzR: -0.22 }],
      [0.64, { rS: -1.7, rO: 0.12, rE: -0.2, rW: 0, twist: 0.6, hipYaw: 0.05, lean: 0.2, drop: 0.12, lS: -0.85, lE: -2.0, lO: 0.35, fzL: 0.26, fzR: -0.22 }],
      [1, {}],
    ],
  },
  // the diving right, thrown from a standstill after a wind-up.
  heavy: {
    time: 0.9, strikeAt: 0.5, chargeAt: 0.17, cancel: AFTER(0.55),
    speed: (t) => 3.6 * bell(t, 0.25, 0.62),
    keys: [
      [0.17, { rS: -0.35, rO: -0.45, rE: -2.1, rW: 0, twist: -0.55, hipYaw: -0.3, lean: 0.3, drop: 0.1, lS: -1.3, lE: -0.6, lO: 0.15, fzL: -0.15, fzR: 0.2 }],
      [0.4, { rS: -1.62, rO: 0.1, rE: -0.05, rW: 0, twist: 0.75, hipYaw: 0.25, lean: 0.55, drop: 0.28, lS: 0.8, lE: -0.3, lO: 0.4, fzL: -0.55, fzR: 0.6 }],
      [0.68, { rS: -1.55, rO: 0.1, rE: -0.2, rW: 0, twist: 0.65, hipYaw: 0.2, lean: 0.48, drop: 0.28, lS: 0.7, lE: -0.4, lO: 0.4, fzL: -0.5, fzR: 0.55 }],
      [1, {}],
    ],
  },
};

/** Defence and reactions, the same with or without a weapon. Times in seconds. */
const ROLL_SPEED = 4.6; // peak, m/s: front-loaded, about a metre and a half covered
// Roll timeline, as fractions of it. ROLL_TUCK: curled up by [0], uncurling from [1], onto the knee by [2].
// ROLL_SPIN: the turn over, start and end (it starts gently, so the dive's lean flows into it).
const ROLL_TUCK = [0.14, 0.5, 0.68], ROLL_SPIN = [0.04, 0.6];
/** Height (m) of the body's middle through the tucked part: onto the shoulder, across the back, up toward the knee. */
const ROLL_PATH: [number, number][] = [[0.14, 0.5], [0.34, 0.32], [0.52, 0.42], [0.68, 0.68]];
function rollHeight(t: number) {
  const P = ROLL_PATH;
  if (t <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) if (t <= P[i][0]) return lerp(P[i - 1][1], P[i][1], ease((t - P[i - 1][0]) / (P[i][0] - P[i - 1][0])));
  return P[P.length - 1][1];
}
// pivot this far above the pelvis (m); ROLL_SHOULDER tilts a forward or back roll a touch toward the left
// shoulder (rad: kept small, so it reads as straight ahead); ROLL_CONE: cosine of the angle off the facing that
// still counts as forward or back; CHIN_TUCK: head pitched down while curled (rad)
const ROLL_CENTRE = 0.25, ROLL_SHOULDER = 0.12, ROLL_CONE = 0.4, CHIN_TUCK = 0.5;
/**
 * Where each foot is through a roll, relative to its hip joint in the pelvis's frame (forward, up; m):
 * [time, left, right]. The legs lag the body's turn and swing over after it, like real legs would.
 */
type LegPath = [number, [number, number], [number, number]][];
const ROLL_LEGS: LegPath = [
  [0.1, [0.28, -0.62], [-0.35, -0.75]], // dive: front foot bent ahead, back leg driving off, nearly straight
  [0.22, [0.1, -0.72], [-0.42, -0.7]], // tipping over: both legs trail behind the turning body
  [0.34, [0.22, -0.48], [0.02, -0.62]], // thighs swing up and over
  [0.44, [0.32, -0.3], [0.28, -0.32]], // across the back: knees pulled to the chest
  [0.54, [0.4, -0.46], [0.06, -0.3]], // coming over: left foot reaching for the sand, right leg folding under
  [0.68, [0.34, -0.55], [-0.22, -0.32]], // onto the knee
];
const SIDE_ROLL_LEGS: LegPath = [
  [0.1, [0.15, -0.62], [-0.1, -0.7]], // dropping onto the hip
  [0.3, [0.22, -0.42], [0.18, -0.45]], // knees drawn in as the body tips over
  [0.44, [0.3, -0.3], [0.28, -0.3]], // across the back: tucked tight
  [0.56, [0.3, -0.45], [0.15, -0.4]], // legs coming back under
  [0.68, [0.15, -0.55], [-0.15, -0.5]], // into the crouch
];
function rollLeg(path: LegPath, t: number, side: number, out: THREE.Vector3) {
  const k = side > 0 ? 1 : 2;
  let i = 0;
  while (i < path.length - 2 && t > path[i + 1][0]) i++;
  const a = path[i], b = path[i + 1], e = ease(clamp((t - a[0]) / (b[0] - a[0]), 0, 1));
  return out.set(lerp(a[k][0], b[k][0], e), lerp(a[k][1], b[k][1], e), 0);
}
const REACTIONS: Record<ReactionKind, Move> = {
  // a roll along the steered direction: tucked tight, head over heels. Blows pass through it for all but
  // the last of it, while you come back up onto your feet
  dodge: {
    time: 0.9, strikeAt: -1, cancel: 0.82, iframes: [0.03, 0.42],
    speed: (t) => ROLL_SPEED * bell(t, 0, 0.62),
    keys: [
      // dive: the chest goes first (the hips' turn follows it), left shoulder a little ahead, left arm reaching
      // down ahead for the sand, sword hand drawn in to the chest
      [0.1, { lean: 0.75, drop: 0.25, twist: -0.3, roll: 0.1, hipYaw: 0, rS: -0.9, rO: -0.1, rY: 0.6, rE: -2.0, rR: 0, rW: 0.3, lS: -1.6, lO: 0.15, lE: -0.25, fzL: 0, fzR: 0, width: 0 }],
      // shoulder meets the sand: the reaching arm gives and bends, the back starts to round
      [0.25, { lean: 0.85, drop: 0.2, twist: -0.25, roll: 0.05, hipYaw: 0, rS: -1.0, rO: -0.1, rY: 0.6, rE: -2.0, rR: 0, rW: 0.3, lS: -1.2, lO: 0.5, lE: -0.9, fzL: 0, fzR: 0, width: 0 }],
      // across the back: curled tightest, both arms hugged in
      [0.4, { lean: 0.95, drop: 0.2, twist: -0.1, roll: 0, hipYaw: 0, rS: -0.8, rO: -0.1, rY: 0.6, rE: -2.1, rR: 0, rW: 0.3, lS: -0.9, lO: 0.2, lE: -1.7, fzL: 0, fzR: 0, width: 0 }],
      // coming over: the back uncurls, the free arm swings out to post on the sand
      [0.55, { lean: 0.6, drop: 0.25, twist: 0, roll: 0, hipYaw: 0, rS: -0.9, rO: -0.15, rY: 0.5, rE: -1.9, rR: 0, rW: 0.3, lS: -0.5, lO: 0.6, lE: -0.5, fzL: 0, fzR: 0, width: 0 }],
      // up onto the knee: left foot planted ahead, right knee down behind, free hand pushing off the sand
      [0.7, { lean: 0.4, drop: 0.48, twist: -0.1, roll: 0, hipYaw: -0.15, rS: -0.75, rO: -0.3, rY: 0.2, rE: -1.5, rW: 0.2, lS: -0.3, lO: 0.55, lE: -0.3, fzL: 0.34, fzR: -0.42, width: 0.04 }],
      // rising: weight driving up off the front foot, sword and free hand coming back to guard
      [0.86, { lean: 0.22, drop: 0.25, twist: 0.05, hipYaw: -0.25, rS: -0.65, rO: -0.3, rE: -1.4, lS: -0.35, lO: 0.25, lE: -0.8, fzL: 0.25, fzR: -0.25, width: 0.04 }],
      [1, {}],
    ],
  },


  // the blade sweeps out to meet a blow; if one arrives in the window it is turned aside
  parry: {
    time: 0.6, strikeAt: -1, cancel: 0.8, parry: [0.05, 0.26],
    speed: () => 0,
    keys: [
      // set: blade upright off the right shoulder, tip up, body turned a little away
      [0.12, { rS: -1.09, rY: -0.2, rO: 0.3, rE: -1.13, rR: 0.34, rW: 0.92, twist: -0.15, lean: 0.05, drop: 0.12, lS: -0.5, lE: -1.3, lO: 0.3 }],
      // beat: hips and forearm snap the blade across the front, tip angled up and left, knocking the blow aside
      [0.36, { rS: -1.27, rY: 0.27, rO: 0.3, rE: -1.1, rR: 1.26, rW: 1.17, twist: 0.45, lean: 0.1, drop: 0.13, lS: -0.4, lE: -1.1, lO: 0.35, fzL: 0.24, fzR: -0.22 }],
      [0.6, { rS: -1.15, rY: 0.35, rO: 0.1, rE: -1.15, rR: 1.0, rW: 0.9, twist: 0.35, lean: 0.08, drop: 0.12, lS: -0.4, lE: -1.1, lO: 0.3 }],
      [1, {}],
    ],
  },
  // hit hard enough to lose your footing for a moment
  stagger: {
    time: 0.6, strikeAt: -1,
    speed: (t) => -2.2 * bell(t, 0, 0.5),
    keys: [
      [0.2, { lean: -0.3, drop: 0.16, twist: -0.3, rS: -0.2, rO: -0.6, rE: -0.6, lS: -0.3, lO: 0.7, lE: -0.4, fzL: -0.1, fzR: -0.35 }],
      [0.6, { lean: -0.15, drop: 0.14, twist: -0.1, rS: -0.4, rO: -0.4, rE: -0.9, lS: -0.3, lO: 0.5, lE: -0.6 }],
      [1, {}],
    ],
  },
  // a blow bounced off the opponent's guard
  recoil: {
    time: 0.45, strikeAt: -1,
    speed: (t) => -1.2 * bell(t, 0, 0.5),
    keys: [
      [0.25, { rS: -0.9, rY: 0.4, rO: -0.3, rE: -1.6, rW: 0.3, lean: -0.15, drop: 0.12, twist: 0.2 }],
      [1, {}],
    ],
  },
  // the blade knocked wide by a parry: arms flung open, wide open to a riposte
  parried: {
    time: 1.3, strikeAt: -1,
    speed: (t) => -1.6 * bell(t, 0, 0.35),
    keys: [
      [0.12, { rS: 0.3, rO: -0.9, rY: -0.6, rE: -0.4, rW: 0.2, lS: -0.2, lO: 0.9, lE: -0.3, lean: -0.35, drop: 0.2, twist: -0.4, fzL: -0.05, fzR: -0.4 }],
      [0.75, { rS: 0.1, rO: -0.7, rY: -0.4, rE: -0.6, lS: -0.3, lO: 0.7, lE: -0.5, lean: -0.25, drop: 0.18, twist: -0.25, fzL: -0.05, fzR: -0.35 }],
      [1, {}],
    ],
  },
  // the guard battered down: out of breath, arms dropped
  guardbreak: {
    time: 1.1, strikeAt: -1,
    speed: (t) => -1.4 * bell(t, 0, 0.4),
    keys: [
      [0.15, { rS: -0.1, rO: -0.5, rE: -0.5, lS: 0, lO: 0.4, lE: -0.4, lean: 0.25, drop: 0.24, twist: -0.2, fzL: 0.05, fzR: -0.3 }],
      [0.75, { rS: -0.15, rO: -0.45, rE: -0.6, lS: -0.05, lO: 0.35, lE: -0.5, lean: 0.3, drop: 0.22, twist: -0.15 }],
      [1, {}],
    ],
  },
};

/**
 * Sideways roll: same timeline, but the body goes down flatter onto its side and rolls across the back.
 * Swapped in for the dodge's poses when a roll heads off to the side.
 */
const SIDE_ROLL: Move = {
  ...REACTIONS.dodge,
  keys: [
    // dropped onto the hip and shoulder of the side it rolls to: knees in, arms crossed over the chest, chin tucked
    [0.12, { lean: 0.45, drop: 0.2, twist: 0, roll: 0, hipYaw: 0, rS: -0.9, rO: 0.1, rY: 0.6, rE: -2.0, rR: 0, rW: 0.3, lS: -0.9, lO: -0.1, lE: -2.0, fzL: 0, fzR: 0, width: 0 }],
    [0.45, { lean: 0.5, drop: 0.2, twist: 0, roll: 0, hipYaw: 0, rS: -0.9, rO: 0.1, rY: 0.6, rE: -2.0, rR: 0, rW: 0.3, lS: -0.9, lO: -0.1, lE: -2.0, fzL: 0, fzR: 0, width: 0 }],
    // up into a wide, low crouch, still squared to the front
    [0.7, { lean: 0.3, drop: 0.42, rS: -0.75, rO: -0.3, rE: -1.5, lS: -0.55, lO: 0.3, lE: -1.1, fzL: 0.12, fzR: -0.18, width: 0.16 }],
    [0.86, { lean: 0.18, drop: 0.22, rS: -0.65, rO: -0.3, rE: -1.4, lS: -0.35, lO: 0.25, lE: -0.8, fzL: 0.1, fzR: -0.15, width: 0.08 }],
    [1, {}],
  ],
};

/** Guard held up: blade across the body at chest height, free arm raised to cover the head. */
// (solved for: grip just right of and level with the brow, a hand's span in front of the face; blade flat
// across, tip to the left and a little up, so a blow to the head or neck meets steel)
const BLOCK: Pose = {
  ...READY,
  rS: -1.11, rY: 1.12, rO: -1.16, rE: -1.36, rR: 1.2, rW: 0.41,
  lS: -0.8, lO: 0.3, lE: -1.6,
  twist: 0.1, drop: 0.13, lean: 0.08,
};
/** The guard pose only takes the arms and upper body: the legs keep stepping. */
const GUARD_CHANNELS = ['rS', 'rO', 'rY', 'rE', 'rR', 'rW', 'lS', 'lO', 'lE', 'twist', 'drop', 'lean'] as const;
const BLOCK_SPEED = 0.75, BLOCK_RATE = 14; // walking pace with the guard up (share of WALK); how fast it rises
const BUFFER = 0.35; // seconds a press waits for the fighter to be free
const HOLD_HEAVY = 0.15; // seconds the attack button must stay down to turn a light into a heavy
export const HEAVY_CHARGE = 0.9; // longest a heavy can be held at the top, seconds

const RELAXED: Pose = {
  rS: 0.04, rO: -0.1, rY: 0, rE: -0.22, rR: 0, rW: 0.42,
  lS: 0.03, lO: 0.09, lE: -0.2,
  twist: 0.03, lean: 0.02, roll: 0, drop: 0.015, hipYaw: -0.08,
  fzL: 0.07, fzR: -0.05, width: 0.02,
};
/** Bare-handed at ease: same stance, the right wrist hangs straight instead of cocked for a hilt. */
const RELAXED_BARE: Pose = { ...RELAXED, rW: 0, rE: -0.2, rO: -0.09 };
/** Bare-handed ready stance: a boxer's guard, both fists up by the chin, elbows in, left a little ahead. */
const READY_BARE: Pose = {
  ...READY,
  rS: -0.7, rO: -0.38, rY: 0, rE: -2.1, rR: 0, rW: 0,
  lS: -0.9, lO: 0.3, lE: -1.9,
  twist: 0.0, hipYaw: -0.4,
};
const GUARD_ENTER = 4.5, GUARD_EXIT = 5.5; // metres to the nearest enemy
const GUARD_HOLD = 1.5; // seconds the guard stays up after a swing

const _pose = { ...READY };
const _still = { ...READY };
/**
 * Pose of a move at t = 0..1. Before the first key: held there, or (`from`, a move chained onto another)
 * swept from that pose into it.
 */
function samplePose(atk: Move, t: number, from: Pose | null = null, base: Pose = READY): Pose {
  const keys = atk.keys;
  if (from && t < keys[0][0]) {
    const e = ease(t / keys[0][0]), k0 = keys[0][1];
    for (const ch of CHANNELS) _pose[ch] = lerp(from[ch], k0[ch] ?? base[ch], e);
    return _pose;
  }
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [t0, a] = keys[i], [t1, b] = keys[i + 1];
  const e = ease(clamp((t - t0) / (t1 - t0), 0, 1));
  for (const ch of CHANNELS) _pose[ch] = lerp(a[ch] ?? base[ch], b[ch] ?? base[ch], e);
  return _pose;
}

// --- fit tuning for props on the body ---
// a blade only cuts for a short stretch around each attack's strike moment (fractions of the attack)
const STRIKE_LEAD = 0.16, STRIKE_FOLLOW = 0.1;
// aiming high or low: shoulder tilt (rad), torso lean (rad) and crouch (m) at full aim
const AIM_ARM = 0.5, AIM_LEAN = 0.12, AIM_CROUCH = 0.1;
const FIST_CURL = 1.3; // right hand gripping the sword, radians per finger joint
const GRIP = { x: 0.03, y: -0.09, z: 0.0 }; // sword grip, relative to the right wrist
