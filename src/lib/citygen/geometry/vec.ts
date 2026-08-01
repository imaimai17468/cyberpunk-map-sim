import type { Vec2 } from "@/entities/city";

/**
 * Vec2 arithmetic and the trig-free orientation primitives the generator
 * relies on everywhere angles would otherwise appear (design doc §5, §12):
 * random unit vectors from a uniform draw, a 2θ "line tensor" representation
 * for blending undirected line orientations, and a diamond-angle comparator
 * for sorting directions when `atan2` is banned.
 *
 * No function in this file uses a transcendental, `**`, or `Math.random` —
 * only `+ - * /`, `Math.sqrt`, `Math.min/max/abs`, matching the determinism
 * rules in AGENTS.md / design doc §5.
 */

const ZERO_VEC: Vec2 = { x: 0, y: 0 };

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

export const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** 2D cross ("perp dot") product: `a.x*b.y - a.y*b.x`. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const lengthSq = (v: Vec2): number => dot(v, v);

export const length = (v: Vec2): number => Math.sqrt(lengthSq(v));

/** 90-degree rotation: `(x, y) -> (-y, x)`. */
export const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });

const NORMALIZE_EPSILON = 1e-9;

/**
 * Unit vector in the direction of `v`, or `fallback` (default the zero
 * vector) when `v` is too short to normalise without blowing up.
 */
export const normalize = (v: Vec2, fallback: Vec2 = ZERO_VEC): Vec2 => {
  const len = length(v);
  return len < NORMALIZE_EPSILON ? fallback : scale(v, 1 / len);
};

/**
 * Trig-free random unit vector from a uniform draw `u` in [0, 1) via the
 * rational (Weierstrass) parametrisation of the unit circle:
 * `t = 2u - 1`, `dir = ((1-t²)/(1+t²), 2t/(1+t²))`.
 *
 * That parametrisation only sweeps the right half-plane (x >= 0) as `t`
 * ranges over [-1, 1) — design doc §5 covers the rest of the circle by
 * negating on a second draw's bit, which `flip` represents here.
 */
export const randomUnitVector = (u: number, flip: boolean): Vec2 => {
  const t = 2 * u - 1;
  const denom = 1 + t * t;
  const dir: Vec2 = { x: (1 - t * t) / denom, y: (2 * t) / denom };
  return flip ? scale(dir, -1) : dir;
};

/**
 * A direction represented as its double-angle ("2θ") components
 * `(x² - y², 2xy)`. Two opposite unit vectors (a line's two directions)
 * produce the same tensor, which is what makes this representation the
 * right one to average when only the *line*, not its sign, matters (cut
 * orientations, contour/shore tangents).
 */
export interface LineTensor {
  readonly a: number;
  readonly b: number;
}

export const toLineTensor = (v: Vec2): LineTensor => ({
  a: v.x * v.x - v.y * v.y,
  b: 2 * v.x * v.y,
});

export interface WeightedLineTensor {
  readonly tensor: LineTensor;
  readonly weight: number;
}

/** Weighted sum of line tensors — the blend step of design doc §3 stage 7. */
export const blendLineTensors = (
  entries: readonly WeightedLineTensor[]
): LineTensor =>
  entries.reduce<LineTensor>(
    (acc, entry) => ({
      a: acc.a + entry.tensor.a * entry.weight,
      b: acc.b + entry.tensor.b * entry.weight,
    }),
    { a: 0, b: 0 }
  );

export const lineTensorMagnitude = (t: LineTensor): number =>
  Math.sqrt(t.a * t.a + t.b * t.b);

const TENSOR_MAGNITUDE_EPSILON = 1e-12;
const COS_THETA_EPSILON = 1e-9;

/**
 * Recovers a unit direction whose 2θ tensor is (approximately) `t`, via a
 * trig-free half-angle identity — never `atan2`. The result is one of the
 * two antipodal directions of the represented line; sign is not meaningful
 * for an undirected cut/contour direction.
 *
 * Always returns a finite unit vector, including when `t`'s magnitude is at
 * or near zero (a degenerate blend, e.g. two perpendicular tensors weighted
 * equally). Callers that need a *different* direction in that case — the
 * design's "OBB long-axis perpendicular" fallback — must check
 * `lineTensorMagnitude(t)` themselves and substitute their own vector; this
 * function only guarantees it never hands back NaN.
 */
export const directionFromLineTensor = (t: LineTensor): Vec2 => {
  const magnitude = lineTensorMagnitude(t);
  if (magnitude < TENSOR_MAGNITUDE_EPSILON) return { x: 1, y: 0 };
  const cosDouble = t.a / magnitude;
  const sinDouble = t.b / magnitude;
  const cosTheta = Math.sqrt(Math.max(0, (1 + cosDouble) / 2));
  const sinTheta =
    cosTheta < COS_THETA_EPSILON ? 1 : sinDouble / (2 * cosTheta);
  return { x: cosTheta, y: sinTheta };
};

const PSEUDO_ANGLE_EPSILON = 1e-12;

/**
 * Diamond-angle pseudo-angle of `v`, in [0, 4) with right angles landing on
 * integers. Monotonic in the true angle of `v`, built only from division and
 * addition (plus the sign comparisons that pick the quadrant branch) — no
 * `atan2`. The zero vector maps to 0 arbitrarily.
 */
export const pseudoAngle = (v: Vec2): number => {
  const { x, y } = v;
  if (Math.abs(x) < PSEUDO_ANGLE_EPSILON && Math.abs(y) < PSEUDO_ANGLE_EPSILON)
    return 0;
  if (y >= 0) return x >= 0 ? y / (x + y) : 1 - x / (y - x);
  return x < 0 ? 2 - y / (-x - y) : 3 + x / (x - y);
};

/** Comparator over `pseudoAngle`, usable directly with `Array.prototype.sort`. */
export const comparePseudoAngle = (a: Vec2, b: Vec2): number =>
  pseudoAngle(a) - pseudoAngle(b);
