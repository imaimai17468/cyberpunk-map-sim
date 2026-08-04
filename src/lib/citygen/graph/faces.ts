import type { Vec2 } from "@/entities/city";

/**
 * Half-edge face traversal of a planar graph (design §3 stage 7 / §12).
 *
 * Given nodes and undirected edges, every edge becomes two directed
 * half-edges. Each node's outgoing half-edges are sorted into a cyclic
 * rotation by *pseudo-angle* — a comparison-only stand-in for the true
 * angle, built from a half-plane split plus a cross-product comparison, so
 * no `atan2` (or any transcendental) is ever called. Walking `next` around
 * that rotation traces every face of the embedding, outer faces included.
 * An outer face is identified by its reversed orientation — a negative
 * shoelace signed area — and there is one per connected component, so a
 * connected embedding has exactly one and it is also the largest by absolute
 * area, since it encloses everything the bounded faces partition. A graph in
 * several pieces has one per piece and no single largest; `isOuter` is
 * therefore the test to use, and `outerFaceIndex` names only the most
 * negative of them.
 *
 * `geometry/vec.ts` (owned by another concurrent agent) is deliberately not
 * imported here; the small vector/angle helpers below are local and will be
 * de-duplicated in a later integration pass.
 */

export interface FaceGraphNode {
  readonly id: number;
  readonly pos: Vec2;
}

export interface FaceGraphEdge {
  readonly id: number;
  readonly a: number;
  readonly b: number;
}

/**
 * @public the published shape of a traversed face; stage 7 consumes it to
 * seed subdivision, and tests assert against it directly.
 */
export interface Face {
  /** Node ids bounding the face, in traversal order. */
  readonly nodeIds: readonly number[];
  /** Edge ids walked to leave each `nodeIds[i]`, aligned with `nodeIds`. */
  readonly edgeIds: readonly number[];
  readonly signedArea: number;
  readonly isOuter: boolean;
}

export interface FaceTraversalResult {
  readonly faces: readonly Face[];
  readonly outerFaceIndex: number;
}

interface HalfEdge {
  readonly id: number;
  readonly edgeId: number;
  readonly from: number;
  readonly to: number;
}

interface RotationPosition {
  readonly idx: number;
  readonly total: number;
}

/**
 * Which half-plane a direction vector falls in, for pseudo-angle sorting.
 *
 * The zero vector gets class 2 — its own, ordered after both real half-planes —
 * rather than falling into half 0 with the directions pointing up and right.
 * Sharing a class with real directions is what made `comparePseudoAngle`
 * non-transitive, and non-transitivity is not a cosmetic defect here: an
 * inconsistent comparator makes `Array.prototype.sort` implementation-defined,
 * so the rotation, the faces walked from it, and every stage downstream of
 * `blocks` came out different on different engines.
 *
 * Measured on `akiba-02` at the golden parameters, before this class existed:
 * node 28 carried two self-loop half-edges at (0, 0) next to three real ones,
 * the group admitted twelve violating ordered triples, and half-edges 149, 151
 * (a self-loop) and 152 ordered 149 < 151 < 152 < 149. `generateCity` then
 * returned content hash `ecf932279c0da1a6` under vitest and
 * `f371616bf0c27639` under bun for that one seed, diverging first at the
 * `blocks` stage hash while `terrain` through `arterials` matched exactly.
 *
 * A zero vector has no angle, so any position for it is arbitrary; what matters
 * is that it holds still and stops dragging the real directions out of order.
 * `blocks.ts` drops the self-loop edges that produced the measured case, but this
 * class is not made redundant by that: two *distinct* nodes resolving to one
 * position hand the sort a zero vector without being a self-loop, and the sort
 * has to be a total order for whatever it is handed rather than for what one
 * caller currently sends.
 */
const half = (dx: number, dy: number): 0 | 1 | 2 =>
  dx === 0 && dy === 0 ? 2 : dy < 0 || (dy === 0 && dx < 0) ? 1 : 0;

/**
 * Compares two direction vectors by pseudo-angle: first by half-plane, then
 * by the sign of their cross product within a half-plane. This orders
 * vectors identically to sorting by true angle around the origin, without
 * computing an angle at all (no `atan2`, no division, no trig).
 *
 * A strict weak ordering for every input, zero vectors included — which is what
 * `Array.prototype.sort` requires to be deterministic at all: "if comparefn ... is
 * not a consistent comparison function for the elements of the array, the
 * behaviour of sort is implementation-defined", and transitivity is one of the
 * properties consistency requires
 * (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort).
 * Stability, guaranteed since ES2019, does not help: it fixes what happens to
 * elements the comparator calls equal, not what happens when it contradicts itself.
 *
 * Within a class the cross-product comparison is a total order because each real
 * class spans a half-open 180 degrees, so the angle difference between any two of
 * its members stays inside (-180, 180) and the cross product's sign tracks it.
 */
export const comparePseudoAngle = (
  ax: number,
  ay: number,
  bx: number,
  by: number
): number => {
  const ha = half(ax, ay);
  const hb = half(bx, by);
  if (ha !== hb) return ha - hb;
  const cross = ax * by - ay * bx;
  return cross > 0 ? -1 : cross < 0 ? 1 : 0;
};

const buildHalfEdges = (edges: readonly FaceGraphEdge[]): readonly HalfEdge[] =>
  edges.flatMap((edge, i) => [
    { id: i * 2, edgeId: edge.id, from: edge.a, to: edge.b },
    { id: i * 2 + 1, edgeId: edge.id, from: edge.b, to: edge.a },
  ]);

const buildPosIndex = (
  nodes: readonly FaceGraphNode[]
): ReadonlyMap<number, Vec2> => {
  const posById = new Map<number, Vec2>();
  nodes.forEach((node) => posById.set(node.id, node.pos));
  return posById;
};

const requireFrom = <K, V>(map: ReadonlyMap<K, V>, key: K, what: string): V => {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`faces: ${what} not found for key ${String(key)}`);
  }
  return value;
};

/**
 * Groups half-edges by their `from` node and sorts each group into a cyclic
 * rotation by pseudo-angle (ties broken by the target node id, then the edge
 * id, so ordering is deterministic even for coincident directions).
 */
const groupSortedByFrom = (
  halfEdges: readonly HalfEdge[],
  posById: ReadonlyMap<number, Vec2>
): ReadonlyMap<number, readonly HalfEdge[]> => {
  const byFrom = new Map<number, HalfEdge[]>();
  halfEdges.forEach((he) => {
    const list = byFrom.get(he.from);
    if (list) {
      list.push(he);
    } else {
      byFrom.set(he.from, [he]);
    }
  });
  byFrom.forEach((list, fromId) => {
    const fromPos = requireFrom(posById, fromId, "node position");
    list.sort((h1, h2) => {
      const p1 = requireFrom(posById, h1.to, "node position");
      const p2 = requireFrom(posById, h2.to, "node position");
      const angleCompare = comparePseudoAngle(
        p1.x - fromPos.x,
        p1.y - fromPos.y,
        p2.x - fromPos.x,
        p2.y - fromPos.y
      );
      if (angleCompare !== 0) return angleCompare;
      return h1.to !== h2.to ? h1.to - h2.to : h1.edgeId - h2.edgeId;
    });
  });
  return byFrom;
};

const buildRotationIndex = (
  sortedByFrom: ReadonlyMap<number, readonly HalfEdge[]>
): ReadonlyMap<number, RotationPosition> => {
  const positionInRotation = new Map<number, RotationPosition>();
  sortedByFrom.forEach((list) => {
    list.forEach((he, idx) => {
      positionInRotation.set(he.id, { idx, total: list.length });
    });
  });
  return positionInRotation;
};

interface RotationContext {
  readonly halfEdgeById: ReadonlyMap<number, HalfEdge>;
  readonly sortedByFrom: ReadonlyMap<number, readonly HalfEdge[]>;
  readonly positionInRotation: ReadonlyMap<number, RotationPosition>;
}

/**
 * The next half-edge continuing the same face boundary as `heId`: rotate to
 * the twin at the arrival node, then step one place clockwise (the entry
 * immediately preceding the twin in its node's CCW pseudo-angle rotation).
 */
const nextOf = (heId: number, ctx: RotationContext): number => {
  const he = requireFrom(ctx.halfEdgeById, heId, "half-edge");
  const twinId = heId ^ 1;
  const rotation = requireFrom(ctx.sortedByFrom, he.to, "rotation");
  const twinPos = requireFrom(
    ctx.positionInRotation,
    twinId,
    "rotation position"
  );
  const prevIndex = (twinPos.idx - 1 + twinPos.total) % twinPos.total;
  return rotation[prevIndex].id;
};

const walkFace = (startId: number, ctx: RotationContext): readonly number[] => {
  const cycle: number[] = [];
  const step = (currentId: number): void => {
    cycle.push(currentId);
    const nxt = nextOf(currentId, ctx);
    if (nxt !== startId) step(nxt);
  };
  step(startId);
  return cycle;
};

const collectFaceCycles = (
  halfEdges: readonly HalfEdge[],
  ctx: RotationContext
): readonly (readonly number[])[] => {
  const visited = new Set<number>();
  const cycles: (readonly number[])[] = [];
  halfEdges.forEach((he) => {
    if (visited.has(he.id)) return;
    const cycle = walkFace(he.id, ctx);
    cycle.forEach((id) => visited.add(id));
    cycles.push(cycle);
  });
  return cycles;
};

const signedAreaOf = (vertices: readonly Vec2[]): number => {
  const n = vertices.length;
  const doubled = vertices.reduce((sum, v, i) => {
    const next = vertices[(i + 1) % n];
    return sum + (v.x * next.y - next.x * v.y);
  }, 0);
  return doubled / 2;
};

const toFace = (
  cycle: readonly number[],
  halfEdgeById: ReadonlyMap<number, HalfEdge>,
  posById: ReadonlyMap<number, Vec2>
): Face => {
  const nodeIds = cycle.map(
    (heId) => requireFrom(halfEdgeById, heId, "half-edge").from
  );
  const edgeIds = cycle.map(
    (heId) => requireFrom(halfEdgeById, heId, "half-edge").edgeId
  );
  const vertices = nodeIds.map((id) =>
    requireFrom(posById, id, "node position")
  );
  return {
    nodeIds,
    edgeIds,
    signedArea: signedAreaOf(vertices),
    isOuter: false,
  };
};

/**
 * Flags every reversed face as outer, which is one per connected component.
 *
 * It used to flag only the most negative one. That is correct for a connected
 * embedding and wrong for any other: the walk visits each component separately
 * and each hands back its own boundary reversed, so with two components one
 * reversed boundary was left looking like an ordinary face. `blocks.ts` unions
 * the map border into the arterial graph without joining them, so an arterial
 * loop reaching no border edge is exactly that second component, and its
 * boundary became a block — inside-out, and subdivision preserves orientation,
 * so its leaves were inside-out too. Re-measured 2026-08-04 after the self-loop
 * fix, counting the blocks `blocks.ts` rejects as `inside-out-block`: four on
 * `akiba-01` at 512 cells, one on `akiba-02`, and four, one and two across the
 * three seeds at 256 cells. None at the golden parameters — `akiba-02`'s one there
 * was a leaf of the rotation the self-loop had scrambled, so it went with it.
 *
 * `outerFaceIndex` still names the most negative face, which for a connected
 * embedding is the same answer it always gave.
 */
const withOuterFlag = (faces: readonly Face[]): FaceTraversalResult => {
  const outerFaceIndex = faces.reduce(
    (bestIndex, face, index) =>
      face.signedArea < faces[bestIndex].signedArea ? index : bestIndex,
    0
  );
  return {
    faces: faces.map((face) => ({
      ...face,
      isOuter: face.signedArea < 0,
    })),
    outerFaceIndex,
  };
};

/**
 * Traces every face of the planar graph formed by `nodes` and undirected
 * `edges`, outer faces included — each identified by its negative signed area
 * and flagged `isOuter`, one per connected component.
 */
export const traverseFaces = (
  nodes: readonly FaceGraphNode[],
  edges: readonly FaceGraphEdge[]
): FaceTraversalResult => {
  const posById = buildPosIndex(nodes);
  const halfEdges = buildHalfEdges(edges);
  const sortedByFrom = groupSortedByFrom(halfEdges, posById);
  const positionInRotation = buildRotationIndex(sortedByFrom);
  const halfEdgeById = new Map<number, HalfEdge>();
  halfEdges.forEach((he) => halfEdgeById.set(he.id, he));
  const ctx: RotationContext = {
    halfEdgeById,
    sortedByFrom,
    positionInRotation,
  };
  const cycles = collectFaceCycles(halfEdges, ctx);
  const faces = cycles.map((cycle) => toFace(cycle, halfEdgeById, posById));
  return withOuterFlag(faces);
};
