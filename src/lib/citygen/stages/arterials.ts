import type {
  Crossing,
  PolylinePool,
  RoadClass,
  RoadEdge,
  RoadGraph,
  RoadNode,
  TerrainLayer,
  Vec2,
} from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { ANCHORS, ARTERIALS } from "../constants";
import {
  candidateSegmentPairs,
  segmentIntersection,
  type IndexedSegment,
} from "../geometry/intersect";
import { douglasPeucker } from "../geometry/simplify";
import { dot, sub } from "../geometry/vec";
import { boundedDrain } from "../graph/drain";
import { MinHeap } from "../graph/heap";
import type { RngStream } from "../rng/types";
import type { AnchorSet, DerivedFields, Grid, Stage } from "./types";

/**
 * Stage 6 — terrain-following arterial graph (design doc §3 stage 6, §12).
 *
 * Three families of Dijkstra geodesic paths (highways CBD→edge midpoints,
 * avenues CBD→mega seeds/casino, the shore-hugging strip avenue) are grown
 * over a single terrain-following cost surface, water-run-segmented,
 * Douglas-Peucker simplified, and planarized — only these ~10-14 polylines
 * are ever intersection-tested, per §2 flaw #3's resolution. Bridges are
 * never placed: a maximal run of water cells on a chosen path *is* a bridge,
 * because `arterialCellCost` prices water beyond `bridgeSpanM` of land as
 * infinite (excluded), so a chosen path can only ever cross a short span.
 */

export interface ArterialsInput {
  readonly grid: Grid;
  readonly terrain: TerrainLayer;
  readonly derived: DerivedFields;
  readonly anchors: AnchorSet;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * The design doc's "slopeN" is the raw central-difference slope (already a
 * unitless rise/run ratio, per stage 3) clamped to [0, 1] — the same value
 * `smoothstep(edge0, edge1, slope)` compares against absolute thresholds
 * elsewhere without an "N" suffix. There is no separate normalization
 * constant anywhere in `constants.ts`, so clamping is the only local
 * information available to interpret the two spellings consistently.
 */
const slopeN = (slope: number): number => clamp01(slope);

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * A "prime waterfront" hump: near zero right at the water's edge, rising to
 * a plateau across `[nearM, farM]`, falling back to zero by `2*farM - nearM`.
 * Not specified numerically by the design doc beyond "waterfront band
 * (60-400 m)"; this shape is this file's own choice, scoped to the strip
 * avenue's cost discount and not shared with any other stage.
 */
export const waterfrontBand = (
  distWaterM: number,
  nearM: number,
  farM: number
): number => {
  const rising = smoothstep(0, nearM, distWaterM);
  const falling = 1 - smoothstep(farM, farM + (farM - nearM), distWaterM);
  return clamp01(rising * falling);
};

const NONE_ORDINAL = WATER_CLASSES.indexOf("none");

const isWaterAt = (waterMask: Uint8Array, index: number): boolean =>
  waterMask[index] !== NONE_ORDINAL;

/** `arterialCost = 1 + 8·slopeN + waterCost` — design doc §3 stage 6. */
export const buildArterialCostField = (
  terrain: TerrainLayer,
  derived: DerivedFields
): Float64Array =>
  Float64Array.from(derived.slope.data, (slopeValue, index) => {
    const base = 1 + ARTERIALS.slopeCostWeight * slopeN(slopeValue);
    if (!isWaterAt(terrain.waterMask, index)) return base;
    const distLandM = derived.distLand.data[index];
    return distLandM <= ARTERIALS.bridgeSpanM
      ? base + ARTERIALS.waterCrossCost
      : Number.POSITIVE_INFINITY;
  });

/** The strip's shore-hugging discount: `arterialCost · (1 − 0.6·band(...))`. */
export const buildStripCostField = (
  baseCost: Float64Array,
  derived: DerivedFields
): Float64Array =>
  Float64Array.from(baseCost, (cost, index) => {
    if (!Number.isFinite(cost)) return cost;
    const distWaterM = derived.distWater.data[index];
    const discount =
      ARTERIALS.stripWaterBandDiscount *
      waterfrontBand(distWaterM, ANCHORS.waterBandNearM, ANCHORS.waterBandFarM);
    return cost * (1 - discount);
  });

export const worldToCellIndex = (pos: Vec2, grid: Grid): number => {
  const cx = Math.min(
    Math.max(Math.floor(pos.x / grid.cellSizeM), 0),
    grid.cells - 1
  );
  const cy = Math.min(
    Math.max(Math.floor(pos.y / grid.cellSizeM), 0),
    grid.cells - 1
  );
  return cy * grid.cells + cx;
};

export const cellIndexToWorld = (index: number, grid: Grid): Vec2 => {
  const cx = index % grid.cells;
  const cy = Math.floor(index / grid.cells);
  return { x: (cx + 0.5) * grid.cellSizeM, y: (cy + 0.5) * grid.cellSizeM };
};

const SQRT2 = Math.sqrt(2);

const NEIGHBOR_OFFSETS: readonly {
  readonly dx: number;
  readonly dy: number;
  readonly dist: number;
}[] = [
  { dx: 1, dy: 0, dist: 1 },
  { dx: -1, dy: 0, dist: 1 },
  { dx: 0, dy: 1, dist: 1 },
  { dx: 0, dy: -1, dist: 1 },
  { dx: 1, dy: 1, dist: SQRT2 },
  { dx: 1, dy: -1, dist: SQRT2 },
  { dx: -1, dy: 1, dist: SQRT2 },
  { dx: -1, dy: -1, dist: SQRT2 },
];

export interface DijkstraResult {
  readonly dist: Float64Array;
  readonly prev: Int32Array;
}

interface DijkstraState {
  readonly heap: MinHeap<number>;
  readonly dist: Float64Array;
  readonly prev: Int32Array;
}

/** Every heap key is `(cost, cellIndex)` — cellIndex is a unique integer tie-break. */
const relaxFrom = (
  state: DijkstraState,
  costField: Float64Array,
  grid: Grid,
  current: number
): void => {
  const cx = current % grid.cells;
  const cy = Math.floor(current / grid.cells);
  const currentCost = costField[current];
  const currentDist = state.dist[current];
  NEIGHBOR_OFFSETS.forEach((offset) => {
    const nx = cx + offset.dx;
    const ny = cy + offset.dy;
    if (nx < 0 || ny < 0 || nx >= grid.cells || ny >= grid.cells) return;
    const neighborIndex = ny * grid.cells + nx;
    const neighborCost = costField[neighborIndex];
    if (!Number.isFinite(neighborCost)) return;
    const edgeCost =
      ((currentCost + neighborCost) / 2) * offset.dist * grid.cellSizeM;
    const candidate = currentDist + edgeCost;
    if (candidate < state.dist[neighborIndex]) {
      state.dist[neighborIndex] = candidate;
      state.prev[neighborIndex] = current;
      state.heap.push({
        key: [candidate, neighborIndex],
        value: neighborIndex,
      });
    }
  });
};

const dijkstraStep = (
  state: DijkstraState,
  costField: Float64Array,
  grid: Grid
): DijkstraState => {
  const popped = state.heap.pop();
  if (!popped) return state;
  const [cost, index] = popped.key;
  if (cost > state.dist[index]) return state;
  relaxFrom(state, costField, grid, index);
  return state;
};

/**
 * Full-grid single-source Dijkstra over `costField`, run to exhaustion via
 * `boundedDrain` (design §12): 8-connected, so each cell is relaxed at most
 * 8 times, bounding total step calls at `8n + 1`.
 */
export const runDijkstra = (
  costField: Float64Array,
  grid: Grid,
  sourceIndex: number
): DijkstraResult => {
  const n = grid.cells * grid.cells;
  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(n).fill(-1);
  dist[sourceIndex] = 0;
  const heap = new MinHeap<number>();
  heap.push({ key: [0, sourceIndex], value: sourceIndex });
  const initial: DijkstraState = { heap, dist, prev };
  const finalState = boundedDrain(initial, {
    step: (s) => dijkstraStep(s, costField, grid),
    isDone: (s) => s.heap.size === 0,
    maxOps: 8 * n + 1,
  });
  return { dist: finalState.dist, prev: finalState.prev };
};

interface BacktrackState {
  readonly current: number;
  readonly path: number[];
  readonly done: boolean;
}

const backtrackStep = (
  state: BacktrackState,
  prev: Int32Array,
  sourceIndex: number
): BacktrackState => {
  if (state.done) return state;
  state.path.push(state.current);
  if (state.current === sourceIndex) return { ...state, done: true };
  const next = prev[state.current];
  if (next === -1) return { ...state, done: true };
  return { current: next, path: state.path, done: false };
};

/**
 * Walks `prev` from `targetIndex` back to `sourceIndex`, returned in
 * source→target order. Bounded via `boundedDrain` rather than one recursive
 * call per cell (design §12's backtrack row) — a naive per-cell recursion
 * would exceed the engine's ~9,765-frame limit on a large grid.
 */
export const backtrackPath = (
  prev: Int32Array,
  sourceIndex: number,
  targetIndex: number,
  maxOps: number
): readonly number[] => {
  const initial: BacktrackState = {
    current: targetIndex,
    path: [],
    done: false,
  };
  const result = boundedDrain(initial, {
    step: (s) => backtrackStep(s, prev, sourceIndex),
    isDone: (s) => s.done,
    maxOps,
  });
  return result.path.toReversed();
};

type Side = "top" | "bottom" | "left" | "right";
const SIDES: readonly Side[] = ["top", "bottom", "left", "right"];

interface BorderCandidate {
  readonly i: number;
  readonly cellIndex: number;
}

const borderCandidates = (
  grid: Grid,
  side: Side
): readonly BorderCandidate[] => {
  const last = grid.cells - 1;
  return Array.from({ length: grid.cells }, (_value, i) => ({
    i,
    cellIndex:
      side === "top"
        ? i
        : side === "bottom"
          ? last * grid.cells + i
          : side === "left"
            ? i * grid.cells
            : i * grid.cells + last,
  }));
};

/**
 * The map-edge midpoint of `side`, or the nearest reachable border cell when
 * the exact midpoint is excluded (deep water beyond the bridge span, or an
 * otherwise disconnected fixture). Returns `null` when the whole side is
 * unreachable.
 */
export const pickBorderTarget = (
  grid: Grid,
  side: Side,
  dist: Float64Array
): number | null => {
  const idealI = Math.floor(grid.cells / 2);
  const reachable = borderCandidates(grid, side).filter((c) =>
    Number.isFinite(dist[c.cellIndex])
  );
  if (reachable.length === 0) return null;
  return reachable.reduce((best, c) =>
    Math.abs(c.i - idealI) < Math.abs(best.i - idealI) ? c : best
  ).cellIndex;
};

export interface RawArterialPath {
  readonly cellIndices: readonly number[];
  readonly cls: RoadClass;
  readonly strip: boolean;
}

/**
 * Builds a raw arterial path from `sourceIndex` to `targetIndex`, or `null`
 * when there is nothing to build: a degenerate same-cell request, or a
 * target `runDijkstra` never reached (excluded by infinite cost, or simply
 * disconnected). When neither guard fires, the resulting backtrack is
 * guaranteed at least 2 cells — `target !== source` plus a finite distance
 * means the predecessor chain must reach the source before running out, per
 * `runDijkstra`'s own invariant — so there is no further "empty path" case
 * to guard here.
 */
const pathFromTarget = (
  dijkstra: DijkstraResult,
  grid: Grid,
  sourceIndex: number,
  targetIndex: number,
  cls: RoadClass,
  strip: boolean
): RawArterialPath | null => {
  if (targetIndex === sourceIndex) return null;
  if (!Number.isFinite(dijkstra.dist[targetIndex])) return null;
  const cellIndices = backtrackPath(
    dijkstra.prev,
    sourceIndex,
    targetIndex,
    grid.cells * grid.cells
  );
  return { cellIndices, cls, strip };
};

export const buildHighwayPaths = (
  dijkstra: DijkstraResult,
  grid: Grid,
  sourceIndex: number
): readonly RawArterialPath[] =>
  SIDES.map((side) => pickBorderTarget(grid, side, dijkstra.dist))
    .filter((target): target is number => target !== null)
    .map((target) =>
      pathFromTarget(dijkstra, grid, sourceIndex, target, "highway", false)
    )
    .filter((path): path is RawArterialPath => path !== null);

export const buildAvenuePaths = (
  dijkstra: DijkstraResult,
  grid: Grid,
  sourceIndex: number,
  targets: readonly Vec2[]
): readonly RawArterialPath[] =>
  targets
    .map((pos) => worldToCellIndex(pos, grid))
    .map((target) =>
      pathFromTarget(dijkstra, grid, sourceIndex, target, "avenue", false)
    )
    .filter((path): path is RawArterialPath => path !== null);

/**
 * The shore-hugging strip avenue between the two points half `stripHalfLengthM`
 * either side of the casino anchor along `anchors.stripAxis` (already
 * constructed by stage 4 — design doc §2 flaw #6's resolution). Uses its own
 * discounted Dijkstra run rather than the CBD tree, since its cost surface
 * differs.
 */
export const buildStripPath = (
  costField: Float64Array,
  grid: Grid,
  derived: DerivedFields,
  anchors: AnchorSet
): RawArterialPath | null => {
  const { origin, dir } = anchors.stripAxis;
  const half = ANCHORS.stripHalfLengthM;
  const a: Vec2 = { x: origin.x - dir.x * half, y: origin.y - dir.y * half };
  const b: Vec2 = { x: origin.x + dir.x * half, y: origin.y + dir.y * half };
  const sourceIndex = worldToCellIndex(a, grid);
  const targetIndex = worldToCellIndex(b, grid);
  const stripCostField = buildStripCostField(costField, derived);
  const dijkstra = runDijkstra(stripCostField, grid, sourceIndex);
  return pathFromTarget(
    dijkstra,
    grid,
    sourceIndex,
    targetIndex,
    "avenue",
    true
  );
};

export interface FamilyRun {
  readonly points: readonly Vec2[];
  readonly crossing: Crossing;
  readonly cls: RoadClass;
  readonly strip: boolean;
  readonly pathIndex: number;
}

interface RunGroup {
  readonly flag: boolean;
  readonly start: number;
  readonly end: number;
}

/** Maximal runs of constant water-flag along a path (design §3 stage 6). */
export const groupRuns = (
  waterFlags: readonly boolean[]
): readonly RunGroup[] =>
  waterFlags.reduce<RunGroup[]>((groups, flag, i) => {
    const last = groups[groups.length - 1];
    if (last && last.flag === flag) {
      groups[groups.length - 1] = { flag, start: last.start, end: i };
      return groups;
    }
    groups.push({ flag, start: i, end: i });
    return groups;
  }, []);

/**
 * Converts water-flag runs into simplified `FamilyRun`s. Adjacent runs share
 * their boundary vertex (each non-final group's range is extended by one
 * index) so the resulting polylines join without a gap; each run is
 * Douglas-Peucker simplified independently so a land/water transition is
 * never smoothed away.
 */
export const runsFromGroups = (
  groups: readonly RunGroup[],
  cellIndices: readonly number[],
  grid: Grid,
  epsilonM: number
): readonly {
  readonly points: readonly Vec2[];
  readonly crossing: Crossing;
}[] =>
  groups.map((group, g) => {
    const endIdx = g < groups.length - 1 ? group.end + 1 : group.end;
    const rangePoints = cellIndices
      .slice(group.start, endIdx + 1)
      .map((cellIndex) => cellIndexToWorld(cellIndex, grid));
    return {
      points: douglasPeucker(rangePoints, epsilonM),
      crossing: group.flag ? ("bridge" as const) : ("none" as const),
    };
  });

const buildFamilyRuns = (
  path: RawArterialPath,
  pathIndex: number,
  grid: Grid,
  waterMask: Uint8Array
): readonly FamilyRun[] => {
  const waterFlags = path.cellIndices.map((i) => isWaterAt(waterMask, i));
  const groups = groupRuns(waterFlags);
  return runsFromGroups(
    groups,
    path.cellIndices,
    grid,
    ARTERIALS.simplifyEpsilonM
  ).map((run) => ({
    ...run,
    cls: path.cls,
    strip: path.strip,
    pathIndex,
  }));
};

interface SegmentMeta {
  readonly runIndex: number;
  readonly localSegIndex: number;
  readonly pathIndex: number;
}

const buildGlobalSegments = (
  runs: readonly FamilyRun[]
): {
  readonly segments: readonly IndexedSegment[];
  readonly meta: readonly SegmentMeta[];
} => {
  const perRun = runs.flatMap((run, runIndex) =>
    run.points.slice(0, -1).map((a, localSegIndex) => ({
      a,
      b: run.points[localSegIndex + 1],
      runIndex,
      localSegIndex,
      pathIndex: run.pathIndex,
    }))
  );
  return {
    segments: perRun.map((s, index) => ({ index, a: s.a, b: s.b })),
    meta: perRun.map((s) => ({
      runIndex: s.runIndex,
      localSegIndex: s.localSegIndex,
      pathIndex: s.pathIndex,
    })),
  };
};

interface Insertion {
  readonly localSegIndex: number;
  readonly point: Vec2;
  readonly t: number;
}

const addInsertion = (
  map: Map<number, Insertion[]>,
  runIndex: number,
  localSegIndex: number,
  point: Vec2,
  seg: IndexedSegment
): void => {
  const t = dot(sub(point, seg.a), sub(seg.b, seg.a));
  const entry: Insertion = { localSegIndex, point, t };
  const list = map.get(runIndex);
  if (list) {
    list.push(entry);
  } else {
    map.set(runIndex, [entry]);
  }
};

/**
 * Candidate segment pairs from *different* top-level arterial paths only —
 * runs of the same path already meet exactly at their shared run-boundary
 * vertex, which is not a planarization crossing.
 */
const findInsertions = (
  runs: readonly FamilyRun[],
  segments: readonly IndexedSegment[],
  meta: readonly SegmentMeta[]
): ReadonlyMap<number, readonly Insertion[]> => {
  const insertionsByRun = new Map<number, Insertion[]>();
  const candidatePairs = candidateSegmentPairs(
    segments,
    ARTERIALS.spatialHashCellM
  );
  candidatePairs
    .filter(([i, j]) => meta[i].pathIndex !== meta[j].pathIndex)
    .forEach(([i, j]) => {
      const segA = segments[i];
      const segB = segments[j];
      const result = segmentIntersection(segA.a, segA.b, segB.a, segB.b);
      if (result.kind !== "point") return;
      addInsertion(
        insertionsByRun,
        meta[i].runIndex,
        meta[i].localSegIndex,
        result.point,
        segA
      );
      addInsertion(
        insertionsByRun,
        meta[j].runIndex,
        meta[j].localSegIndex,
        result.point,
        segB
      );
    });
  return insertionsByRun;
};

interface AugmentedPoint {
  readonly pos: Vec2;
  readonly isBreak: boolean;
}

const groupInsertionsBySegment = (
  insertions: readonly Insertion[]
): ReadonlyMap<number, readonly Insertion[]> => {
  const bySeg = new Map<number, Insertion[]>();
  insertions.forEach((ins) => {
    const list = bySeg.get(ins.localSegIndex);
    if (list) {
      list.push(ins);
    } else {
      bySeg.set(ins.localSegIndex, [ins]);
    }
  });
  bySeg.forEach((list) => list.sort((a, b) => a.t - b.t));
  return bySeg;
};

/**
 * Original run vertices, marked as graph-node-worthy break points (the
 * run's own endpoints) or not (interior Douglas-Peucker shape points),
 * interleaved with every crossing insertion — always a break point — in
 * along-segment order.
 */
export const buildAugmentedVertices = (
  run: { readonly points: readonly Vec2[] },
  insertions: readonly Insertion[]
): readonly AugmentedPoint[] => {
  const bySeg = groupInsertionsBySegment(insertions);
  const lastIndex = run.points.length - 1;
  return run.points.flatMap((point, i) => {
    const own: AugmentedPoint = {
      pos: point,
      isBreak: i === 0 || i === lastIndex,
    };
    const segIns = bySeg.get(i) ?? [];
    return [
      own,
      ...segIns.map(
        (ins): AugmentedPoint => ({ pos: ins.point, isBreak: true })
      ),
    ];
  });
};

/** Splits an augmented vertex list into one polyline per pair of break points. */
export const splitIntoEdgeVertexLists = (
  augmented: readonly AugmentedPoint[]
): readonly (readonly Vec2[])[] => {
  const breakIndices = augmented
    .map((p, i) => (p.isBreak ? i : -1))
    .filter((i) => i >= 0);
  return breakIndices
    .slice(0, -1)
    .map((start, k) =>
      augmented.slice(start, breakIndices[k + 1] + 1).map((p) => p.pos)
    );
};

interface EdgeData {
  readonly vertices: readonly Vec2[];
  readonly cls: RoadClass;
  readonly crossing: Crossing;
  readonly strip: boolean;
}

const snapRound = (v: number, latticeM: number): number =>
  Math.round(v / latticeM) * latticeM;

const nodeBucketKey = (pos: Vec2, snapM: number, latticeM: number): string => {
  const x = snapRound(pos.x, latticeM);
  const y = snapRound(pos.y, latticeM);
  const bx = Math.round(x / snapM);
  const by = Math.round(y / snapM);
  return `${bx}:${by}`;
};

interface NodeRegistry {
  readonly byKey: Map<string, number>;
  readonly nodes: RoadNode[];
}

/** Nodes closer than `nodeSnapM` are merged; first-seen position wins (determinism). */
const resolveNodeId = (registry: NodeRegistry, pos: Vec2): number => {
  const key = nodeBucketKey(pos, ARTERIALS.nodeSnapM, ARTERIALS.snapLatticeM);
  const existing = registry.byKey.get(key);
  if (existing !== undefined) return existing;
  const id = registry.nodes.length;
  const snapped: Vec2 = {
    x: snapRound(pos.x, ARTERIALS.snapLatticeM),
    y: snapRound(pos.y, ARTERIALS.snapLatticeM),
  };
  registry.nodes.push({ id, pos: snapped });
  registry.byKey.set(key, id);
  return id;
};

const buildPolylinePool = (
  edgeVertexLists: readonly (readonly Vec2[])[]
): PolylinePool => {
  const starts = edgeVertexLists.reduce<number[]>(
    (acc, vertices) => {
      acc.push(acc[acc.length - 1] + vertices.length);
      return acc;
    },
    [0]
  );
  const coords = Float32Array.from(
    edgeVertexLists.flatMap((vertices) => vertices.flatMap((p) => [p.x, p.y]))
  );
  return { coords, starts: Uint32Array.from(starts) };
};

const buildRoadGraph = (edgesData: readonly EdgeData[]): RoadGraph => {
  const registry: NodeRegistry = { byKey: new Map(), nodes: [] };
  const edges: RoadEdge[] = edgesData.map((e, id) => ({
    id,
    a: resolveNodeId(registry, e.vertices[0]),
    b: resolveNodeId(registry, e.vertices[e.vertices.length - 1]),
    cls: e.cls,
    crossing: e.crossing,
    polylineIndex: id,
    strip: e.strip,
  }));
  const polylines = buildPolylinePool(edgesData.map((e) => e.vertices));
  return { nodes: registry.nodes, edges, polylines };
};

/**
 * Planarizes a flat list of already-simplified arterial runs: finds
 * crossings between different top-level paths (spatial-hash bucketed, per
 * design §2 flaw #3), splits each run at its own crossings, and assembles
 * the resulting nodes/edges/polyline pool. Exported standalone from
 * `arterialsStage` so the planarization step itself is unit-testable
 * without a full Dijkstra run.
 */
export const planarizeArterials = (runs: readonly FamilyRun[]): RoadGraph => {
  const { segments, meta } = buildGlobalSegments(runs);
  const insertionsByRun = findInsertions(runs, segments, meta);
  const edgesData = runs.flatMap((run, runIndex) => {
    const insertions = insertionsByRun.get(runIndex) ?? [];
    const augmented = buildAugmentedVertices(run, insertions);
    return splitIntoEdgeVertexLists(augmented).map(
      (vertices): EdgeData => ({
        vertices,
        cls: run.cls,
        crossing: run.crossing,
        strip: run.strip,
      })
    );
  });
  return buildRoadGraph(edgesData);
};

const buildAllRawPaths = (
  input: ArterialsInput,
  costField: Float64Array
): readonly RawArterialPath[] => {
  const { grid, derived, anchors } = input;
  const sourceIndex = worldToCellIndex(anchors.cbd, grid);
  const cbdDijkstra = runDijkstra(costField, grid, sourceIndex);
  const highwayPaths = buildHighwayPaths(cbdDijkstra, grid, sourceIndex);
  const avenuePaths = buildAvenuePaths(cbdDijkstra, grid, sourceIndex, [
    ...anchors.megaSeeds,
    anchors.casino,
  ]);
  const stripPath = buildStripPath(costField, grid, derived, anchors);
  return [...highwayPaths, ...avenuePaths, ...(stripPath ? [stripPath] : [])];
};

/**
 * Stage 6: builds the arterial-only `RoadGraph` (design doc §3 stage 6).
 * Deterministic and RNG-free — every path is the unique cheapest route over
 * a fixed cost surface, so this stage never draws from `stream`.
 */
export const arterialsStage: Stage<ArterialsInput, RoadGraph> = (
  input,
  _stream: RngStream
) => {
  const costField = buildArterialCostField(input.terrain, input.derived);
  const allPaths = buildAllRawPaths(input, costField);
  const runs = allPaths.flatMap((path, pathIndex) =>
    buildFamilyRuns(path, pathIndex, input.grid, input.terrain.waterMask)
  );
  return planarizeArterials(runs);
};
