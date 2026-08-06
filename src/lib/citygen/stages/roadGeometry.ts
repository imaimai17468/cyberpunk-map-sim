import type { RoadClass, RoadEdge, RoadGraph, Vec2 } from "@/entities/city";

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

/**
 * The graph with straight two-vertex roads of one class appended.
 *
 * Every stage after `arterials` grows the network the same way — the block
 * subdivision publishes its cuts as streets, the lot subdivision publishes
 * some of its cuts as alleys — and both mean the same three things by it: new
 * ids continue the existing numbering, new polylines continue the pool, and
 * the segments join no arterial node, which is what the contract's `-1`
 * endpoints say.
 *
 * The pool arithmetic is the part worth having in one place. `starts` holds one
 * more entry than there are polylines, so appending a road means appending
 * *its end*, and a two-vertex segment advances that end by two. Getting it
 * wrong does not throw; it silently reassigns every road's geometry to its
 * neighbour.
 */
export const appendSegmentRoads = (
  base: RoadGraph,
  segments: readonly (readonly [Vec2, Vec2])[],
  cls: RoadClass
): RoadGraph => {
  const idBase =
    base.edges.reduce((max, edge) => Math.max(max, edge.id), -1) + 1;
  const polylineBase = base.polylines.starts.length - 1;
  const vertexBase = base.polylines.coords.length / 2;
  const edges: readonly RoadEdge[] = segments.map((_segment, i) => ({
    id: idBase + i,
    a: -1,
    b: -1,
    cls,
    crossing: "none",
    polylineIndex: polylineBase + i,
    strip: false,
  }));
  return {
    nodes: base.nodes,
    edges: [...base.edges, ...edges],
    polylines: {
      coords: Float32Array.from([
        ...base.polylines.coords,
        ...segments.flatMap(([a, b]) => [a.x, a.y, b.x, b.y]),
      ]),
      starts: Uint32Array.from([
        ...base.polylines.starts,
        ...segments.map((_segment, i) => vertexBase + (i + 1) * 2),
      ]),
    },
  };
};
