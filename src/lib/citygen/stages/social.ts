import type { Field2D, TerrainLayer, Vec2 } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { ANCHORS, SOCIAL } from "../constants";
import {
  combineFields,
  createField2D,
  fieldIndex,
  mapField,
} from "../field/field2d";
import { boundedDrain } from "../graph/drain";
import { MinHeap } from "../graph/heap";
import { cross, dot, length, sub } from "../geometry/vec";
import {
  band,
  clamp,
  clamp01,
  fieldMaxAbs,
  normalizeSlope,
  smoothstep,
} from "./anchors";
import type {
  AnchorSet,
  DerivedFields,
  Grid,
  SocialFields,
  Stage,
} from "./types";

/**
 * Stage 5 — social fields (design doc §3 stage 5, §6).
 *
 * `centrality` is geodesic: a Dijkstra run over a slope+water cost surface
 * from the CBD, through {@link boundedDrain} so the traversal never recurses
 * per cell (design §12). Every other falloff here is `smoothstep` or the
 * `band` helper from `./anchors` — no exponential appears anywhere (design
 * §5).
 */

const NONE_ORDINAL = WATER_CLASSES.indexOf("none");

// ---------------------------------------------------------------------------
// Cost surface + geodesic Dijkstra.
// ---------------------------------------------------------------------------

const costSurfaceField = (
  grid: Grid,
  terrain: TerrainLayer,
  slopeN: Field2D
): Field2D =>
  createField2D(grid.cells, grid.cellSizeM, (index) => {
    const isWater = terrain.waterMask[index] !== NONE_ORDINAL ? 1 : 0;
    return (
      1 +
      SOCIAL.slopeCostWeight * slopeN.data[index] +
      SOCIAL.waterCost * isWater
    );
  });

/** The 4-connected neighbour offsets a grid-graph Dijkstra steps through. */
const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Row-major indices of `index`'s in-bounds 4-connected neighbours. */
const neighborsOf = (cells: number, index: number): readonly number[] => {
  const cx = index % cells;
  const cy = Math.floor(index / cells);
  return NEIGHBOR_OFFSETS.flatMap(([dx, dy]) => {
    const nx = cx + dx;
    const ny = cy + dy;
    return nx < 0 || nx >= cells || ny < 0 || ny >= cells
      ? []
      : [ny * cells + nx];
  });
};

interface DijkstraState {
  readonly dist: Float64Array;
  readonly settled: Uint8Array;
  readonly heap: MinHeap<number>;
}

/**
 * One Dijkstra relaxation step, driven by {@link boundedDrain}: pop the
 * cheapest frontier cell, settle it if not already settled (lazy deletion —
 * a cell may sit in the heap more than once, but is only ever finalized on
 * its first, cheapest pop, per `compareHeapKeys`'s total order), then push
 * every unsettled neighbour with its relaxed cost.
 *
 * `dist`/`settled` are the buffers `geodesicDistanceFromCbd` allocated for
 * this run; mutating them here is mutating an owned buffer, not reassigning
 * a parameter (AGENTS.md's `no-param-reassign` note, mirrored from
 * `graph/heap.ts`).
 */
const dijkstraStep =
  (cells: number, costSurface: Field2D) =>
  (state: DijkstraState): DijkstraState => {
    const top = state.heap.pop();
    if (!top) return state;
    const cellIndex = top.value;
    if (state.settled[cellIndex] === 1) return state;
    state.settled[cellIndex] = 1;
    const cost = top.key[0];
    state.dist[cellIndex] = cost;
    neighborsOf(cells, cellIndex).forEach((neighborIndex) => {
      if (state.settled[neighborIndex] === 1) return;
      const edgeCost =
        ((costSurface.data[cellIndex] + costSurface.data[neighborIndex]) / 2) *
        costSurface.cellSizeM;
      state.heap.push({
        key: [cost + edgeCost, neighborIndex],
        value: neighborIndex,
      });
    });
    return state;
  };

/**
 * Geodesic distance from `cbd` over `costSurface`, via a single Dijkstra run
 * drained through {@link boundedDrain}. Each of the `n` cells is settled at
 * most once and pushes at most 4 neighbours (its out-degree) before being
 * settled, so total heap operations are bounded by `8n` — the same bound
 * `graph/drain.test.ts` exercises for the default 512x512 grid.
 */
const geodesicDistanceFromCbd = (
  grid: Grid,
  costSurface: Field2D,
  cbd: Vec2
): Field2D => {
  const { cells } = grid;
  const n = cells * cells;
  const cbdIndex = fieldIndex(
    costSurface,
    cbd.x / grid.cellSizeM,
    cbd.y / grid.cellSizeM
  );
  const heap = new MinHeap<number>();
  heap.push({ key: [0, cbdIndex], value: cbdIndex });
  const initialState: DijkstraState = {
    dist: Float64Array.from({ length: n }, () => Number.POSITIVE_INFINITY),
    settled: new Uint8Array(n),
    heap,
  };
  const finalState = boundedDrain(initialState, {
    step: dijkstraStep(cells, costSurface),
    isDone: (state) => state.heap.size === 0,
    maxOps: 8 * n,
  });
  return {
    cells,
    cellSizeM: grid.cellSizeM,
    data: Float32Array.from(finalState.dist),
  };
};

/** `1 / (1 + (d / halfDistance)^2)` — the one rational (non-`smoothstep`) falloff (design §5). */
const centralityField = (dCbd: Field2D): Field2D =>
  mapField(dCbd, (d) => {
    const ratio = d / SOCIAL.centralityHalfDistanceM;
    return 1 / (1 + ratio * ratio);
  });

// ---------------------------------------------------------------------------
// Shadow, strip, prestige, decay.
// ---------------------------------------------------------------------------

const cellCenter = (grid: Grid, x: number, y: number): Vec2 => ({
  x: (x + 0.5) * grid.cellSizeM,
  y: (y + 0.5) * grid.cellSizeM,
});

/** `Σ_megaSeeds (1 − smoothstep(0, shadowRadiusM, dist))` — Euclidean, not geodesic (design §3). */
const shadowField = (grid: Grid, megaSeeds: readonly Vec2[]): Field2D =>
  createField2D(grid.cells, grid.cellSizeM, (_index, x, y) => {
    const pos = cellCenter(grid, x, y);
    return megaSeeds.reduce(
      (sum, seed) =>
        sum + (1 - smoothstep(0, SOCIAL.shadowRadiusM, length(sub(pos, seed)))),
      0
    );
  });

/**
 * `strip` (design doc §6/§8 "stripAdjacency", produced here since `types.ts`
 * declares it on `SocialFields`): per-cell adjacency to the constructed shore
 * strip corridor from `anchors.stripAxis`. Design §3 stage 5 does not spell
 * out a formula for this field; it is built the same way every other stage-5
 * falloff is — a lateral `smoothstep` (perpendicular distance off the axis,
 * width `ANCHORS.waterBandNearM`, reusing the near-water proximity scale
 * rather than an unlisted constant) times a longitudinal one (within
 * `ANCHORS.stripHalfLengthM` of the origin, tapering over one more
 * `waterBandNearM` beyond it).
 */
const stripField = (grid: Grid, stripAxis: AnchorSet["stripAxis"]): Field2D => {
  const lateralWidth = ANCHORS.waterBandNearM;
  const longitudinalMargin = ANCHORS.waterBandNearM;
  return createField2D(grid.cells, grid.cellSizeM, (_index, x, y) => {
    const offset = sub(cellCenter(grid, x, y), stripAxis.origin);
    const along = Math.abs(dot(offset, stripAxis.dir));
    const lateral = Math.abs(cross(offset, stripAxis.dir));
    const lateralWeight = 1 - smoothstep(0, lateralWidth, lateral);
    const longitudinalWeight =
      1 -
      smoothstep(
        ANCHORS.stripHalfLengthM,
        ANCHORS.stripHalfLengthM + longitudinalMargin,
        along
      );
    return lateralWeight * longitudinalWeight;
  });
};

/**
 * `eminenceN`: `localEminence` is signed (elevation minus its own local
 * blur) with no declared unit range, and `constants.ts` fixes no scale for
 * it. Normalized against the field's own largest magnitude, preserving
 * sign — ridge crests stay positive, basins stay negative — the same
 * scale-invariant choice as `anchors.ts`'s `normalizeSlope`.
 */
const eminenceN = (localEminence: Field2D): Field2D => {
  const scale = Math.max(fieldMaxAbs(localEminence), 1e-9);
  return mapField(localEminence, (value) => clamp(value / scale, -1, 1));
};

const prestigeField = (derived: DerivedFields, shadow: Field2D): Field2D =>
  combineFields(
    [
      eminenceN(derived.localEminence),
      derived.distWater,
      derived.slope,
      derived.floodRisk,
      shadow,
    ],
    ([emin, distWater, slope, floodRisk, shadowValue]) =>
      clamp01(
        SOCIAL.prestige.eminence * emin +
          SOCIAL.prestige.waterBand *
            band(distWater, ANCHORS.waterBandNearM, ANCHORS.waterBandFarM) +
          SOCIAL.prestige.flatness *
            (1 -
              smoothstep(
                SOCIAL.flatnessSlopeLo,
                SOCIAL.flatnessSlopeHi,
                slope
              )) +
          SOCIAL.prestige.flood * floodRisk +
          SOCIAL.prestige.shadow * shadowValue
      )
  );

const decayField = (
  derived: DerivedFields,
  centrality: Field2D,
  shadow: Field2D,
  prestige: Field2D
): Field2D =>
  combineFields(
    [centrality, derived.floodRisk, derived.slope, shadow, prestige],
    ([centralityValue, floodRisk, slope, shadowValue, prestigeValue]) =>
      clamp01(
        SOCIAL.decay.remoteness * (1 - centralityValue) +
          SOCIAL.decay.flood * floodRisk +
          SOCIAL.decay.steepness *
            smoothstep(SOCIAL.steepSlopeLo, SOCIAL.steepSlopeHi, slope) +
          SOCIAL.decay.shadow * shadowValue +
          SOCIAL.decay.prestige * prestigeValue
      )
  );

// ---------------------------------------------------------------------------
// Stage entry point.
// ---------------------------------------------------------------------------

export interface SocialInput {
  readonly grid: Grid;
  readonly terrain: TerrainLayer;
  readonly derived: DerivedFields;
  readonly anchors: AnchorSet;
}

export const social: Stage<SocialInput, SocialFields> = (input) => {
  const { grid, terrain, derived, anchors: anchorSet } = input;
  const slopeN = normalizeSlope(derived.slope);
  const costSurface = costSurfaceField(grid, terrain, slopeN);
  const dCbd = geodesicDistanceFromCbd(grid, costSurface, anchorSet.cbd);
  const centrality = centralityField(dCbd);
  const shadow = shadowField(grid, anchorSet.megaSeeds);
  const strip = stripField(grid, anchorSet.stripAxis);
  const prestige = prestigeField(derived, shadow);
  const decay = decayField(derived, centrality, shadow, prestige);

  return { centrality, shadow, strip, prestige, decay };
};
