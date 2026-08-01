import type { Vec2 } from "@/entities/city";
import { add, normalize, perp, scale, sub } from "./vec";

/**
 * Polygon operations on a ring of `Vec2` vertices (CCW by the project's
 * convention — `entities/city`'s `PolygonPool` documents rings the same way).
 * Rings here are plain arrays rather than the pooled `Float32Array` form;
 * pooling into `PolygonPool` is a stage-level concern downstream of these
 * pure functions.
 */

const AREA_EPSILON = 1e-9;

/** Twice-signed-area shoelace sum, positive for a CCW ring. Zero below 3 vertices. */
export const signedArea = (ring: readonly Vec2[]): number => {
  const n = ring.length;
  if (n < 3) return 0;
  return (
    0.5 *
    ring.reduce((acc, p, i) => {
      const next = ring[(i + 1) % n];
      return acc + (p.x * next.y - next.x * p.y);
    }, 0)
  );
};

export const area = (ring: readonly Vec2[]): number =>
  Math.abs(signedArea(ring));

const ZERO_VEC: Vec2 = { x: 0, y: 0 };

/**
 * Area-weighted polygon centroid. Falls back to the arithmetic mean of the
 * vertices when the signed area is (near) zero — a degenerate ring (fewer
 * than 3 points, or collinear vertices) has no well-defined area-weighted
 * centroid.
 */
export const centroid = (ring: readonly Vec2[]): Vec2 => {
  const n = ring.length;
  if (n === 0) return ZERO_VEC;
  const signed = signedArea(ring);
  if (Math.abs(signed) < AREA_EPSILON) {
    return scale(
      ring.reduce((acc, p) => add(acc, p), ZERO_VEC),
      1 / n
    );
  }
  const sums = ring.reduce(
    (acc, p, i) => {
      const next = ring[(i + 1) % n];
      const cross = p.x * next.y - next.x * p.y;
      return {
        cx: acc.cx + (p.x + next.x) * cross,
        cy: acc.cy + (p.y + next.y) * cross,
      };
    },
    { cx: 0, cy: 0 }
  );
  const factor = 1 / (6 * signed);
  return { x: sums.cx * factor, y: sums.cy * factor };
};

/**
 * Point-in-polygon test via the standard PNPOLY crossing-number algorithm
 * (Franklin). Points exactly on an edge may return either result — the
 * generator only calls this for interior-sampling decisions where an edge
 * point is a measure-zero case.
 */
export const containsPoint = (ring: readonly Vec2[], point: Vec2): boolean => {
  const n = ring.length;
  if (n < 3) return false;
  return ring.reduce((inside, a, i) => {
    const b = ring[(i + 1) % n];
    const crosses = a.y > point.y !== b.y > point.y;
    if (!crosses) return inside;
    const xIntersect = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    return point.x < xIntersect ? !inside : inside;
  }, false);
};

const PARALLEL_OFFSET_EPSILON = 1e-9;

const lineIntersection = (p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 => {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < PARALLEL_OFFSET_EPSILON) {
    // Parallel offset edges have no unique intersection: split the difference
    // rather than divide by (near) zero.
    return scale(add(p1, p2), 0.5);
  }
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return add(p1, scale(d1, t));
};

/**
 * Inward inset of a CCW ring by `distance` metres: each edge is pushed along
 * its inward normal, and each new vertex is the intersection of the two
 * adjacent offset edge lines. Exact for convex rings (the blocks/lots this
 * generator produces are OBB-subdivision convex polygons); a concave ring can
 * self-intersect after a large enough inset, which this function does not
 * detect or repair.
 */
export const insetPolygon = (
  ring: readonly Vec2[],
  distance: number
): readonly Vec2[] => {
  const n = ring.length;
  if (n < 3) return ring;
  const offsetEdges = ring.map((point, i) => {
    const next = ring[(i + 1) % n];
    const dir = normalize(sub(next, point));
    return { dir, offsetPoint: add(point, scale(perp(dir), distance)) };
  });
  return ring.map((_, i) => {
    const prev = offsetEdges[(i - 1 + n) % n];
    const curr = offsetEdges[i];
    return lineIntersection(
      prev.offsetPoint,
      prev.dir,
      curr.offsetPoint,
      curr.dir
    );
  });
};

/** An infinite line given as a point on it plus a direction (need not be unit). */
export interface SplitLine {
  readonly point: Vec2;
  readonly dir: Vec2;
}

export interface PolygonSplit {
  /** The ring on the side where `cross(dir, p - point) >= 0`. */
  readonly positive: readonly Vec2[];
  /** The ring on the side where `cross(dir, p - point) <= 0`. */
  readonly negative: readonly Vec2[];
}

const SPLIT_SIDE_EPSILON = 1e-9;

const clipBySide = (
  ring: readonly Vec2[],
  sides: readonly number[],
  keepPositive: boolean
): readonly Vec2[] => {
  const n = ring.length;
  const keep = (s: number): boolean => (keepPositive ? s >= 0 : s <= 0);
  const out: Vec2[] = [];
  ring.forEach((curr, i) => {
    const prevIndex = (i - 1 + n) % n;
    const prev = ring[prevIndex];
    const prevSide = sides[prevIndex];
    const currSide = sides[i];
    const crossesEdge =
      (prevSide > 0 && currSide < 0) || (prevSide < 0 && currSide > 0);
    if (crossesEdge) {
      const t = prevSide / (prevSide - currSide);
      out.push(add(prev, scale(sub(curr, prev), t)));
    }
    if (keep(currSide)) out.push(curr);
  });
  return out;
};

/**
 * Splits a polygon by an infinite line into the two half-rings on either
 * side. Returns `null` when the line does not cross the polygon's interior:
 * every vertex lies on one side, within `SPLIT_SIDE_EPSILON`.
 */
export const splitPolygon = (
  ring: readonly Vec2[],
  line: SplitLine
): PolygonSplit | null => {
  const sideOf = (p: Vec2): number =>
    line.dir.x * (p.y - line.point.y) - line.dir.y * (p.x - line.point.x);
  const sides = ring.map(sideOf);
  const hasPositive = sides.some((s) => s > SPLIT_SIDE_EPSILON);
  const hasNegative = sides.some((s) => s < -SPLIT_SIDE_EPSILON);
  if (!hasPositive || !hasNegative) return null;
  return {
    positive: clipBySide(ring, sides, true),
    negative: clipBySide(ring, sides, false),
  };
};

const INTERIOR_SAMPLE_LERP = 0.5;

/**
 * Deterministic interior sample points: the centroid, plus `count` points
 * obtained by lerping from the centroid halfway toward vertices spaced
 * evenly around the ring (design doc §3 stage 8 samples "centroid + 4
 * interior points"). Assumes a convex ring, so the lerp point stays inside.
 */
export const samplePolygonInteriorPoints = (
  ring: readonly Vec2[],
  count: number
): readonly Vec2[] => {
  const center = centroid(ring);
  const n = ring.length;
  if (n === 0 || count <= 0) return [center];
  const satellites = Array.from({ length: count }, (_, i) => {
    const vertex = ring[Math.floor((i * n) / count) % n];
    return add(center, scale(sub(vertex, center), INTERIOR_SAMPLE_LERP));
  });
  return [center].concat(satellites);
};
