import type { Vec2 } from "@/entities/city";
import { add, cross, dot, lengthSq, scale, sub } from "./vec";

/**
 * Exact segment-segment intersection, plus a spatial-hash bucketing helper
 * for generating candidate pairs before the exact test — design doc §3
 * stage 6 planarizes only the ~10-14 arterial polylines this way, so the
 * candidate set only needs to avoid missing a true intersection, not be
 * minimal.
 */

/**
 * @public the const array backing the union below; exported so a caller can
 * enumerate the outcomes and so a new kind fails to compile until handled.
 */
export const SEGMENT_INTERSECTION_KINDS = [
  "none",
  "point",
  "collinear",
] as const;
/** @public published domain vocabulary: consumers narrow on this union even where the first slice does not, and it is the name a new member is added to */
export type SegmentIntersectionKind =
  (typeof SEGMENT_INTERSECTION_KINDS)[number];

export type SegmentIntersection =
  | { readonly kind: "none" }
  | { readonly kind: "point"; readonly point: Vec2 }
  | {
      readonly kind: "collinear";
      readonly overlapStart: Vec2;
      readonly overlapEnd: Vec2;
    };

const PARALLEL_EPSILON = 1e-9;

/**
 * Exact intersection of segment `a1-a2` with segment `b1-b2`, via the
 * standard cross-product parametrisation. Distinguishes a single crossing
 * point from an overlapping collinear run, and reports "none" for both a
 * genuine miss and a non-overlapping collinear pair.
 */
export const segmentIntersection = (
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2
): SegmentIntersection => {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const denom = cross(r, s);
  const qp = sub(b1, a1);
  if (Math.abs(denom) > PARALLEL_EPSILON) {
    const t = cross(qp, s) / denom;
    const u = cross(qp, r) / denom;
    const withinA = t >= 0 && t <= 1;
    const withinB = u >= 0 && u <= 1;
    return withinA && withinB
      ? { kind: "point", point: add(a1, scale(r, t)) }
      : { kind: "none" };
  }
  const crossQpR = cross(qp, r);
  if (Math.abs(crossQpR) > PARALLEL_EPSILON) return { kind: "none" };
  const rLenSq = lengthSq(r);
  if (rLenSq < PARALLEL_EPSILON) return { kind: "none" };
  const t0 = dot(qp, r) / rLenSq;
  const t1 = dot(add(qp, s), r) / rLenSq;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const overlapLo = Math.max(0, lo);
  const overlapHi = Math.min(1, hi);
  return overlapLo > overlapHi
    ? { kind: "none" }
    : {
        kind: "collinear",
        overlapStart: add(a1, scale(r, overlapLo)),
        overlapEnd: add(a1, scale(r, overlapHi)),
      };
};

/** A segment tagged with a stable index, so candidate pairs can name their source segments. */
export interface IndexedSegment {
  readonly index: number;
  readonly a: Vec2;
  readonly b: Vec2;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * Every grid cell touched by `segment`'s axis-aligned bounding box. This
 * over-buckets a diagonal segment relative to the cells it actually crosses,
 * trading a few extra (harmless) candidate pairs for a bucketing pass with
 * no per-segment traversal loop.
 */
const segmentCells = (
  segment: IndexedSegment,
  bucketSizeM: number
): readonly string[] => {
  const minX = Math.min(segment.a.x, segment.b.x);
  const maxX = Math.max(segment.a.x, segment.b.x);
  const minY = Math.min(segment.a.y, segment.b.y);
  const maxY = Math.max(segment.a.y, segment.b.y);
  const cxStart = Math.floor(minX / bucketSizeM);
  const cxEnd = Math.floor(maxX / bucketSizeM);
  const cyStart = Math.floor(minY / bucketSizeM);
  const cyEnd = Math.floor(maxY / bucketSizeM);
  const xs = Array.from({ length: cxEnd - cxStart + 1 }, (_, i) => cxStart + i);
  const ys = Array.from({ length: cyEnd - cyStart + 1 }, (_, i) => cyStart + i);
  return xs.flatMap((cx) => ys.map((cy) => cellKey(cx, cy)));
};

const buildBuckets = (
  segments: readonly IndexedSegment[],
  bucketSizeM: number
): ReadonlyMap<string, readonly number[]> =>
  segments.reduce<Map<string, number[]>>((buckets, segment) => {
    segmentCells(segment, bucketSizeM).forEach((key) => {
      const existing = buckets.get(key);
      if (existing) {
        existing.push(segment.index);
      } else {
        buckets.set(key, [segment.index]);
      }
    });
    return buckets;
  }, new Map());

/**
 * `i < j` always holds here: `buildBuckets` pushes each segment's index into
 * its buckets while folding over `segments` in order, so every bucket's
 * index list is already ascending, and `candidateSegmentPairs` only ever
 * pairs an earlier `i` with a later `j` from that same ascending list.
 */
const pairKey = (i: number, j: number): string => `${i}:${j}`;

/**
 * Candidate segment-index pairs that share a spatial-hash bucket of size
 * `bucketSizeM` metres. Each unordered pair is yielded exactly once, even
 * when the two segments share more than one bucket. This is a candidate
 * generator, not a proof of intersection — callers still run
 * `segmentIntersection` on each pair.
 */
export const candidateSegmentPairs = (
  segments: readonly IndexedSegment[],
  bucketSizeM: number
): readonly (readonly [number, number])[] => {
  const buckets = buildBuckets(segments, bucketSizeM);
  const seen = new Set<string>();
  const pairs: (readonly [number, number])[] = [];
  Array.from(buckets.values()).forEach((indices) => {
    indices.forEach((i, offset) => {
      indices.slice(offset + 1).forEach((j) => {
        const key = pairKey(i, j);
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push([i, j]);
        }
      });
    });
  });
  return pairs;
};
