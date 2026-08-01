import type { Obb, Vec2 } from "@/entities/city";
import { add, cross, dot, length, normalize, perp, scale, sub } from "./vec";

/**
 * Monotone-chain convex hull and the rotating-calipers minimum-area OBB built
 * on top of it. The OBB drives every lot subdivision and building footprint
 * downstream, so its `facing`/`w`/`d` must be exact, not merely plausible —
 * see the hand-verified rotated-rectangle fixture in `hull.test.ts`.
 */

const isNotLeftTurn = (o: Vec2, a: Vec2, b: Vec2): boolean =>
  cross(sub(a, o), sub(b, o)) <= 0;

/** Pops `stack` (a locally-owned buffer) while the last two points and `point` don't turn left. */
const pruneStack = (stack: Vec2[], point: Vec2): void => {
  if (stack.length < 2) return;
  const o = stack[stack.length - 2];
  const a = stack[stack.length - 1];
  if (isNotLeftTurn(o, a, point)) {
    stack.pop();
    pruneStack(stack, point);
  }
};

const buildChain = (points: readonly Vec2[]): readonly Vec2[] =>
  points.reduce<Vec2[]>((stack, point) => {
    pruneStack(stack, point);
    stack.push(point);
    return stack;
  }, []);

/**
 * Convex hull of `points` via Andrew's monotone chain, CCW, without
 * duplicating the shared start/end point of the lower and upper chains.
 * Collinear points on an edge are pruned (`isNotLeftTurn` treats a zero
 * cross product as "remove"), so a hull edge never carries a redundant
 * interior point.
 */
export const convexHull = (points: readonly Vec2[]): readonly Vec2[] => {
  if (points.length < 3) return points;
  const sorted = points.toSorted((a, b) =>
    a.x === b.x ? a.y - b.y : a.x - b.x
  );
  const lower = buildChain(sorted);
  const upper = buildChain(sorted.toReversed());
  return lower.slice(0, -1).concat(upper.slice(0, -1));
};

const minOf = (values: readonly number[]): number =>
  values.reduce((a, b) => Math.min(a, b));

const maxOf = (values: readonly number[]): number =>
  values.reduce((a, b) => Math.max(a, b));

/**
 * The OBB obtained by treating `dir` as the box's `facing` axis: `w` is the
 * hull's extent along `dir`, `d` its extent along the perpendicular axis.
 */
const obbForDirection = (hull: readonly Vec2[], dir: Vec2): Obb => {
  const side = perp(dir);
  const us = hull.map((p) => dot(p, dir));
  const vs = hull.map((p) => dot(p, side));
  const minU = minOf(us);
  const maxU = maxOf(us);
  const minV = minOf(vs);
  const maxV = maxOf(vs);
  const center = add(
    scale(dir, (minU + maxU) / 2),
    scale(side, (minV + maxV) / 2)
  );
  return {
    cx: center.x,
    cy: center.y,
    facing: dir,
    w: maxU - minU,
    d: maxV - minV,
  };
};

const candidateDirections = (hull: readonly Vec2[]): readonly Vec2[] => {
  const n = hull.length;
  return hull.map((point, i) => normalize(sub(hull[(i + 1) % n], point)));
};

const obbFromSegment = (a: Vec2, b: Vec2): Obb => {
  const dir = normalize(sub(b, a));
  const mid = scale(add(a, b), 0.5);
  return { cx: mid.x, cy: mid.y, facing: dir, w: length(sub(b, a)), d: 0 };
};

const DEGENERATE_OBB: Obb = {
  cx: 0,
  cy: 0,
  facing: { x: 1, y: 0 },
  w: 0,
  d: 0,
};

/**
 * Rotating-calipers minimum-area oriented bounding box of `points`. The
 * minimum-area box always has one side flush with a convex-hull edge, so
 * only the hull's own edge directions need to be tried as candidate `facing`
 * axes (O(hull size), not a continuous search).
 *
 * Ties (a rectangle input has exactly two, its own two edge directions,
 * both giving the same minimal area) are broken by keeping the first
 * candidate found — the hull's edges are visited in the deterministic order
 * `convexHull` produces, so the result never depends on iteration order.
 */
export const minimumAreaObb = (points: readonly Vec2[]): Obb => {
  const hull = convexHull(points);
  if (hull.length === 0) return DEGENERATE_OBB;
  if (hull.length === 1) {
    return { cx: hull[0].x, cy: hull[0].y, facing: { x: 1, y: 0 }, w: 0, d: 0 };
  }
  if (hull.length === 2) return obbFromSegment(hull[0], hull[1]);
  const candidates = candidateDirections(hull).map((dir) =>
    obbForDirection(hull, dir)
  );
  return candidates.reduce((best, candidate) =>
    candidate.w * candidate.d < best.w * best.d ? candidate : best
  );
};
