import * as THREE from 'three';
import { ITEMS, SLOTS, type Slot } from './items';

/**
 * Where a blow can land. Arms are tracked per side because the arm guard only covers the sword
 * arm; everywhere else both sides count as one place.
 */
export type Zone = 'head' | 'neck' | 'torso' | 'armL' | 'armR' | 'thigh' | 'leg';
export const ZONE_LIST: Zone[] = ['head', 'neck', 'torso', 'armL', 'armR', 'thigh', 'leg'];

/**
 * damage: multiplier on the blow. bleed: how much of the damage that gets through returns as
 * bleeding, in health per second (a gladius cut to the bare neck opens a ~3 hp/s wound).
 */
export const ZONES: Record<Zone, { name: string; damage: number; bleed: number }> = {
  head: { name: 'head', damage: 1.6, bleed: 0.015 },
  neck: { name: 'neck', damage: 1.4, bleed: 0.06 },
  torso: { name: 'torso', damage: 1, bleed: 0.03 },
  armL: { name: 'shield arm', damage: 0.6, bleed: 0.02 },
  armR: { name: 'sword arm', damage: 0.6, bleed: 0.02 },
  thigh: { name: 'thigh', damage: 0.8, bleed: 0.07 },
  leg: { name: 'leg', damage: 0.6, bleed: 0.02 },
};

export const BASE_DAMAGE = 22;
const MAX_PROTECTION = 0.9;

/** Share of a blow to `zone` that the worn gear turns away (layers stack: 1 - Π(1 - cover)). */
export function protection(equipped: Record<Slot, string | null>, zone: Zone): number {
  let through = 1;
  for (const s of SLOTS) {
    const id = equipped[s];
    const c = id ? ITEMS[id].covers?.[zone] : 0;
    if (c) through *= 1 - c;
  }
  return Math.min(MAX_PROTECTION, 1 - through);
}

/** One body part as a capsule: every point within `r` of the segment a–b. */
export interface Part {
  zone: Zone;
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
/** Shortest distance between segments p1–q1 and p2–q2. */
export function segmentDistance(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): number {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) return p1.distanceTo(p2);
  if (a <= 1e-9) t = THREE.MathUtils.clamp(f / e, 0, 1);
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-9) s = THREE.MathUtils.clamp(-c / a, 0, 1);
    else {
      const b = _d1.dot(_d2), denom = a * e - b * b;
      s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  _c1.copy(p1).addScaledVector(_d1, s);
  _c2.copy(p2).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}

/** The body part a weapon segment (radius `wr`) touches, if any; the most deeply touched wins. */
export function touchedPart(parts: Part[], a: THREE.Vector3, b: THREE.Vector3, wr: number): Zone | null {
  let best: Zone | null = null, depth = 0;
  for (const p of parts) {
    const d = p.r + wr - segmentDistance(a, b, p.a, p.b);
    if (d > depth) {
      depth = d;
      best = p.zone;
    }
  }
  return best;
}
