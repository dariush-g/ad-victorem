import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mat, simplifyTexture, PALETTE } from './style';
import { Verlet } from './ragdoll';

// Body: "Universal Base Characters" by Quaternius (CC0) — see public/models/gladiator/LICENSE.txt
const MODEL_DIR = '/models/gladiator/';

// --- movement ---
const WALK = 1.8, RUN = 5.0, JUMP = 4.7, GRAVITY = 16;
const ACCEL = 16, DECEL = 20, AIR_ACCEL = 3, TURN = 9;
const BACKPEDAL = 0.62; // backward walking speed, as a fraction of WALK
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

/** Smooth surface of revolution through (radius, y) control points, y ascending. */
function lathe(ctrl: [number, number][], radial = 40, steps = 30) {
  const curve = new THREE.SplineCurve(ctrl.map(([r, y]) => new THREE.Vector2(r, y)));
  const pts = curve.getPoints(steps).map((p) => new THREE.Vector2(Math.max(0.0004, p.x), p.y));
  return new THREE.LatheGeometry(pts, radial);
}

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

export async function loadGladiator(ground: Ground, wallR: number): Promise<Gladiator> {
  const loader = new GLTFLoader();
  const [body, hair] = await Promise.all([
    loader.loadAsync(MODEL_DIR + 'body.gltf'),
    loader.loadAsync(MODEL_DIR + 'hair.gltf'),
  ]);
  return new Gladiator(ground, wallR, body.scene, hair.scene);
}

/**
 * Player character. An invisible "driver" rig (plain joint hierarchy: model faces +Z,
 * its left is +X, limbs hang along -Y) is animated procedurally or by the ragdoll, and
 * the skinned body's bones copy it every frame.
 */
export class Gladiator {
  root = new THREE.Group();
  pos = new THREE.Vector3(0, 0, 13); // feet / physics position
  vel = new THREE.Vector3();
  radius = 0.35;
  facing = Math.PI;
  /** Called once per swing when the blow lands. */
  onStrike = (_origin: THREE.Vector3, _dir: THREE.Vector3, _reach: number) => {};

  private onGround = true;
  private attackT = -1; // seconds into the attack; <0 = not attacking
  private attack: Attack = ATTACKS.stand;
  private attackV0 = 0; // ground speed when the attack began
  private prevStance = [0, 0];
  private struck = false;
  private phase = 0;
  private time = 0;
  private squat = 0; // landing compression
  private accF = 0; // smoothed acceleration, character-local
  private accL = 0;
  private prevVel = new THREE.Vector3();
  private lastDt = 1 / 60;

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

  private rag: Verlet | null = null;
  private ragT = 0;
  private blendT = GETUP_TIME; // < GETUP_TIME while getting up
  private blendFrom: THREE.Quaternion[] = [];
  private blendHips = new THREE.Vector3();
  private hipsQ = new THREE.Quaternion();
  private spineQ = new THREE.Quaternion();
  private limbQ = new THREE.Quaternion();
  private limbQ2 = new THREE.Quaternion();

  constructor(private ground: Ground, private wallR: number, model: THREE.Object3D, hair: THREE.Object3D) {
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
      const m = mat(hairy ? PALETTE.hair : 0xffffff, { rim: eye ? 0 : 0.3, map }); // hair texture is greyscale, meant to be tinted
      if (alphaTest) {
        m.alphaTest = alphaTest;
        m.side = THREE.DoubleSide;
      }
      mesh.material = m;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // skinned bounds don't follow the pose
    };
    model.traverse((o) => restyle(o));

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

    // ---- props that ride on the driver rig ----
    const cloth = mat(PALETTE.linen, { rim: 0.2 });
    const leather = mat(PALETTE.leather, { rim: 0.2 });
    const wood = mat(PALETTE.wood, { rim: 0.2 });
    const woodDark = mat(PALETTE.woodDark, { rim: 0.2 });
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = m.receiveShadow = true;
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      parent.add(m);
      return m;
    };

    // loincloth: wrap, belt, hanging flaps
    const W = CLOTH;
    mesh(lathe([[0, -0.17], [0.09, -0.16], [0.16, -0.08], [0.165, 0.0], [0.15, 0.07], [0.14, 0.11]]), cloth, this.hips, 0, W.y, W.z, W.sx, 1, W.sz);
    const belt = mesh(new THREE.TorusGeometry(0.148, 0.02, 16, 64), leather, this.hips, 0, W.y + 0.085, W.z, W.sx, W.sz, 1);
    belt.rotation.x = Math.PI / 2;
    const flapGeo = new RoundedBoxGeometry(0.2, 0.27, 0.018, 4, 0.008);
    mesh(flapGeo, cloth, this.hips, 0, W.y - 0.17, W.z + 0.165 * W.sz - 0.006).rotation.x = -0.06;
    mesh(flapGeo, cloth, this.hips, 0, W.y - 0.17, W.z - 0.165 * W.sz + 0.006).rotation.x = 0.06;

    // wooden training sword (rudis) in the right fist; blade runs along local +Y
    const sword = group(this.armR.hand, new THREE.Vector3(GRIP.x, GRIP.y, GRIP.z));
    sword.rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.17, 24), woodDark, sword);
    mesh(new THREE.SphereGeometry(0.034, 24, 18), woodDark, sword, 0, -0.1, 0);
    mesh(new RoundedBoxGeometry(0.17, 0.035, 0.055, 4, 0.014), woodDark, sword, 0, 0.095, 0);
    mesh(new RoundedBoxGeometry(0.062, 0.62, 0.024, 4, 0.01), wood, sword, 0, 0.42, 0);
    const tip = mesh(new THREE.ConeGeometry(0.044, 0.1, 4), wood, sword, 0, 0.78, 0, 1, 1, 0.4);
    tip.rotation.y = Math.PI / 4;

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

  get attacking() {
    return this.attackT >= 0;
  }
  get ragdolled() {
    return this.rag !== null;
  }

  update(dt: number, c: Controls) {
    if (dt <= 0) return;
    this.time += dt;
    this.lastDt = dt;

    if (this.rag) this.updateRagdoll(dt, c);
    else if (c.ragdoll && this.blendT >= GETUP_TIME) this.startRagdoll();
    else this.updateActive(dt, c);
    this.syncModel();
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
      this.attack = speed > RUN_ATTACK_SPEED ? ATTACKS.run : speed > WALK_ATTACK_SPEED ? ATTACKS.walk : ATTACKS.stand;
      this.attackT = 0;
      this.struck = false;
      this.attackV0 = speed;
      // a running lunge carries on along your path; the others turn to where you're aiming
      this.facing = this.attack === ATTACKS.run ? Math.atan2(this.vel.x, this.vel.z) : c.aimYaw;
    }
    if (this.attacking) {
      this.attackT += dt;
      const t = this.attackT / this.attack.time;
      if (!this.struck && t >= this.attack.strikeAt) {
        this.struck = true;
        const dir = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
        this.onStrike(this.pos.clone(), dir, this.attack.reach);
      }
      if (t >= 1) this.attackT = -1;
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
      const top = c.backpedal ? WALK * BACKPEDAL : c.sprint ? RUN : WALK;
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
    const amt = Math.min(1, v / 1.2);
    const run = clamp((v - WALK) / (RUN - WALK), 0, 1);
    const idle = 1 - amt;
    const backward = this.vel.x * sy + this.vel.z * cy < -0.25 * Math.max(v, 0.01); // stepping backward
    const dirSign = backward ? -1 : 1;

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
    const A = lerp(0.4, 0.62, run) * (backward ? 0.7 : 1);
    this.phase += (dirSign * dt * v * Math.PI) / (2 * A);
    const ph = this.phase, cph = Math.cos(ph), sph = Math.sin(ph);
    const breath = Math.sin(this.time * 1.9);
    const TAU = Math.PI * 2;
    const pos = (x: number) => 0.25 * (1 + x) * (1 + x); // smooth "positive part" of a -1..1 wave (no kinks)

    // ---- base pose: ready stance when still, blending into the stride when moving ----
    const swing = (0.38 + 0.5 * run) * (backward ? 0.6 : 1);
    const lagE = Math.cos(ph - 0.55), lagW = Math.cos(ph - 1.1);
    const R = READY;
    const pose: Pose = {
      // right arm: sword up in guard, or a relaxed carry swinging with the stride
      rS: lerp(R.rS, -0.12 + cph * swing * 0.6, amt) + breath * 0.012 * idle,
      rO: lerp(R.rO, -0.28, amt),
      rY: lerp(R.rY, 0, amt),
      rE: lerp(R.rE, -0.7 - run * 0.5 - pos(-lagE) * 0.3, amt),
      rR: 0,
      rW: lerp(R.rW, 0.08 + lagW * 0.12, amt),
      // left arm: forward for balance, or a pendulum trailing the stride
      lS: lerp(R.lS, -cph * swing + 0.04, amt) + breath * 0.012 * idle,
      lO: lerp(R.lO, 0.13 + 0.06 * run - pos(cph) * 0.05, amt),
      lE: lerp(R.lE, -(0.42 + run) - pos(lagE) * 0.4, amt),
      twist: lerp(R.twist, -cph * 0.26, amt),
      lean: lerp(R.lean, 0.03 + run * 0.2, amt) + clamp(this.accF * 0.012, -0.16, 0.2) - (backward ? 0.07 * amt : 0),
      roll: clamp(-this.accL * 0.01, -0.18, 0.18) - sph * 0.03 * amt,
      drop: lerp(R.drop, 0.055 + 0.05 * run, amt) + this.squat + breath * 0.005 * idle,
      hipYaw: lerp(R.hipYaw, cph * 0.14, amt),
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
      const u = ((phi % TAU) + TAU) % TAU;
      const inAir = u < Math.PI, n = (inAir ? u : u - Math.PI) / Math.PI; // 0..1 through swing or stance
      // stance: straight line back at ground speed. swing: cubic that matches that speed at both ends.
      const stride = inAir ? ((-8 * n + 12) * n - 2) * n - 1 : 1 - 2 * n; // in units of A
      const sp = inAir ? Math.sin(Math.PI * n) : 0;
      const fz = stride * A * gait + stance;
      const lx = leg.side * (this.hipX + 0.012 + pose.width);
      const gy = clamp(this.ground(this.pos.x + lx * cy + fz * sy, this.pos.z - lx * sy + fz * cy) - this.pos.y, -0.3, 0.3);
      // a foot being repositioned (stance change, lunge, step-in) lifts instead of dragging
      const stepLift = Math.min(0.1, Math.abs(stance - this.prevStance[i]) * inv * 0.035);
      this.prevStance[i] = stance;
      return { fz, gy, lift: (sp > 0 ? sp * sp * liftH * 1.15 * gait : 0) + stepLift, phi }; // sin²: soft takeoff and landing
    };
    const L = plan(legL, ph, pose.fzL, 0), Rr = plan(legR, ph + Math.PI, pose.fzR, 1);

    const bob = -Math.cos(2 * ph) * (0.03 + 0.015 * run) * gait;
    const pelvisY = this.pelvisY - pose.drop + bob + (grounded ? Math.min(0, L.gy, Rr.gy) * 0.8 : 0);
    // weight shifts over the planted foot; idle: slow sway
    hips.position.set(-sph * 0.026 * gait + Math.sin(this.time * 0.7) * 0.008 * idle, pelvisY, this.pelvisZ);
    hips.rotation.set(0, pose.hipYaw, sph * 0.05 * gait);

    const k = 1 - Math.exp(-40 * dt);
    const hipY = pelvisY + this.hipDY;
    // heel strikes toes-up, rolls flat, pushes off toes-down
    const footPitch = (phi: number) => {
      const u = ((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (u < Math.PI) return 0.07 + 0.38 * Math.cos(u);
      const st = (u - Math.PI) / Math.PI;
      return st < 0.2 ? lerp(-0.31, 0, ease(st / 0.2)) : st > 0.7 ? lerp(0, 0.45, ease((st - 0.7) / 0.3)) : 0;
    };
    const place = (leg: Leg, t: { fz: number; gy: number; lift: number; phi: number }, airZ: number, airY: number) => {
      const tz = grounded ? t.fz : airZ;
      const ty = grounded ? t.gy + this.ankle + t.lift - hipY : airY;
      leg.tz += (tz - leg.tz) * k;
      leg.ty += (ty - leg.ty) * k;
      this.solveLeg(leg, grounded ? footPitch(t.phi) * gait * (0.7 + 0.3 * run) * (backward ? 0.3 : 1) : 0.35);
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
    head.rotation.set(-pose.lean * 0.55, -(pose.twist + pose.hipYaw) * 0.8, -pose.roll * 0.6);
  }

  /** Two-bone IK in the leg's sagittal plane: put the ankle at (tz, ty) from the hip. */
  private solveLeg(leg: Leg, toePitch: number) {
    const T = this.thigh, S = this.shin;
    const full = T + S, soft = 0.95 * full, raw = Math.hypot(leg.tz, leg.ty);
    // approach full extension asymptotically: the knee never snaps straight (that pop reads as jerky)
    const d = Math.max(0.25, raw <= soft ? raw : soft + (full - soft) * 0.985 * (1 - Math.exp(-(raw - soft) / (full - soft))));
    const toTarget = Math.atan2(-leg.tz, -leg.ty);
    const hipIn = Math.acos(clamp((T * T + d * d - S * S) / (2 * T * d), -1, 1));
    const kneeIn = Math.acos(clamp((T * T + S * S - d * d) / (2 * T * S), -1, 1));
    const hipRot = toTarget - hipIn; // knee forward
    const kneeRot = Math.PI - kneeIn;
    leg.upper.rotation.set(hipRot, 0, 0);
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
    for (let i = 0; i < 3; i++) rag.step(dt / 3, this.ground, this.wallR);
    this.poseFromRagdoll();

    const pel = rag.p[PELV];
    this.pos.set(pel.x, this.ground(pel.x, pel.z), pel.z); // camera + arena follow the body
    this.vel.set(0, 0, 0);

    const wants = c.ragdoll || c.jump || c.moveX !== 0 || c.moveZ !== 0;
    if ((wants && this.ragT > RAG_MIN_TIME) || this.ragT > RAG_MAX_TIME) this.getUp();
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
  reach: number; // metres
  /** Forward speed during the attack; t = 0..1, v0 = ground speed when it began. */
  speed: (t: number, v0: number) => number;
  /** [fraction of time, pose]; channels left out fall back to READY. */
  keys: [number, Partial<Pose>][];
}

const bell = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));
const WALK_ATTACK_SPEED = 0.8, RUN_ATTACK_SPEED = 4.0;

const ATTACKS: Record<'stand' | 'walk' | 'run', Attack> = {
  // Standing: feet planted, flat cut from right to left powered by the hips.
  stand: {
    time: 0.62, strikeAt: 0.5, reach: 1.75,
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
    time: 0.72, strikeAt: 0.5, reach: 1.9,
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
    time: 0.85, strikeAt: 0.46, reach: 2.3,
    speed: (t, v0) => Math.max(v0, 4.5) * (1 - ease(Math.min(1, t / 0.62))),
    keys: [
      [0.17, { rS: 0.55, rO: -0.25, rE: -1.95, rW: 1.0, twist: -0.5, hipYaw: -0.3, lean: 0.3, drop: 0.1, lS: -1.4, lE: -0.25, lO: 0.15, fzL: -0.15, fzR: 0.2 }],
      [0.38, { rS: -1.9, rY: -0.7, rO: 0.05, rE: -0.05, rW: 1.35, twist: 0.6, hipYaw: 0.25, lean: 0.5, drop: 0.3, lS: 0.9, lE: -0.2, lO: 0.4, fzL: -0.55, fzR: 0.6 }],
      [0.7, { rS: -1.8, rY: -0.6, rO: 0.05, rE: -0.15, rW: 1.25, twist: 0.5, hipYaw: 0.2, lean: 0.45, drop: 0.3, lS: 0.8, lE: -0.3, lO: 0.4, fzL: -0.5, fzR: 0.55 }],
      [1, {}],
    ],
  },
};

const _pose = { ...READY };
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
const FIST_CURL = 1.3; // right hand gripping the sword, radians per finger joint
const GRIP = { x: 0.03, y: -0.09, z: 0.0 }; // sword grip, relative to the right wrist
const CLOTH = { y: 0.02, z: 0.012, sx: 1.16, sz: 0.95 }; // loincloth placement/scale on the pelvis
