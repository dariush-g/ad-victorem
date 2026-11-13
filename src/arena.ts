import * as THREE from 'three';
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat, solid, PALETTE, SUN_DIR, bowl } from './style';
import { segmentDistance } from './hits';

export const R = 22; // sand radius
const SEG = 128;

/** Which gate: +1 north (+z), -1 south (-z). The two gateways are the same room turned half a circle. */
export type Side = 1 | -1;

/** Holding room behind each portcullis, under the stands. Measured with the gate on +z. */
const ROOM = {
  halfW: 2.1,
  z0: R + 0.35, // inner face of the gate pillars
  z1: R + 8,
  floor: 0.5, // flagstones sit above the sand drifted against the wall
  ceil: 3.6,
  doorHalfW: 1.625,
  doorH: 2.95,
};

/** Where the local player is held: which gateway is theirs, and which side of its gate they are on while it is shut. */
export const site = { side: 1 as Side, zone: 'room' as 'room' | 'arena' };
const gateLift: Record<Side, number> = { [1]: 0, [-1]: 0 }; // 0 shut .. 1 fully raised
const PASSABLE = 0.75;

/** Standing spot in a gateway room, and the heading that faces its gate. */
export function spawnPoint(side: Side) {
  return { pos: new THREE.Vector3(0, ROOM.floor, side * (R + 4)), facing: side === 1 ? Math.PI : 0 };
}

/**
 * Keep a circle of radius `r` inside the walls. With the local gate shut that is the room or the
 * sand, whichever `site.zone` says; with it raised, both plus the doorway between them.
 */
export function confine(p: { x: number; z: number }, r: number) {
  const s = site.side, z = p.z * s;
  const { clamp } = THREE.MathUtils;
  const sand = () => {
    const d = Math.hypot(p.x, p.z), lim = R - r;
    if (d > lim) {
      p.x *= lim / d;
      p.z *= lim / d;
    }
  };
  const room = (zMin: number) => {
    p.x = clamp(p.x, r - ROOM.halfW, ROOM.halfW - r);
    p.z = clamp(z, zMin, ROOM.z1 - r) * s;
  };
  const front = ROOM.z0 + r;
  if (gateLift[s] < PASSABLE) return site.zone === 'room' ? room(front) : sand();
  if (Math.hypot(p.x, z) <= R - r) return;
  if (z < R - 1 || Math.abs(p.x) > ROOM.halfW + 0.5) return sand();
  if (z >= front) return room(front);
  // in the thickness of the wall: free inside the opening, otherwise pushed back out of the stone
  const door = ROOM.doorHalfW - r;
  if (Math.abs(p.x) <= door) return;
  if (Math.abs(p.x) < door + 0.3) p.x = clamp(p.x, -door, door);
  else if (z > (R - r + front) / 2) room(front);
  else sand();
}

/** Walkable height: flagstones through the gateways, sand everywhere else. */
export function groundHeight(x: number, z: number): number {
  if (Math.abs(z) > R - 0.45 && Math.abs(x) < ROOM.halfW + 0.5) return ROOM.floor;
  return sandHeight(x, z);
}

/** Height of whatever is overhead: the room ceiling, the gate lintel, or open sky. */
export function ceilingAt(x: number, z: number): number {
  const az = Math.abs(z);
  if (az <= R - 0.3 || Math.abs(x) > ROOM.halfW + 0.5) return Infinity;
  return az > ROOM.z0 ? ROOM.ceil : ROOM.doorH;
}

/** Pushable circle body (barrels). Placeholder physics: slide, friction, bounce. */
interface Body {
  mesh: THREE.Object3D;
  vx: number;
  vz: number;
  r: number;
}

/** Training post (palus). Static, wobbles on a damped spring when struck. */
interface Palus {
  pivot: THREE.Group;
  x: number;
  z: number;
  r: number;
  tx: number; // tilt
  tz: number;
  wx: number; // tilt velocity
  wz: number;
}

export interface Mover {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
}

export function createArena(scene: THREE.Scene) {
  // stonework carries a baked top-to-bottom gradient in its vertex colours
  const stone = mat(PALETTE.stone, { side: THREE.DoubleSide, vertexColors: true, ashlar: true });
  const stoneDark = mat(PALETTE.stoneDark, { side: THREE.DoubleSide, vertexColors: true, ashlar: true });
  const marble = mat(PALETTE.marble, { surface: 'marble' });
  const wood = mat(PALETTE.wood, { rim: 0.2, surface: 'wood' });
  const woodDark = mat(PALETTE.woodDark, { rim: 0.2, surface: 'wood' });
  const iron = mat(PALETTE.iron, { surface: 'metal' });

  // --- sky & light ---
  scene.background = new THREE.Color(0xf2a36a);
  scene.fog = new THREE.Fog(0xe9a07a, 70, 300);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(400, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { sunDir: { value: SUN_DIR } },
      vertexShader: `varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 p; uniform vec3 sunDir; void main(){
        vec3 v = normalize(p);
        float h = v.y, s = max(dot(v, sunDir), 0.0);
        // sunset: fiery band at the horizon, rose above it, deep violet-blue overhead
        vec3 c = mix(vec3(1.0,0.56,0.24), vec3(0.93,0.46,0.48), smoothstep(-0.02, 0.22, h));
        c = mix(c, vec3(0.42,0.36,0.66), smoothstep(0.15, 0.55, h));
        c = mix(c, vec3(0.16,0.20,0.48), smoothstep(0.45, 1.0, h));
        // the half of the sky away from the sun is already going dusky
        c = mix(c * vec3(0.62,0.62,0.85), c, smoothstep(-0.6, 0.7, dot(normalize(v.xz), normalize(sunDir.xz))));
        c += vec3(1.0, 0.55, 0.2) * (pow(s, 6.0) * 0.45 + pow(s, 90.0) * 0.9) + vec3(1.0, 0.85, 0.6) * smoothstep(0.9985, 0.9990, s) * 3.0;
        gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(PALETTE.shadowSky, PALETTE.bounce, 1.25));
  const sun = new THREE.DirectionalLight(PALETTE.sun, 4.2);
  sun.position.copy(SUN_DIR).multiplyScalar(70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 120;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  // glow off the sunlit stands, opposite the sun: models the shaded sand side softly (no shadows, not blocked by the bowl)
  const glow = new THREE.DirectionalLight(PALETTE.glow, 0.6);
  glow.position.set(-SUN_DIR.x, 0.45, -SUN_DIR.z);
  scene.add(glow);

  const torches: THREE.Mesh[] = [];
  const torchLight = new THREE.PointLight(0xff9a4a, 14, 11, 1.8);
  let time = 0;

  // --- ring helpers (arena is built from concentric steps, merged into one mesh per material) ---
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const tint = (geo: THREE.BufferGeometry, shade: (y: number) => number) => {
    const p = geo.attributes.position, c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) c.fill(shade(p.getY(i)), i * 3, i * 3 + 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  };
  const add = (geo: THREE.BufferGeometry, m: THREE.Material) => {
    if (!parts.has(m)) parts.set(m, []);
    parts.get(m)!.push(geo);
  };
  /** Wall band: darker and warmer toward its foot, as if grounded by bounce shadow. */
  const wallRing = (r: number, y0: number, y1: number, m: THREE.Material, foot = 0.86) => {
    const geo = new THREE.CylinderGeometry(r, r, y1 - y0, SEG, 1, true);
    geo.translate(0, (y0 + y1) / 2, 0);
    add(tint(geo, (y) => (y > (y0 + y1) / 2 ? 1 : foot)), m);
  };
  const flatRing = (r0: number, r1: number, y: number, m: THREE.Material) => {
    const geo = new THREE.RingGeometry(r0, r1, SEG);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, y, 0);
    add(tint(geo, () => 1), m);
  };

  // --- sand ---
  scene.add(createSand());

  // --- podium wall + stepped seating (cavea) ---
  const PODIUM = 4.5, TIERS = 12, TREAD = 1.9, RISER = 1.45, LEDGE = 1.2;
  // the wall is left open behind both gates, where the holding rooms look out through the bars
  const DOOR_H = 3, doorA = Math.asin(1.65 / R);
  const podiumBand = (r: number, y0: number, y1: number, m: THREE.Material, s0: number, s1: number, gap = 0) => {
    for (let k = 0; k < (gap ? 2 : 1); k++) {
      const geo = gap
        ? new THREE.CylinderGeometry(r, r, y1 - y0, SEG / 2, 1, true, k * Math.PI + gap, Math.PI - gap * 2)
        : new THREE.CylinderGeometry(r, r, y1 - y0, SEG, 1, true);
      geo.translate(0, (y0 + y1) / 2, 0);
      add(tint(geo, (y) => (y > (y0 + y1) / 2 ? s1 : s0)), m);
    }
  };
  const doorShade = 0.76 + 0.24 * (DOOR_H / PODIUM);
  podiumBand(R, 0, DOOR_H, stone, 0.76, doorShade, doorA);
  podiumBand(R, DOOR_H, PODIUM, stone, doorShade, 1);
  podiumBand(R - 0.01, 0, 0.5, stoneDark, 0.86, 1, doorA); // plinth band

  // --- holding rooms: flagstone floor, three walls and a ceiling, tucked under the seating ---
  {
    const { halfW, z1, floor, ceil } = ROOM, doorHalfW = 1.65;
    const zf = Math.sqrt(R * R - halfW * halfW); // where the side walls meet the curved podium wall
    // each panel is built for the north gateway, then copied half a turn round for the south
    const panel = (w: number, h: number, m: THREE.Material, shade: (y: number) => number, place: (g: THREE.BufferGeometry) => void) => {
      const geo = new THREE.PlaneGeometry(w, h, Math.ceil(w), 1);
      place(geo);
      add(tint(geo, shade), m);
      add(geo.clone().rotateY(Math.PI), m);
    };
    const wallShade = (y: number) => (y > 1 ? 0.78 : 0.55);
    const len = z1 - zf, zm = (z1 + zf) / 2;
    panel(len, ceil, stone, wallShade, (g) => g.rotateY(Math.PI / 2).translate(-halfW, ceil / 2, zm));
    panel(len, ceil, stone, wallShade, (g) => g.rotateY(-Math.PI / 2).translate(halfW, ceil / 2, zm));
    panel(halfW * 2, ceil, stone, wallShade, (g) => g.rotateY(Math.PI).translate(0, ceil / 2, z1));
    panel(halfW * 2, len, stoneDark, () => 0.5, (g) => g.rotateX(Math.PI / 2).translate(0, ceil, zm));
    panel(halfW * 2, len, stoneDark, () => 0.8, (g) => g.rotateX(-Math.PI / 2).translate(0, floor, zm));
    // threshold between the gate pillars, with a riser down to the sand
    const z0 = R - 0.45;
    panel(doorHalfW * 2, zf - z0, stoneDark, () => 0.8, (g) => g.rotateX(-Math.PI / 2).translate(0, floor, (zf + z0) / 2));
    panel(doorHalfW * 2, floor + 0.2, stoneDark, () => 0.7, (g) => g.rotateY(Math.PI).translate(0, (floor - 0.2) / 2, z0));
  }
  flatRing(R, R + LEDGE, PODIUM, stoneDark);
  let rr = R + LEDGE, top = PODIUM;
  for (let k = 0; k < TIERS; k++) {
    wallRing(rr, top, top + RISER, k % 2 ? stone : stoneDark);
    top += RISER;
    flatRing(rr, rr + TREAD, top, k % 2 ? stoneDark : stone);
    rr += TREAD;
  }
  // back wall, colonnade, entablature
  const GALLERY = 3.2, COL_SCALE = 1.7, COL_H = 4.2 * COL_SCALE, FASCIA = 2.2;
  flatRing(rr, rr + GALLERY, top, stone);
  const outer = rr + GALLERY;
  bowl.value.set(outer - 2.35, top + COL_H + FASCIA, FASCIA); // rim that casts the stadium's shadow
  wallRing(outer, top, top + COL_H + FASCIA, stoneDark);
  flatRing(outer - 2.4, outer, top + COL_H, stone);
  wallRing(outer - 2.4, top + COL_H, top + COL_H + FASCIA, stone);
  for (const [m, geos] of parts) {
    const ring = new THREE.Mesh(mergeGeometries(geos), m);
    ring.receiveShadow = true;
    scene.add(ring);
  }

  // columns: two instanced draws for the whole colonnade
  const colGeo = new THREE.LatheGeometry(
    [[0, -2.1], [0.62, -2.1], [0.62, -1.96], [0.52, -1.9], [0.56, -1.82], [0.47, -1.74], [0.46, -0.6], [0.43, 0.6], [0.39, 1.7], [0.44, 1.76], [0.4, 1.82], [0.56, 1.95], [0.58, 2.1], [0, 2.1]].map(([r, y]) => new THREE.Vector2(r, y)),
    20,
  );
  const capGeo = new RoundedBoxGeometry(1.25, 0.26, 1.25, 2, 0.04);
  capGeo.translate(0, 2.0, 0);
  const COLS = 44;
  const shafts = new THREE.InstancedMesh(colGeo, marble, COLS);
  const caps = new THREE.InstancedMesh(capGeo, marble, COLS);
  const place = new THREE.Object3D();
  for (let i = 0; i < COLS; i++) {
    const a = (i / COLS) * Math.PI * 2, cr = outer - 1.5;
    place.position.set(Math.sin(a) * cr, top + COL_H / 2, Math.cos(a) * cr);
    place.rotation.y = a;
    place.scale.setScalar(COL_SCALE);
    place.updateMatrix();
    shafts.setMatrixAt(i, place.matrix);
    caps.setMatrixAt(i, place.matrix);
  }
  shafts.receiveShadow = caps.receiveShadow = true;
  scene.add(shafts, caps);

  // --- gates (portcullis) at north & south: the grille lifts into the lintel ---
  const gateIron = mat(PALETTE.iron, { surface: 'metal' });
  gateIron.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 3.2)]; // raised bars vanish inside the lintel
  const GATE_RISE = 2.8, GATE_TIME = 1.8;
  const grilles = {} as Record<Side, THREE.Group>;
  const gateTarget: Record<Side, number> = { [1]: 0, [-1]: 0 };
  const gate = (side: Side) => {
    const angle = side === 1 ? 0 : Math.PI;
    const g = new THREE.Group();
    g.position.set(Math.sin(angle) * R, 0, Math.cos(angle) * R);
    g.rotation.y = angle + Math.PI; // local +z faces arena centre
    for (const x of [-1.9, 1.9]) {
      const p = solid(new RoundedBoxGeometry(0.55, 3.3, 0.9, 4, 0.06), marble);
      p.position.set(x, 1.65, 0.1);
      g.add(p);
    }
    const lintel = solid(new RoundedBoxGeometry(4.5, 0.5, 1.0, 4, 0.06), marble);
    lintel.position.set(0, 3.2, 0.1);
    g.add(lintel);
    const grille = new THREE.Group();
    for (let i = -3; i <= 3; i++) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 8), gateIron);
      bar.position.set(i * 0.45, 1.5, 0.32);
      grille.add(bar);
    }
    for (const y of [0.8, 1.6, 2.4]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 8), gateIron);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0, y, 0.32);
      grille.add(bar);
    }
    g.add(grille);
    grilles[side] = grille;
    scene.add(g);
  };
  gate(1);
  gate(-1);
  /** Raise or drop a portcullis; it takes a couple of seconds to travel. */
  const setGate = (side: Side, open: boolean) => void (gateTarget[side] = open ? 1 : 0);
  const gateOpen = (side: Side) => gateLift[side] >= PASSABLE;

  // --- holding room furnishings: a bench and two torches each ---
  const TORCH_Z = R + 3.2;
  {
    const { halfW, z1, floor } = ROOM;
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb648, fog: false });
    for (const side of [1, -1] as Side[]) {
      const room = new THREE.Group();
      room.rotation.y = side === 1 ? 0 : Math.PI;
      const bench = new THREE.Group();
      const seat = solid(new RoundedBoxGeometry(0.45, 0.08, 2.2, 2, 0.02), wood);
      seat.position.y = 0.46;
      bench.add(seat);
      for (const z of [-0.85, 0.85]) {
        const leg = solid(new RoundedBoxGeometry(0.4, 0.44, 0.1, 2, 0.02), woodDark);
        leg.position.set(0, 0.22, z);
        bench.add(leg);
      }
      bench.position.set(halfW - 0.32, floor, z1 - 2.4);
      room.add(bench);
      for (const wall of [-1, 1]) {
        const torch = new THREE.Group();
        const shaft = solid(new THREE.CylinderGeometry(0.035, 0.045, 0.6, 10), woodDark);
        const cup = solid(new THREE.CylinderGeometry(0.09, 0.05, 0.12, 12), iron);
        cup.position.y = 0.34;
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.26, 10), flameMat);
        flame.position.y = 0.52;
        torch.add(shaft, cup, flame);
        torch.position.set(wall * (halfW - 0.16), floor + 1.75, TORCH_Z);
        torch.rotation.z = wall * 0.35; // leaning out from its bracket
        room.add(torch);
        torches.push(flame);
      }
      scene.add(room);
    }
    torchLight.position.set(0, floor + 2.3, TORCH_Z);
    scene.add(torchLight);
  }

  // --- banners on the podium wall ---
  const cloth = mat(PALETTE.banner, { surface: 'cloth' }), gold = mat(PALETTE.gold, { surface: 'metal' });
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    const b = solid(new RoundedBoxGeometry(1.3, 2.2, 0.06, 3, 0.025), cloth);
    b.position.set(Math.sin(a) * (R - 0.12), 2.2, Math.cos(a) * (R - 0.12));
    b.rotation.y = a + Math.PI;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.22, 0.08), gold);
    stripe.position.y = -0.75;
    b.add(stripe);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 32), gold);
    disc.rotation.x = Math.PI / 2;
    disc.position.y = 0.3;
    b.add(disc);
    scene.add(b);
  }

  // --- training posts ---
  // training posts only stand on the sand in practice mode; otherwise they are hidden and solid to nothing
  const pali: Palus[] = [];
  let practice = false;
  const posts = () => (practice ? pali : []);
  /** Put the training posts out (upright and still) or take them away. */
  const setPractice = (on: boolean) => {
    practice = on;
    for (const p of pali) {
      p.pivot.visible = on;
      p.tx = p.tz = p.wx = p.wz = 0;
    }
  };
  const addPalus = (x: number, z: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, sandHeight(x, z) - 0.05, z);
    const post = solid(new THREE.CylinderGeometry(0.17, 0.2, 2.0, 24, 1), wood);
    post.position.y = 1.0;
    const arm = solid(new THREE.CylinderGeometry(0.07, 0.07, 1.2, 16), woodDark);
    arm.rotation.z = Math.PI / 2;
    arm.position.y = 1.45;
    const headGeo = new THREE.SphereGeometry(0.22, 24, 16);
    const head = solid(headGeo, mat(PALETTE.straw, { rim: 0.2, surface: 'cloth' })); // straw-stuffed sack
    head.position.y = 2.15;
    const shield = solid(new THREE.CylinderGeometry(0.42, 0.42, 0.07, 40), woodDark);
    shield.rotation.x = Math.PI / 2;
    shield.position.set(0, 1.25, 0.22);
    pivot.add(post, arm, head, shield);
    pivot.rotation.y = Math.atan2(-x, -z); // shield faces centre-ish
    pivot.visible = false;
    scene.add(pivot);
    pali.push({ pivot, x, z, r: 0.3, tx: 0, tz: 0, wx: 0, wz: 0 });
  };
  addPalus(0, 2);
  addPalus(-5, -2);
  addPalus(5, -2);

  // --- barrels (pushable) ---
  const bodies: Body[] = [];
  const barrelPts = [new THREE.Vector2(0, -0.5)];
  for (let i = 0; i <= 16; i++) barrelPts.push(new THREE.Vector2(0.3 + 0.09 * Math.sin((Math.PI * i) / 16), -0.5 + i / 16));
  barrelPts.push(new THREE.Vector2(0, 0.5));
  const barrelGeo = new THREE.LatheGeometry(barrelPts, 28);
  const hoopGeo = new THREE.TorusGeometry(0.36, 0.022, 8, 28);
  const addBarrel = (x: number, z: number) => {
    const b = solid(barrelGeo, wood);
    for (const y of [-0.3, 0.3]) {
      const h = new THREE.Mesh(hoopGeo, iron);
      h.rotation.x = Math.PI / 2;
      h.position.y = y;
      b.add(h);
    }
    b.position.set(x, 0.5, z);
    scene.add(b);
    bodies.push({ mesh: b, vx: 0, vz: 0, r: 0.4 });
  };
  addBarrel(-9, 8);
  addBarrel(-9.9, 8.6);
  addBarrel(-9.3, 9.5);
  addBarrel(10, 6);
  addBarrel(3, -9);

  function update(dt: number, player: Mover) {
    // keep the player on the sand and out of the posts
    const pp = player.pos;
    confine(pp, player.radius);
    // torch flicker
    time += dt;
    const flick = 0.5 + 0.5 * Math.sin(time * 11) * Math.sin(time * 7.3 + 1.1);
    torchLight.intensity = 12 + 4 * flick;
    torchLight.position.z = site.side * TORCH_Z; // one light, kept in whichever room the player was given
    for (const side of [1, -1] as Side[]) {
      const d = gateTarget[side] - gateLift[side];
      gateLift[side] += Math.sign(d) * Math.min(Math.abs(d), dt / GATE_TIME);
      grilles[side].position.y = gateLift[side] * GATE_RISE;
    }
    for (const f of torches) f.scale.set(1, 0.9 + 0.25 * flick, 1);
    for (const p of posts()) {
      const dx = pp.x - p.x, dz = pp.z - p.z, d = Math.hypot(dx, dz), min = p.r + player.radius;
      if (d < min && d > 1e-4 && pp.y < 2) {
        pp.x = p.x + (dx / d) * min;
        pp.z = p.z + (dz / d) * min;
      }
    }

    const friction = Math.exp(-2.8 * dt);
    for (const b of bodies) {
      const bp = b.mesh.position;
      // shoved by the player
      let dx = bp.x - pp.x, dz = bp.z - pp.z, d = Math.hypot(dx, dz), min = b.r + player.radius;
      if (d < min && d > 1e-4 && pp.y < 1) {
        const nx = dx / d, nz = dz / d;
        bp.x = pp.x + nx * min;
        bp.z = pp.z + nz * min;
        const into = player.vel.x * nx + player.vel.z * nz;
        const along = b.vx * nx + b.vz * nz;
        if (into > along) {
          b.vx += (into - along) * nx;
          b.vz += (into - along) * nz;
        }
      }
      bp.x += b.vx * dt;
      bp.z += b.vz * dt;
      bp.y = 0.5 + sandHeight(bp.x, bp.z);
      b.vx *= friction;
      b.vz *= friction;
      // posts
      for (const p of posts()) {
        dx = bp.x - p.x; dz = bp.z - p.z; d = Math.hypot(dx, dz); min = b.r + p.r;
        if (d < min && d > 1e-4) {
          const nx = dx / d, nz = dz / d;
          bp.x = p.x + nx * min;
          bp.z = p.z + nz * min;
          const vn = b.vx * nx + b.vz * nz;
          if (vn < 0) { b.vx -= 1.5 * vn * nx; b.vz -= 1.5 * vn * nz; }
        }
      }
      // wall
      d = Math.hypot(bp.x, bp.z);
      if (d > R - b.r) {
        const nx = bp.x / d, nz = bp.z / d;
        bp.x = nx * (R - b.r);
        bp.z = nz * (R - b.r);
        const vn = b.vx * nx + b.vz * nz;
        if (vn > 0) { b.vx -= 1.5 * vn * nx; b.vz -= 1.5 * vn * nz; }
      }
    }
    // barrel vs barrel
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j], ap = a.mesh.position, bp = b.mesh.position;
        const dx = bp.x - ap.x, dz = bp.z - ap.z, d = Math.hypot(dx, dz), min = a.r + b.r;
        if (d >= min || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d, push = (min - d) / 2;
        ap.x -= nx * push; ap.z -= nz * push;
        bp.x += nx * push; bp.z += nz * push;
        const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (rel > 0) {
          a.vx -= rel * nx * 0.9; a.vz -= rel * nz * 0.9;
          b.vx += rel * nx * 0.9; b.vz += rel * nz * 0.9;
        }
      }

    // palus wobble: damped spring back to upright
    for (const p of pali) {
      p.wx += (-90 * p.tx - 5 * p.wx) * dt;
      p.wz += (-90 * p.tz - 5 * p.wz) * dt;
      p.tx += p.wx * dt;
      p.tz += p.wz * dt;
      // tilt is in world space; pivot has its own yaw, so apply via quaternion
      const yaw = p.pivot.rotation.y;
      const lx = p.tx * Math.cos(yaw) - p.tz * Math.sin(yaw);
      const lz = p.tx * Math.sin(yaw) + p.tz * Math.cos(yaw);
      p.pivot.rotation.set(lz, yaw, -lx, 'YXZ');
    }
  }

  /**
   * A weapon segment a–b (radius `wr`) at this moment of a swing: shove whatever post or barrel it
   * touches along `dir`. Each thing is struck once per swing; `struck` remembers which. Returns new hits.
   */
  const _p = new THREE.Vector3(), _q = new THREE.Vector3();
  function touch(a: THREE.Vector3, b: THREE.Vector3, wr: number, dir: THREE.Vector3, power: number, struck: Set<object>): number {
    let hits = 0;
    for (const p of posts()) {
      if (struck.has(p)) continue;
      const y = p.pivot.position.y;
      if (segmentDistance(a, b, _p.set(p.x, y, p.z), _q.set(p.x, y + 2.35, p.z)) > 0.25 + wr) continue;
      struck.add(p);
      p.wx += dir.x * 4.5 * power;
      p.wz += dir.z * 4.5 * power;
      hits++;
    }
    for (const body of bodies) {
      const bp = body.mesh.position;
      if (struck.has(body) || segmentDistance(a, b, _p.set(bp.x, bp.y - 0.5, bp.z), _q.set(bp.x, bp.y + 0.5, bp.z)) > body.r + wr) continue;
      struck.add(body);
      body.vx += dir.x * 7 * power;
      body.vz += dir.z * 7 * power;
      hits++;
    }
    return hits;
  }

  /** Distance from a point to the nearest enemy. Placeholder: the training posts stand in for enemies. */
  function enemyDistance(pos: THREE.Vector3): number {
    let best = Infinity;
    for (const p of posts()) best = Math.min(best, Math.hypot(p.x - pos.x, p.z - pos.z) - p.r);
    return best;
  }

  return { update, touch, enemyDistance, setGate, gateOpen, setPractice };
}

/** Sand surface height: low dunes, scuffed hollows, drift piled against the wall. */
export function sandHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const dunes =
    0.14 * Math.sin(x * 0.33 + 1.3) * Math.cos(z * 0.29 - 0.4) +
    0.08 * Math.sin(x * 0.85 + z * 0.62) +
    0.045 * Math.sin(z * 1.9 - x * 0.45 + 2.0) +
    0.022 * Math.sin(x * 3.1 + 0.7) * Math.sin(z * 2.7);
  const drift = THREE.MathUtils.smoothstep(d, R - 3.5, R) * 0.16;
  return dunes + drift;
}

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Tileable value noise, period `p` cells. */
function vnoise(x: number, y: number, p: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (n: number) => ((n % p) + p) % p;
  const a = hash(w(xi), w(yi)), b = hash(w(xi + 1), w(yi)), c = hash(w(xi), w(yi + 1)), d = hash(w(xi + 1), w(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function createSand(): THREE.Mesh {
  // broad, soft wind ripples — smooth bands, no grain
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const warp = vnoise(u * 4, v * 4, 4) * 1.4 + vnoise(u * 9, v * 9, 9) * 0.4;
      const band = Math.sin((v * 7 + warp) * Math.PI * 2) * 0.5 + 0.5;
      const l = 255 * (0.93 + 0.07 * band * band * (3 - 2 * band));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = l;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const ripples = new THREE.CanvasTexture(cv);
  ripples.wrapS = ripples.wrapT = THREE.RepeatWrapping;
  ripples.colorSpace = THREE.SRGBColorSpace;
  ripples.anisotropy = 4;
  ripples.repeat.set(7, 7);

  const span = R * 2 + 2, n = 176;
  const geo = new THREE.PlaneGeometry(span, span, n, n);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const crest = new THREE.Color(PALETTE.sandCrest), hollow = new THREE.Color(PALETTE.sandHollow), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = sandHeight(x, z);
    pos.setY(i, h);
    // pale crests, richer orange hollows, plus slow drifts of tone across the floor
    const t = THREE.MathUtils.clamp(0.5 + h * 1.8 + (vnoise(x * 0.14 + 50, z * 0.14 + 50, 1024) - 0.5) * 0.4, 0, 1);
    c.lerpColors(hollow, crest, t * t * (3 - 2 * t));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const sandMat = mat(0xffffff, { vertexColors: true, map: ripples, surface: 'sand' });
  const sand = new THREE.Mesh(geo, sandMat);
  sand.receiveShadow = true;
  return sand;
}
