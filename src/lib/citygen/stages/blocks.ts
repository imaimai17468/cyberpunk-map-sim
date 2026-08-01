import type {
  BoundaryRef,
  Field2D,
  PolygonPool,
  RoadEdge,
  RoadGraph,
  TerrainLayer,
  Vec2,
} from "@/entities/city";
import { BLOCKS } from "../constants";
import { bilinearSample } from "../field/field2d";
import {
  type FaceGraphEdge,
  type FaceGraphNode,
  traverseFaces,
} from "../graph/faces";
import { minimumAreaObb } from "../geometry/hull";
import {
  area,
  centroid,
  samplePolygonInteriorPoints,
  splitPolygon,
} from "../geometry/polygon";
import {
  blendLineTensors,
  directionFromLineTensor,
  dot,
  lineTensorMagnitude,
  normalize,
  perp,
  randomUnitVector,
  sub,
  toLineTensor,
} from "../geometry/vec";
import type { RngStream } from "../rng/types";
import type {
  BlockLayer,
  DerivedFields,
  Grid,
  RawBlock,
  SocialFields,
} from "./types";

/**
 * Stage 7: arterial faces in, blocks out.
 *
 * This is the stage that replaced streamline tracing (ADR-0027). Regions come
 * from walking the faces of the arterial graph; blocks come from recursively
 * cutting each region along the orientation field. Streets are therefore cut
 * segments of a subdivision tree and intersect nothing by construction, so no
 * dense graph is ever planarized or face-walked.
 *
 * Termination is not incidental. Every cut passes through the region's OBB
 * centre, and a cut too parallel to the long axis is replaced by the
 * perpendicular one, so each child is strictly smaller than its parent and the
 * recursion bottoms out at the target area. Depth is logarithmic in the area
 * ratio — roughly 14 at the default extent, far under the ~9,765-frame stack.
 */

export interface BlocksInput {
  readonly grid: Grid;
  readonly terrain: TerrainLayer;
  readonly derived: DerivedFields;
  readonly social: SocialFields;
  readonly roads: RoadGraph;
}

/** How close a point must be to the cut line to count as lying on it. */
const ON_CUT_EPSILON_M = 1e-6;

/** Interior samples used to classify a block as water and to read the fields. */
const BLOCK_SAMPLE_COUNT = 5;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const sampleField = (field: Field2D, p: Vec2): number =>
  bilinearSample(field, p.x, p.y);

/**
 * The four map corners plus the four border edges, unioned with the arterial
 * graph so the outermost regions are closed rather than unbounded.
 */
// similarity-ignore: borderGraph fabricates the map rectangle and buildFaceGraph unions it with the arterials; they share a return shape because both feed traverseFaces, not because they do the same thing.
const borderGraph = (
  grid: Grid,
  nodeIdBase: number,
  edgeIdBase: number
): { nodes: readonly FaceGraphNode[]; edges: readonly FaceGraphEdge[] } => {
  const s = grid.sizeM;
  const corners: readonly Vec2[] = [
    { x: 0, y: 0 },
    { x: s, y: 0 },
    { x: s, y: s },
    { x: 0, y: s },
  ];
  const nodes = corners.map((pos, i) => ({ id: nodeIdBase + i, pos }));
  const edges = corners.map((_unused, i) => ({
    id: edgeIdBase + i,
    a: nodeIdBase + i,
    b: nodeIdBase + ((i + 1) % 4),
  }));
  return { nodes, edges };
};

/** Arterial nodes and edges, plus the border rectangle. */
const buildFaceGraph = (
  roads: RoadGraph,
  grid: Grid
): { nodes: readonly FaceGraphNode[]; edges: readonly FaceGraphEdge[] } => {
  const arterialNodes = roads.nodes.map((n) => ({ id: n.id, pos: n.pos }));
  const arterialEdges = roads.edges
    .filter((e) => e.a >= 0 && e.b >= 0)
    .map((e) => ({ id: e.id, a: e.a, b: e.b }));
  const nodeIdBase = arterialNodes.reduce((m, n) => Math.max(m, n.id), -1) + 1;
  const edgeIdBase = arterialEdges.reduce((m, e) => Math.max(m, e.id), -1) + 1;
  const border = borderGraph(grid, nodeIdBase, edgeIdBase);
  return {
    nodes: [...arterialNodes, ...border.nodes],
    edges: [...arterialEdges, ...border.edges],
  };
};

/**
 * The blended orientation at a point, as a line tensor.
 *
 * Three influences, each in 2-theta space so that opposite directions are the
 * same line: the per-seed CBD grid weighted by centrality, the terrain contour
 * (elevation gradient rotated 90 degrees) weighted by steepness, and the shore
 * weighted by nearness to water. Blending in tensor space is what stops a grid
 * pointing "north" and one pointing "south" from cancelling.
 */
const orientationTensorAt = (
  p: Vec2,
  input: BlocksInput,
  cbdDirection: Vec2
) => {
  const { derived, social, terrain } = input;
  const centrality = clamp01(sampleField(social.centrality, p));
  const slope = sampleField(derived.slope, p);
  const distWater = sampleField(derived.distWater, p);

  const cell = terrain.elevation.cellSizeM;
  const elevationGradient: Vec2 = {
    x:
      (sampleField(terrain.elevation, { x: p.x + cell, y: p.y }) -
        sampleField(terrain.elevation, { x: p.x - cell, y: p.y })) /
      (2 * cell),
    y:
      (sampleField(terrain.elevation, { x: p.x, y: p.y + cell }) -
        sampleField(terrain.elevation, { x: p.x, y: p.y - cell })) /
      (2 * cell),
  };
  const waterGradient: Vec2 = {
    x:
      (sampleField(derived.distWater, { x: p.x + cell, y: p.y }) -
        sampleField(derived.distWater, { x: p.x - cell, y: p.y })) /
      (2 * cell),
    y:
      (sampleField(derived.distWater, { x: p.x, y: p.y + cell }) -
        sampleField(derived.distWater, { x: p.x, y: p.y - cell })) /
      (2 * cell),
  };

  const contour = normalize(perp(elevationGradient), { x: 1, y: 0 });
  const shore = normalize(perp(waterGradient), { x: 1, y: 0 });

  return blendLineTensors([
    {
      tensor: toLineTensor(cbdDirection),
      weight: centrality * Math.sqrt(centrality),
    },
    {
      tensor: toLineTensor(contour),
      weight: clamp01((slope - 0.12) / 0.13),
    },
    {
      tensor: toLineTensor(shore),
      weight: Math.max(0, 1 - distWater / 300),
    },
  ]);
};

/** Blocks get smaller toward the dense, valuable, and decayed parts of the map. */
const targetBlockAreaAt = (p: Vec2, social: SocialFields): number => {
  const intensity = clamp01(
    BLOCKS.urbanIntensity.centrality *
      clamp01(sampleField(social.centrality, p)) +
      BLOCKS.urbanIntensity.prestige *
        clamp01(sampleField(social.prestige, p)) +
      BLOCKS.urbanIntensity.decay * clamp01(sampleField(social.decay, p))
  );
  return (
    BLOCKS.maxBlockAreaM2 +
    (BLOCKS.minBlockAreaM2 - BLOCKS.maxBlockAreaM2) * intensity
  );
};

interface Leaf {
  readonly ring: readonly Vec2[];
  /** One entry per ring edge: `edgeRefs[i]` describes `ring[i] -> ring[i+1]`. */
  readonly edgeRefs: readonly BoundaryRef[];
}

interface CutContext {
  readonly input: BlocksInput;
  readonly cbdDirection: Vec2;
  readonly stream: RngStream;
  /** Mutable only inside this stage; hands out one id per cut. */
  readonly nextCutId: { value: number };
}

const ringEdges = (ring: readonly Vec2[]): readonly (readonly [Vec2, Vec2])[] =>
  ring.map((v, i) => [v, ring[(i + 1) % ring.length]] as const);

const signedDistanceToCut = (p: Vec2, point: Vec2, dir: Vec2): number =>
  dir.x * (p.y - point.y) - dir.y * (p.x - point.x);

/** Perpendicular distance from a point to a segment, for provenance matching. */
const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < ON_CUT_EPSILON_M) return Math.sqrt(dot(sub(p, a), sub(p, a)));
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
  const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return Math.sqrt(dot(sub(p, closest), sub(p, closest)));
};

/**
 * Provenance for each edge of a child ring.
 *
 * An edge whose endpoints both sit on the cut line *is* the cut, and carries
 * its id — that id is what makes adjacency exact later, since two blocks are
 * neighbours precisely when they share one. Every other edge is a fragment of
 * some parent edge and inherits its provenance, matched by containment of the
 * fragment's midpoint rather than by any global proximity search.
 */
const inheritEdgeRefs = (
  child: readonly Vec2[],
  parent: readonly Vec2[],
  parentRefs: readonly BoundaryRef[],
  cutPoint: Vec2,
  cutDir: Vec2,
  cutId: number
): readonly BoundaryRef[] => {
  const parentEdges = ringEdges(parent);
  return ringEdges(child).map(([a, b]) => {
    const onCut =
      Math.abs(signedDistanceToCut(a, cutPoint, cutDir)) < ON_CUT_EPSILON_M &&
      Math.abs(signedDistanceToCut(b, cutPoint, cutDir)) < ON_CUT_EPSILON_M;
    if (onCut) return { kind: "cut", refId: cutId } as const;

    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const best = parentEdges.reduce<{ index: number; distance: number }>(
      (acc, [pa, pb], index) => {
        const distance = distanceToSegment(mid, pa, pb);
        return distance < acc.distance ? { index, distance } : acc;
      },
      { index: -1, distance: Number.POSITIVE_INFINITY }
    );
    return best.index >= 0 && parentRefs[best.index] !== undefined
      ? parentRefs[best.index]
      : ({ kind: "cut", refId: cutId } as const);
  });
};

const cutDirectionFor = (
  ring: readonly Vec2[],
  centre: Vec2,
  longAxis: Vec2,
  ctx: CutContext,
  decay: number
): Vec2 => {
  const tensor = orientationTensorAt(centre, ctx.input, ctx.cbdDirection);
  const degenerate =
    lineTensorMagnitude(tensor) < BLOCKS.degenerateTensorMagnitude;
  // The fallback is explicit rather than incidental: an unspecified degenerate
  // branch was a named flaw in the rejected design.
  const base = degenerate ? perp(longAxis) : directionFromLineTensor(tensor);

  const tangled =
    decay > BLOCKS.slumTangleDecay
      ? normalize(
          {
            x:
              base.x * (1 - BLOCKS.slumTangleBlend) +
              randomUnitVector(ctx.stream.next(), ctx.stream.next() < 0.5).x *
                BLOCKS.slumTangleBlend,
            y:
              base.y * (1 - BLOCKS.slumTangleBlend) +
              randomUnitVector(ctx.stream.next(), ctx.stream.next() < 0.5).y *
                BLOCKS.slumTangleBlend,
          },
          base
        )
      : base;

  // A cut nearly parallel to the long axis would barely reduce area, so flip it
  // perpendicular. This is what guarantees the recursion terminates.
  return Math.abs(dot(tangled, longAxis)) > BLOCKS.maxCutLongAxisDot
    ? perp(longAxis)
    : tangled;
};

const subdivide = (
  ring: readonly Vec2[],
  edgeRefs: readonly BoundaryRef[],
  depth: number,
  ctx: CutContext
): readonly Leaf[] => {
  const ringArea = area(ring);
  if (ring.length < 3 || ringArea <= 0) return [];
  // Backstop: stop descending rather than overflow the stack if the shrink
  // argument ever fails to hold for an unusual face.
  if (depth >= BLOCKS.maxSubdivideDepth) return [{ ring, edgeRefs }];

  const centre = centroid(ring);
  const target = targetBlockAreaAt(centre, ctx.input.social);
  if (ringArea <= target) return [{ ring, edgeRefs }];

  const obb = minimumAreaObb(ring);
  const longAxis = obb.w >= obb.d ? obb.facing : perp(obb.facing);
  const decay = clamp01(sampleField(ctx.input.social.decay, centre));
  const dir = cutDirectionFor(ring, centre, longAxis, ctx, decay);

  // Offset the cut off-centre so blocks are not all identical halves.
  const t =
    BLOCKS.cutOffsetLo +
    (BLOCKS.cutOffsetHi - BLOCKS.cutOffsetLo) * ctx.stream.next();
  const halfSpan = (obb.w >= obb.d ? obb.w : obb.d) / 2;
  const offsetPoint = {
    x: obb.cx + perp(dir).x * (t - 0.5) * halfSpan,
    y: obb.cy + perp(dir).y * (t - 0.5) * halfSpan,
  };

  const split = splitPolygon(ring, { point: offsetPoint, dir });
  if (split === null) return [{ ring, edgeRefs }];

  const cutId = ctx.nextCutId.value;
  ctx.nextCutId.value += 1;

  const refsFor = (child: readonly Vec2[]): readonly BoundaryRef[] =>
    inheritEdgeRefs(child, ring, edgeRefs, offsetPoint, dir, cutId);

  return [
    ...subdivide(split.positive, refsFor(split.positive), depth + 1, ctx),
    ...subdivide(split.negative, refsFor(split.negative), depth + 1, ctx),
  ];
};

const isWaterBlock = (ring: readonly Vec2[], input: BlocksInput): boolean => {
  const samples = samplePolygonInteriorPoints(ring, BLOCK_SAMPLE_COUNT);
  const wet = samples.filter((p) => {
    const cells = input.terrain.elevation.cells;
    const cx = Math.min(
      cells - 1,
      Math.max(0, Math.floor(p.x / input.terrain.elevation.cellSizeM))
    );
    const cy = Math.min(
      cells - 1,
      Math.max(0, Math.floor(p.y / input.terrain.elevation.cellSizeM))
    );
    return input.terrain.waterMask[cy * cells + cx] !== 0;
  }).length;
  return wet / samples.length >= BLOCKS.waterBlockFraction;
};

const poolOf = (rings: readonly (readonly Vec2[])[]): PolygonPool => {
  const total = rings.reduce((sum, r) => sum + r.length, 0);
  const coords = new Float32Array(total * 2);
  const starts = new Uint32Array(rings.length + 1);
  rings.reduce((offset, ring, i) => {
    starts[i] = offset;
    ring.forEach((v, j) => {
      coords[(offset + j) * 2] = v.x;
      coords[(offset + j) * 2 + 1] = v.y;
    });
    return offset + ring.length;
  }, 0);
  starts[rings.length] = total;
  return { coords, starts };
};

const cutIdsOf = (leaf: Leaf): readonly number[] =>
  leaf.edgeRefs.filter((ref) => ref.kind === "cut").map((ref) => ref.refId);

/** Two blocks are neighbours exactly when they share a cut id. */
const adjacencyOf = (
  leaves: readonly Leaf[]
): readonly (readonly number[])[] => {
  const byCut = new Map<number, number[]>();
  leaves.forEach((leaf, index) => {
    cutIdsOf(leaf).forEach((cutId) => {
      const bucket = byCut.get(cutId);
      if (bucket === undefined) byCut.set(cutId, [index]);
      else bucket.push(index);
    });
  });

  return leaves.map((leaf, index) => {
    const neighbours = new Set<number>();
    cutIdsOf(leaf).forEach((cutId) => {
      (byCut.get(cutId) ?? []).forEach((other) => {
        if (other !== index) neighbours.add(other);
      });
    });
    return [...neighbours].toSorted((a, b) => a - b);
  });
};

/** Centimetre-rounded coordinate, so two copies of a shared cut key alike. */
const keyCoord = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);

/** Rounded, order-independent key for one undirected segment. */
const segmentKey = (a: Vec2, b: Vec2): string => {
  const one = `${keyCoord(a.x)},${keyCoord(a.y)}`;
  const two = `${keyCoord(b.x)},${keyCoord(b.y)}`;
  return one < two ? `${one}|${two}` : `${two}|${one}`;
};

/**
 * The subdivision cuts, as street edges of the road graph.
 *
 * Until this existed the only roads in the model were the ~250 arterials, and
 * the street network that the block subdivision creates lived nowhere but the
 * block outlines — so nothing drew it, nothing could measure a building against
 * the street it fronts, and `ROAD_CLASSES` carried two members (`street`,
 * `alley`) that no edge was ever assigned.
 *
 * Each cut is shared by the two blocks either side of it, so the segments are
 * deduplicated by their endpoints. Node ids are -1, which is the contract's
 * value for an edge that is not between two arterial nodes.
 */
const streetEdgesOf = (
  leaves: readonly Leaf[],
  edgeIdBase: number,
  polylineIndexBase: number
): {
  readonly edges: readonly RoadEdge[];
  readonly coords: readonly number[];
} => {
  const seen = new Set<string>();
  const segments = leaves.flatMap((leaf) =>
    leaf.ring.flatMap((point, i) => {
      if (leaf.edgeRefs[i].kind !== "cut") return [];
      const next = leaf.ring[(i + 1) % leaf.ring.length];
      const key = segmentKey(point, next);
      if (seen.has(key)) return [];
      seen.add(key);
      return [[point, next] as const];
    })
  );
  return {
    edges: segments.map((_segment, i) => ({
      id: edgeIdBase + i,
      a: -1,
      b: -1,
      cls: "street" as const,
      crossing: "none" as const,
      polylineIndex: polylineIndexBase + i,
      strip: false,
    })),
    coords: segments.flatMap(([a, b]) => [a.x, a.y, b.x, b.y]),
  };
};

export const blocksStage = (
  input: BlocksInput,
  stream: RngStream
): BlockLayer => {
  const { nodes, edges } = buildFaceGraph(input.roads, input.grid);
  const arterialEdgeIds = new Set(input.roads.edges.map((e) => e.id));
  const traversal = traverseFaces(nodes, edges);
  const posById = new Map(nodes.map((n) => [n.id, n.pos]));

  // The per-seed street grain of the corporate core.
  const cbdDirection = randomUnitVector(stream.next(), stream.next() < 0.5);
  const ctx: CutContext = {
    input,
    cbdDirection,
    stream,
    nextCutId: { value: 0 },
  };

  const regions = traversal.faces
    .filter((_face, index) => index !== traversal.outerFaceIndex)
    .map((face) => ({
      ring: face.nodeIds
        .map((id) => posById.get(id))
        .filter((p): p is Vec2 => p !== undefined),
      // A face edge is either a real arterial or a segment of the map border.
      refs: face.edgeIds.map<BoundaryRef>((edgeId) =>
        arterialEdgeIds.has(edgeId)
          ? { kind: "arterial", refId: edgeId }
          : { kind: "border", refId: edgeId }
      ),
    }))
    .filter((region) => region.ring.length >= 3);

  const leaves = regions.flatMap((region) =>
    subdivide(region.ring, region.refs, 0, ctx)
  );
  const neighbours = adjacencyOf(leaves);

  const blocks: readonly RawBlock[] = leaves.map((leaf, index) => ({
    id: index,
    ringIndex: index,
    boundary: leaf.edgeRefs,
    neighbourIds: neighbours[index],
    water: isWaterBlock(leaf.ring, input),
  }));

  // The arterials pass through untouched; the cuts are appended as streets, so
  // the road graph is the whole network rather than just its skeleton.
  const arterialPool = input.roads.polylines;
  const streets = streetEdgesOf(
    leaves,
    input.roads.edges.reduce((max, e) => Math.max(max, e.id), -1) + 1,
    arterialPool.starts.length - 1
  );
  const streetStarts = streets.edges.map(
    (_edge, i) => arterialPool.coords.length / 2 + i * 2
  );

  return {
    blocks,
    polygons: poolOf(leaves.map((leaf) => leaf.ring)),
    roads: {
      nodes: input.roads.nodes,
      edges: [...input.roads.edges, ...streets.edges],
      polylines: {
        coords: Float32Array.from([...arterialPool.coords, ...streets.coords]),
        starts: Uint32Array.from([
          ...arterialPool.starts,
          ...streetStarts.map((s) => s + 2),
        ]),
      },
    },
  };
};

/** Exposed for tests: the direction a region would be cut at a point. */
export const cutDirectionAt = (
  ring: readonly Vec2[],
  input: BlocksInput,
  cbdDirection: Vec2,
  stream: RngStream,
  decay: number
): Vec2 => {
  const obb = minimumAreaObb(ring);
  const longAxis = obb.w >= obb.d ? obb.facing : perp(obb.facing);
  return cutDirectionFor(
    ring,
    centroid(ring),
    longAxis,
    { input, cbdDirection, stream, nextCutId: { value: 0 } },
    decay
  );
};

/** Exposed for tests: the target area the subdivision stops at. */
export const blockAreaTargetAt = targetBlockAreaAt;
