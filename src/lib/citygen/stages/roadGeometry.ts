import type { RoadGraph, Vec2 } from "@/entities/city";

/**
 * Reading segments back out of the pooled polyline coordinates.
 *
 * Zoning needs it to measure strip adjacency and buildings needs it to snap
 * casino frontages; both had an identical private copy, which is one edit away
 * from two stages disagreeing about what a road *is*.
 */
export const polylineSegments = (
  roads: RoadGraph,
  polylineIndex: number
): readonly (readonly [Vec2, Vec2])[] => {
  const start = roads.polylines.starts[polylineIndex];
  const end = roads.polylines.starts[polylineIndex + 1];
  const count = end - start;
  if (count < 2) return [];
  return Array.from({ length: count - 1 }, (_value, i) => {
    const a: Vec2 = {
      x: roads.polylines.coords[(start + i) * 2],
      y: roads.polylines.coords[(start + i) * 2 + 1],
    };
    const b: Vec2 = {
      x: roads.polylines.coords[(start + i + 1) * 2],
      y: roads.polylines.coords[(start + i + 1) * 2 + 1],
    };
    return [a, b] as const;
  });
};
