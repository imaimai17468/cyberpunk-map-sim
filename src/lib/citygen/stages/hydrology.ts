import type { Field2D, TerrainLayer } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { boundedDrain } from "../graph/drain";
import { MinHeap } from "../graph/heap";
import { HYDROLOGY } from "../constants";
import type { Stage } from "./types";

/**
 * Stage 2 — hydrology (design doc §3 stage 2): sea level from an elevation
 * percentile, priority-flood depression fill so every pit drains, D8 flow
 * accumulation, and river carving/dilation.
 *
 * Loop-free per §12: percentile is a built-in `sort` plus an index read
 * (no recursion); priority-flood is a `boundedDrain` over the heap with a
 * `2n`-op bound (each cell pushed at most once); flow accumulation is one
 * `sort` plus one `forEach` pass; dilation is `Array.from({length:
 * passes}).reduce` over a pure `Uint8Array.from` map, so it needs no
 * recursion either.
 */

const NONE_ORDINAL = WATER_CLASSES.indexOf("none");
const OCEAN_ORDINAL = WATER_CLASSES.indexOf("ocean");
const RIVER_ORDINAL = WATER_CLASSES.indexOf("river");

/** The 8 D8 neighbour offsets, used by both the fill and the accumulation pass. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const inBounds = (cells: number, x: number, y: number): boolean =>
  x >= 0 && x < cells && y >= 0 && y < cells;

/** Linear indices of the in-bounds D8 neighbours of `index`, row-major. */
const neighbourIndices = (cells: number, index: number): readonly number[] => {
  const x = index % cells;
  const y = Math.floor(index / cells);
  return NEIGHBOUR_OFFSETS.filter(([dx, dy]) =>
    inBounds(cells, x + dx, y + dy)
  ).map(([dx, dy]) => (y + dy) * cells + (x + dx));
};

/**
 * Sea level as the `percentile`-th ranked elevation value (nearest-rank),
 * so a fixed fraction of the map is guaranteed to be at or below it
 * regardless of the seed (design's "every seed gets a coast").
 */
export const computeSeaLevel = (
  elevation: Field2D,
  percentile: number
): number => {
  const sorted = Float64Array.from(elevation.data).toSorted((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(percentile * sorted.length))
  );
  return sorted[rank];
};

interface FloodState {
  readonly heap: MinHeap<number>;
  readonly filled: Float64Array;
  readonly visited: Uint8Array;
  readonly cells: number;
}

/** Seeds the heap from every cell at or below sea level, marking it visited. */
const createFloodState = (
  elevation: Field2D,
  seaLevelM: number
): FloodState => {
  const cells = elevation.cells;
  const total = cells * cells;
  const filled = Float64Array.from(elevation.data);
  const visited = new Uint8Array(total);
  const heap = new MinHeap<number>();
  Array.from({ length: total }, (_value, index) => index)
    .filter((index) => elevation.data[index] <= seaLevelM)
    .forEach((index) => {
      visited[index] = 1;
      heap.push({ key: [filled[index], index], value: index });
    });
  return { heap, filled, visited, cells };
};

/**
 * One priority-flood step: pop the lowest-keyed frontier cell and raise
 * every unvisited neighbour to `max(poppedElevation, neighbourElevation)`,
 * pushing it with that raised value as its new key. A no-op once the heap
 * is empty, as `boundedDrain` requires.
 */
const floodStep = (state: FloodState): FloodState => {
  const popped = state.heap.pop();
  if (!popped) return state;
  const poppedElevation = state.filled[popped.value];
  neighbourIndices(state.cells, popped.value)
    .filter((neighbourIndex) => state.visited[neighbourIndex] === 0)
    .forEach((neighbourIndex) => {
      const raised = Math.max(poppedElevation, state.filled[neighbourIndex]);
      state.filled[neighbourIndex] = raised;
      state.visited[neighbourIndex] = 1;
      state.heap.push({ key: [raised, neighbourIndex], value: neighbourIndex });
    });
  return state;
};

/**
 * Priority-flood depression fill (Barnes 2014): raises every cell to the
 * elevation of the lowest spill path connecting it back to a cell at or
 * below `seaLevelM`, so no strict local minimum survives above sea level
 * and D8 flow accumulation can always route downhill to the sea.
 */
export const priorityFloodFill = (
  elevation: Field2D,
  seaLevelM: number
): Field2D => {
  const cells = elevation.cells;
  const total = cells * cells;
  const final = boundedDrain(createFloodState(elevation, seaLevelM), {
    step: floodStep,
    isDone: (state) => state.heap.size === 0,
    maxOps: 2 * total,
  });
  return {
    cells,
    cellSizeM: elevation.cellSizeM,
    data: Float32Array.from(final.filled),
  };
};

/** Lexicographic `(value, index)` comparison, the same total order as heap keys. */
const isLexicographicallyLess = (
  valueA: number,
  indexA: number,
  valueB: number,
  indexB: number
): boolean => valueA < valueB || (valueA === valueB && indexA < indexB);

/**
 * The single steepest-descent D8 neighbour of `index` whose `(elevation,
 * index)` tuple is lexicographically less than `index`'s own — i.e. the
 * unique cell flow drains into next. `null` when no such neighbour exists
 * (a local sink in the accumulation DAG: either the true low point of the
 * whole grid, or the lowest-indexed cell of a filled flat plateau).
 */
const downhillTarget = (
  data: Float32Array,
  cells: number,
  index: number
): number | null => {
  const elevation = data[index];
  const candidates = neighbourIndices(cells, index).filter((neighbourIndex) =>
    isLexicographicallyLess(
      data[neighbourIndex],
      neighbourIndex,
      elevation,
      index
    )
  );
  return candidates.length === 0
    ? null
    : candidates.reduce((best, candidate) =>
        isLexicographicallyLess(data[candidate], candidate, data[best], best)
          ? candidate
          : best
      );
};

/**
 * D8 flow accumulation: cells visited highest-first (`(elevation desc,
 * index asc)` — a total order), each contributing its accumulated count to
 * its unique downhill target in one `forEach` pass.
 */
export const computeFlowAccumulation = (filled: Field2D): Float64Array => {
  const total = filled.cells * filled.cells;
  const order = Array.from(
    { length: total },
    (_value, index) => index
  ).toSorted((a, b) => filled.data[b] - filled.data[a] || a - b);
  const accumulation = new Float64Array(total).fill(1);
  order.forEach((index) => {
    const target = downhillTarget(filled.data, filled.cells, index);
    if (target !== null) {
      accumulation[target] += accumulation[index];
    }
  });
  return accumulation;
};

/**
 * Initial (pre-dilation) river mask: a land cell (`filled > seaLevelM`)
 * whose accumulation exceeds `HYDROLOGY.riverAccumulationFraction` of the
 * land cell count.
 */
export const classifyInitialRiverMask = (
  filled: Field2D,
  seaLevelM: number,
  accumulation: Float64Array,
  landCellCount: number
): Uint8Array => {
  const threshold = HYDROLOGY.riverAccumulationFraction * landCellCount;
  return Uint8Array.from(filled.data, (value, index) =>
    value > seaLevelM && accumulation[index] > threshold ? 1 : 0
  );
};

/** One morphological dilation pass: a cell joins the mask if it or any D8 neighbour is set. */
const dilateOnce = (mask: Uint8Array, cells: number): Uint8Array =>
  Uint8Array.from({ length: mask.length }, (_value, index) => {
    if (mask[index] === 1) return 1;
    return neighbourIndices(cells, index).some(
      (neighbourIndex) => mask[neighbourIndex] === 1
    )
      ? 1
      : 0;
  });

/** `passes` sequential dilation passes over `mask`. */
export const dilateMask = (
  mask: Uint8Array,
  cells: number,
  passes: number
): Uint8Array =>
  Array.from({ length: passes }).reduce<Uint8Array>(
    (acc) => dilateOnce(acc, cells),
    mask
  );

export type HydrologyStage = Stage<Field2D, TerrainLayer>;

/** Stage 2: raw elevation `Field2D` in, corrected-elevation `TerrainLayer` out. */
export const hydrologyStage: HydrologyStage = (elevation, _stream) => {
  const seaLevelM = computeSeaLevel(elevation, HYDROLOGY.seaLevelPercentile);
  const filled = priorityFloodFill(elevation, seaLevelM);
  const accumulation = computeFlowAccumulation(filled);
  const landCellCount = filled.data.reduce(
    (count, value) => (value > seaLevelM ? count + 1 : count),
    0
  );
  const initialRiverMask = classifyInitialRiverMask(
    filled,
    seaLevelM,
    accumulation,
    landCellCount
  );
  const riverMask = dilateMask(
    initialRiverMask,
    filled.cells,
    HYDROLOGY.riverDilatePasses
  );

  const waterMask = Uint8Array.from(filled.data, (value, index) => {
    if (value <= seaLevelM) return OCEAN_ORDINAL;
    return riverMask[index] === 1 ? RIVER_ORDINAL : NONE_ORDINAL;
  });

  const correctedData = Float32Array.from(filled.data, (value, index) =>
    riverMask[index] === 1 ? value - HYDROLOGY.riverCarveM : value
  );
  const correctedElevation: Field2D = {
    cells: filled.cells,
    cellSizeM: filled.cellSizeM,
    data: correctedData,
  };

  const waterDepthData = Float32Array.from(correctedData, (value, index) => {
    if (waterMask[index] === OCEAN_ORDINAL)
      return Math.max(0, seaLevelM - value);
    if (waterMask[index] === RIVER_ORDINAL) return HYDROLOGY.riverCarveM;
    return 0;
  });
  const waterDepth: Field2D = {
    cells: filled.cells,
    cellSizeM: filled.cellSizeM,
    data: waterDepthData,
  };

  return { elevation: correctedElevation, waterMask, waterDepth, seaLevelM };
};
