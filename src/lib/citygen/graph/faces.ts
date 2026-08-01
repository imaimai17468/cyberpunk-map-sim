import type { Vec2 } from "@/entities/city";

/**
 * Half-edge face traversal of a planar graph (design §3 stage 7 / §12).
 *
 * Given nodes and undirected edges, every edge becomes two directed
 * half-edges. Each node's outgoing half-edges are sorted into a cyclic
 * rotation by *pseudo-angle* — a comparison-only stand-in for the true
 * angle, built from a half-plane split plus a cross-product comparison, so
 * no `atan2` (or any transcendental) is ever called. Walking `next` around
 * that rotation traces every face of the embedding, including exactly one
 * outer (unbounded) face, which is identified by its reversed orientation:
 * the single face whose shoelace signed area is negative — and, for a
 * connected embedding, therefore also the largest by absolute area, since it
 * encloses everything the bounded faces partition.
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

/** Which half-plane a direction vector falls in, for pseudo-angle sorting. */
const half = (dx: number, dy: number): 0 | 1 =>
  dy < 0 || (dy === 0 && dx < 0) ? 1 : 0;

/**
 * Compares two direction vectors by pseudo-angle: first by half-plane, then
 * by the sign of their cross product within a half-plane. This orders
 * vectors identically to sorting by true angle around the origin, without
 * computing an angle at all (no `atan2`, no division, no trig).
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

const withOuterFlag = (faces: readonly Face[]): FaceTraversalResult => {
  const outerFaceIndex = faces.reduce(
    (bestIndex, face, index) =>
      face.signedArea < faces[bestIndex].signedArea ? index : bestIndex,
    0
  );
  return {
    faces: faces.map((face, index) => ({
      ...face,
      isOuter: index === outerFaceIndex,
    })),
    outerFaceIndex,
  };
};

/**
 * Traces every face of the planar graph formed by `nodes` and undirected
 * `edges`, including the single outer (unbounded) face — identified by its
 * negative signed area, which is also the largest by absolute magnitude for
 * a connected embedding.
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
