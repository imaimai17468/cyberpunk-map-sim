import type { Vec2 } from "@/entities/city";
import { cross, length, sub } from "./vec";

/**
 * Douglas-Peucker polyline simplification. Recursion here splits a range in
 * two at each step (never one-per-point), so worst-case depth is the number
 * of points on the input polyline — design doc §12 puts that at ≤ ~1,500 for
 * this generator's road polylines, comfortably inside the ~9,765-frame limit.
 */

const DP_DEGENERATE_EPSILON = 1e-9;

const perpendicularDistance = (point: Vec2, a: Vec2, b: Vec2): number => {
  const ab = sub(b, a);
  const abLength = length(ab);
  if (abLength < DP_DEGENERATE_EPSILON) return length(sub(point, a));
  return Math.abs(cross(ab, sub(point, a))) / abLength;
};

const simplifyRange = (
  points: readonly Vec2[],
  start: number,
  end: number,
  epsilon: number
): readonly Vec2[] => {
  if (end - start < 2) return [points[start], points[end]];
  const a = points[start];
  const b = points[end];
  const farthest = points
    .slice(start + 1, end)
    .map((point, offset) => ({
      index: start + 1 + offset,
      dist: perpendicularDistance(point, a, b),
    }))
    .reduce((best, curr) => (curr.dist > best.dist ? curr : best));
  if (farthest.dist <= epsilon) return [a, b];
  const left = simplifyRange(points, start, farthest.index, epsilon);
  const right = simplifyRange(points, farthest.index, end, epsilon);
  return left.slice(0, -1).concat(right);
};

/**
 * Simplifies `points` to within perpendicular distance `epsilon` of the
 * simplified segments, keeping the first and last point always. Fewer than
 * three points is returned unchanged — there is nothing to simplify.
 */
export const douglasPeucker = (
  points: readonly Vec2[],
  epsilon: number
): readonly Vec2[] => {
  if (points.length < 3) return points;
  return simplifyRange(points, 0, points.length - 1, epsilon);
};
