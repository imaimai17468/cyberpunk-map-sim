import type { RoadGraph, Vec2 } from "@/entities/city";

/**
 * Reading segments back out of the pooled polyline coordinates.
 *
 * Zoning needs it to measure strip adjacency and buildings needs it to snap
 * casino frontages; both had an identical private copy, which is one edit away
 * from two stages disagreeing about what a road *is*.
 */
/**
 * The polyline's own vertices, in order.
 *
 * `polylineSegments` below drops the fact that consecutive segments share a
 * vertex, which is all most callers need. Anything giving a road width needs
 * the vertex back: that is where the road turns, and a turn is the one place
 * two segment quads do not meet.
 */
export const polylinePoints = (
  roads: RoadGraph,
  polylineIndex: number
): readonly Vec2[] => {
  const start = roads.polylines.starts[polylineIndex];
  const end = roads.polylines.starts[polylineIndex + 1];
  const count = end - start;
  if (count < 2) return [];
  return Array.from({ length: count }, (_value, i) => ({
    x: roads.polylines.coords[(start + i) * 2],
    y: roads.polylines.coords[(start + i) * 2 + 1],
  }));
};

export const polylineSegments = (
  roads: RoadGraph,
  polylineIndex: number
): readonly (readonly [Vec2, Vec2])[] => {
  const points = polylinePoints(roads, polylineIndex);
  return points.slice(0, -1).map((a, i) => [a, points[i + 1]] as const);
};
