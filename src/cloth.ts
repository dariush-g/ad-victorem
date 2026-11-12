import * as THREE from 'three';

/** Rounded stick the cloth can't pass through; endpoints are world-space and kept current by the owner. */
export interface Capsule {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}
/** Squashed sphere fixed in some object's local space (the pelvis). */
export interface Ellipsoid {
  frame: THREE.Object3D;
  center: THREE.Vector3;
  radii: THREE.Vector3;
}
export interface Colliders {
  capsules: Capsule[];
  ellipsoids: Ellipsoid[];
  ground: (x: number, z: number) => number;
}

const GRAVITY = 11, DRAG = 1.6, SUBSTEPS = 2, ITERATIONS = 5, SKIN = 0.012;
/** Share of the wearer's own motion the cloth is simply carried along with; the rest it has to catch up on (lag, swing). */
const FOLLOW = 0.86;
/** Air resistance from moving: acceleration against the wearer's velocity, per m/s, and its ceiling. */
const WIND = 1.1, WIND_MAX = 6.5;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _inv = new THREE.Matrix4(), _delta = new THREE.Matrix4();

/**
 * A rectangular sheet of fabric hanging from a row of pins: Verlet particles joined by
 * stretch, shear and bend constraints, simulated in world space so it lags, swings and
 * drapes over the legs as the wearer moves. The sheet is cut wider than the span of its
 * pins, so it gathers into folds.
 */
export class ClothPanel {
  readonly mesh: THREE.Mesh;
  private n: number;
  private p: Float32Array; // world positions
  private prev: Float32Array;
  private cons: { a: number; b: number; len: number; stiff: number }[] = [];
  private pinWorld: THREE.Vector3[];
  private ready = false;
  private time = Math.random() * 10;
  private lastFrame = new THREE.Matrix4();
  private outward: THREE.Vector3[] = []; // per column, in the frame's space: the side of the body it hangs on
  private guard: { center: THREE.Vector3; min: number } | null;

  /**
   * @param pins  one point per column, in `frame`'s local space
   * @param width cut width of the sheet (wider than the pin span = gathered)
   * @param closed join the last column to the first: a tube (skirt) instead of a flat panel
   * @param guard keeps each column on its own side of the body: measured from `center` (frame space)
   *   along the direction of its pin, no point may come closer than `min`. Stops cloth being dragged
   *   through the wearer and left hanging on the wrong side.
   */
  constructor(private cols: number, private rows: number, width: number, private length: number, material: THREE.Material, private frame: THREE.Object3D, private pins: THREE.Vector3[], closed = false, guard: { center: THREE.Vector3; min: number } | null = null) {
    const n = (this.n = cols * rows);
    this.p = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.pinWorld = pins.map(() => new THREE.Vector3());
    this.guard = guard;
    if (guard) this.outward = pins.map((pin) => new THREE.Vector3(pin.x - guard.center.x, 0, pin.z - guard.center.z).normalize());

    // rest shape: flat sheet in its own xy plane, hem slightly uneven
    const rest = new Float32Array(n * 3);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3, hem = 1 + 0.018 * Math.sin(c * 1.3 + 0.7) * (r / (rows - 1));
        rest[i] = (c / (closed ? cols : cols - 1) - 0.5) * width;
        rest[i + 1] = (-r / (rows - 1)) * length * hem;
      }
    const step = width / (closed ? cols : cols - 1); // rest spacing between neighbouring columns
    const at = (r: number, c: number) => r * cols + (c % cols);
    /** Constrain (r, c) to the point `dc` columns over and `dr` rows down, if the sheet has one. */
    const join = (r: number, c: number, dr: number, dc: number, stiff: number) => {
      if (r + dr >= rows || (!closed && (c + dc >= cols || c + dc < 0))) return;
      if (dr === 0 && r === 0) return; // both pinned
      const a = at(r, c), b = at(r + dr, c + dc + cols);
      this.cons.push({ a, b, len: Math.hypot(dc * step, rest[a * 3 + 1] - rest[b * 3 + 1]), stiff });
    };
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        join(r, c, 1, 0, 1);
        join(r, c, 0, 1, 1);
        join(r, c, 1, 1, 0.6);
        join(r, c, 1, -1, 0.6);
        // bend: resists sharp creases, keeps folds rounded
        join(r, c, 2, 0, 0.25);
        join(r, c, 0, 2, 0.3);
      }

    const index: number[] = [];
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c + (closed ? 0 : 1) < cols; c++) {
        const a = at(r, c), b = at(r, c + 1), d = at(r + 1, c), e = at(r + 1, c + 1);
        index.push(a, d, b, b, d, e);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // vertices are rewritten every frame
  }

  /** Hang every column straight down from its pin, at rest. */
  private reset() {
    const { p, prev, cols, rows } = this;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3, w = this.pinWorld[c];
        p[i] = w.x;
        p[i + 1] = w.y - (r / (rows - 1)) * this.length;
        p[i + 2] = w.z;
      }
    prev.set(p);
    this.lastFrame.copy(this.frame.matrixWorld);
    this.ready = true;
  }

  /**
   * Advance the sheet and write it into the mesh. World matrices of `frame` and of the
   * mesh's parent must be current.
   */
  update(dt: number, col: Colliders) {
    const { p, prev, cols, n, pinWorld } = this;
    this.time += dt;
    let jump = 0;
    for (let c = 0; c < cols; c++) {
      _v.copy(this.pins[c]).applyMatrix4(this.frame.matrixWorld);
      if (c === 0) jump = _v.distanceTo(pinWorld[0]);
      pinWorld[c].copy(_v);
    }
    const now = this.frame.matrixWorld;
    if (!this.ready || jump > 0.8) this.reset(); // first frame, or the wearer was teleported
    else {
      // carry the cloth along with most of the body's own movement (walking, turning, bobbing)
      _delta.copy(now).multiply(_inv.copy(this.lastFrame).invert());
      for (const arr of [p, prev])
        for (let i = cols; i < n; i++) {
          const k = i * 3;
          _v.set(arr[k], arr[k + 1], arr[k + 2]);
          _w.copy(_v).applyMatrix4(_delta);
          arr[k] += (_w.x - _v.x) * FOLLOW;
          arr[k + 1] += (_w.y - _v.y) * FOLLOW;
          arr[k + 2] += (_w.z - _v.z) * FOLLOW;
        }
    }
    // moving through the air sweeps the cloth back, up to a point
    const wind = _w.setFromMatrixPosition(now).sub(_v.setFromMatrixPosition(this.lastFrame)).multiplyScalar(dt > 1e-5 && this.ready ? -WIND / dt : 0);
    if (wind.length() > WIND_MAX) wind.setLength(WIND_MAX);
    const wx = wind.x, wy = wind.y * 0.3, wz = wind.z;
    this.lastFrame.copy(now);

    const h = Math.min(dt, 0.05) / SUBSTEPS, keep = Math.exp(-DRAG * h), g = GRAVITY * h * h;
    for (let s = 1; s <= SUBSTEPS; s++) {
      const f = s / SUBSTEPS;
      for (let i = cols; i < n; i++) {
        const k = i * 3;
        // a breath of moving air, so hanging cloth is never perfectly dead
        const air = Math.sin(this.time * 1.7 + p[k] * 3 + p[k + 1] * 5) * 0.12 * h * h;
        for (let a = 0; a < 3; a++) {
          const cur = p[k + a], vel = (cur - prev[k + a]) * keep;
          prev[k + a] = cur;
          p[k + a] = cur + vel + (a === 1 ? -g : air) + (a === 0 ? wx : a === 1 ? wy : wz) * h * h;
        }
      }
      // pinned row follows the wearer, spread over the substeps
      for (let c = 0; c < cols; c++) {
        const k = c * 3, w = pinWorld[c];
        p[k] += (w.x - p[k]) * f;
        p[k + 1] += (w.y - p[k + 1]) * f;
        p[k + 2] += (w.z - p[k + 2]) * f;
      }
      for (let it = 0; it < ITERATIONS; it++) {
        for (const c of this.cons) {
          const a = c.a * 3, b = c.b * 3;
          const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
          const d = Math.hypot(dx, dy, dz);
          if (d < 1e-7) continue;
          const pa = c.a < cols, pb = c.b < cols; // pinned ends don't move
          if (pa && pb) continue;
          const k = ((d - c.len) / d) * c.stiff, wa = pa ? 0 : pb ? 1 : 0.5, wb = pb ? 0 : pa ? 1 : 0.5;
          p[a] += dx * k * wa; p[a + 1] += dy * k * wa; p[a + 2] += dz * k * wa;
          p[b] -= dx * k * wb; p[b + 1] -= dy * k * wb; p[b + 2] -= dz * k * wb;
        }
        this.collide(col);
      }
    }

    // world → the mesh's parent space
    const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = pos.array as Float32Array;
    _inv.copy(this.mesh.matrixWorld).invert();
    const e = _inv.elements;
    for (let i = 0; i < n; i++) {
      const k = i * 3, x = p[k], y = p[k + 1], z = p[k + 2];
      out[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  private collide(col: Colliders) {
    const { p, cols, n } = this;
    if (this.guard) {
      const m = this.frame.matrixWorld, { center, min } = this.guard;
      _inv.copy(m).invert();
      for (let i = cols; i < n; i++) {
        const k = i * 3, out = this.outward[i % cols];
        _v.set(p[k], p[k + 1], p[k + 2]).applyMatrix4(_inv);
        const s = (_v.x - center.x) * out.x + (_v.z - center.z) * out.z;
        if (s >= min) continue;
        _v.x += out.x * (min - s);
        _v.z += out.z * (min - s);
        _v.applyMatrix4(m);
        this.contact(k, _v.x, _v.y, _v.z);
      }
    }
    for (const el of col.ellipsoids) {
      const m = el.frame.matrixWorld;
      _inv.copy(m).invert();
      for (let i = cols; i < n; i++) {
        const k = i * 3;
        _v.set(p[k], p[k + 1], p[k + 2]).applyMatrix4(_inv).sub(el.center).divide(el.radii);
        const l = _v.length();
        if (l >= 1 || l < 1e-6) continue;
        _v.multiplyScalar(1 / l).multiply(el.radii).add(el.center).applyMatrix4(m);
        this.contact(k, _v.x, _v.y, _v.z);
      }
    }
    for (const cap of col.capsules) {
      const ax = cap.a.x, ay = cap.a.y, az = cap.a.z;
      const bx = cap.b.x - ax, by = cap.b.y - ay, bz = cap.b.z - az;
      const len2 = bx * bx + by * by + bz * bz || 1, r = cap.r + SKIN;
      for (let i = cols; i < n; i++) {
        const k = i * 3;
        const t = Math.min(1, Math.max(0, ((p[k] - ax) * bx + (p[k + 1] - ay) * by + (p[k + 2] - az) * bz) / len2));
        const cx = ax + bx * t, cy = ay + by * t, cz = az + bz * t;
        const dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz, d = Math.hypot(dx, dy, dz);
        if (d >= r || d < 1e-6) continue;
        this.contact(k, cx + (dx / d) * r, cy + (dy / d) * r, cz + (dz / d) * r);
      }
    }
    for (let i = cols; i < n; i++) {
      const k = i * 3, gy = col.ground(p[k], p[k + 2]) + SKIN;
      if (p[k + 1] < gy) this.contact(k, p[k], gy, p[k + 2]);
    }
  }

  /** Move a particle out of a body, and let the contact rub off some of its sliding speed. */
  private contact(k: number, x: number, y: number, z: number) {
    const { p, prev } = this;
    p[k] = x; p[k + 1] = y; p[k + 2] = z;
    prev[k] += (x - prev[k]) * 0.25;
    prev[k + 1] += (y - prev[k + 1]) * 0.25;
    prev[k + 2] += (z - prev[k + 2]) * 0.25;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
