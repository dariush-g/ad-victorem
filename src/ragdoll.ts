import * as THREE from 'three';

interface Stick {
  a: number;
  b: number;
  len: number;
  stiff: number;
  minOnly: boolean; // only pushes apart (joint limit), never pulls together
}

const GRAVITY = 15, DAMPING = 0.996, ITERATIONS = 10, SAND_FRICTION = 0.3;

/**
 * Position-based (Verlet) particle body: points joined by distance constraints.
 * Good enough for a limp body tumbling on sand; no angular joint limits beyond
 * the min-distance sticks.
 */
export class Verlet {
  p: THREE.Vector3[] = [];
  prev: THREE.Vector3[] = [];
  private invMass: number[] = [];
  private radius: number[] = [];
  private sticks: Stick[] = [];
  private d = new THREE.Vector3();

  add(pos: THREE.Vector3, invMass: number, radius: number): number {
    this.p.push(pos.clone());
    this.prev.push(pos.clone());
    this.invMass.push(invMass);
    this.radius.push(radius);
    return this.p.length - 1;
  }

  /** Rigid (stiff = 1) or springy link at the current distance. */
  link(a: number, b: number, stiff = 1) {
    this.sticks.push({ a, b, len: this.p[a].distanceTo(this.p[b]), stiff, minOnly: false });
  }

  /** Keep two points at least `len` apart. */
  limit(a: number, b: number, len: number) {
    this.sticks.push({ a, b, len, stiff: 1, minOnly: true });
  }

  step(dt: number, ground: (x: number, z: number) => number, confine: (p: THREE.Vector3, r: number) => void) {
    const { p, prev, d } = this;
    for (let i = 0; i < p.length; i++) {
      d.copy(p[i]).sub(prev[i]).multiplyScalar(DAMPING);
      prev[i].copy(p[i]);
      p[i].add(d);
      p[i].y -= GRAVITY * dt * dt;
    }
    for (let it = 0; it < ITERATIONS; it++) {
      for (const s of this.sticks) {
        const a = p[s.a], b = p[s.b];
        d.copy(b).sub(a);
        const dist = d.length();
        if (dist < 1e-6 || (s.minOnly && dist >= s.len)) continue;
        const wa = this.invMass[s.a], wb = this.invMass[s.b];
        const k = ((dist - s.len) / dist) * s.stiff / (wa + wb);
        a.addScaledVector(d, k * wa);
        b.addScaledVector(d, -k * wb);
      }
      for (let i = 0; i < p.length; i++) {
        const q = p[i], r = this.radius[i];
        const gy = ground(q.x, q.z) + r;
        if (q.y < gy) q.y = gy;
        confine(q, r);
      }
    }
    // contact response: sand eats bounce and drags sliding parts to a stop
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      if (q.y <= ground(q.x, q.z) + this.radius[i] + 1e-4) {
        prev[i].y = Math.max(prev[i].y, q.y);
        prev[i].x += (q.x - prev[i].x) * SAND_FRICTION;
        prev[i].z += (q.z - prev[i].z) * SAND_FRICTION;
      }
    }
  }
}
