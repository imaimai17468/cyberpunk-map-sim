import type { Anchor, Field2D, Vec2 } from "@/entities/city";
import { ANCHORS } from "../constants";
import { fieldAt, mapField } from "../field/field2d";
import { length, normalize, perp, sub } from "../geometry/vec";
import type { AnchorSet, DerivedFields, Grid, Stage } from "./types";

/**
 * Stage 4 — anchors (design doc §3 stage 4, §6).
 *
 * Deterministic argmax over an {@link ANCHORS.downsample}x-downsampled grid
 * picks the CBD and the casino site; four megablock seeds come from greedy
 * farthest-point sampling over cells clearing a flat-and-dry threshold. The
 * casino's shore-strip axis is *constructed* (design §6, flaw #6): every seed
 * gets a corridor, rather than hoping a waterfront happens to align with a
 * street.
 *
 * No randomness is used anywhere in this stage — every pick is a deterministic
 * function of the terrain fields — so the `RngStream` parameter required by
 * {@link Stage} is accepted but not called.
 */

// ---------------------------------------------------------------------------
// Shared numeric primitives (also used by ../stages/social.ts).
// ---------------------------------------------------------------------------

/** Clamps `x` to `[0, 1]`. */
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Clamps `x` to `[lo, hi]`. */
export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/**
 * Classic smoothstep: 0 below `edge0`, 1 above `edge1`, cubic ease between.
 * `edge0` may be greater than `edge1` (a descending ramp) — every caller in
 * this generator relies on that, matching design doc §3's own
 * `smoothstep(8, 0, elev - sea)` convention.
 */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * A trapezoidal "am I near this feature, but not too near" score: 0 below
 * `near`, 1 across `[near, far]`, back to 0 by `far + near`. Design doc §3
 * writes this only as `band(distWater, 60-400 m)`; it does not spell out the
 * falloff shape. This reuses `near` as both transition widths (rather than
 * introducing an unlisted constant) — see the design-ambiguity note in the
 * anchors stage report.
 */
export const band = (d: number, near: number, far: number): number =>
  smoothstep(0, near, d) * (1 - smoothstep(far, far + near, d));

/** Largest absolute value in `field`, used to scale a field into a unit range. */
export const fieldMaxAbs = (field: Field2D): number =>
  field.data.reduce(
    (maxValue, value) => Math.max(maxValue, Math.abs(value)),
    0
  );

const NORMALIZE_EPSILON = 1e-9;

/**
 * `slopeN` (design doc §3 stage 4/5): the raw `slope` field is a gradient
 * magnitude with no declared unit range, but `(1 - slopeN)` and
 * `1 + 8*slopeN` (stage 5's cost surface) both need a value in `[0, 1]`.
 * `DerivedFields` carries no separate normalized field and `constants.ts`
 * declares no fixed slope scale, so this normalizes against the field's own
 * maximum on this map — scale-invariant across terrain amplitude tuning,
 * with no new magic constant.
 */
export const normalizeSlope = (slope: Field2D): Field2D => {
  const scale = Math.max(fieldMaxAbs(slope), NORMALIZE_EPSILON);
  return mapField(slope, (value) => clamp01(value / scale));
};

/** Index of the highest-scoring item, ties broken by the lowest index. */
export const argmaxIndex = (scores: readonly number[]): number =>
  scores.reduce(
    (bestIndex, score, index) =>
      score > scores[bestIndex] ? index : bestIndex,
    0
  );

// ---------------------------------------------------------------------------
// Downsampled candidate grid.
// ---------------------------------------------------------------------------

/** One cell of the downsampled argmax grid (design §3: "8x downsampled 64x64"). */
interface DownsampledCell {
  /** Row-major index within the downsampled grid. */
  readonly index: number;
  /** Row-major index of the representative fine cell, into every `Field2D`. */
  readonly fineIndex: number;
  /** Metre-space position of the representative fine cell's centre. */
  readonly pos: Vec2;
}

/**
 * Builds the downsampled candidate grid: `ANCHORS.downsample`x-downsampled,
 * each coarse cell represented by the fine cell nearest its centre. Coarse
 * row-major order is monotonic with the represented fine row-major order (the
 * offset added by centring is the same for every cell), so tie-breaking by
 * the lowest `index` here is equivalent to tie-breaking by the lowest fine
 * cell index.
 */
const downsampledCells = (grid: Grid): readonly DownsampledCell[] => {
  const factor = ANCHORS.downsample;
  const coarseCells = Math.max(1, Math.floor(grid.cells / factor));
  const centreOffset = Math.floor(factor / 2);
  return Array.from({ length: coarseCells * coarseCells }, (_value, index) => {
    const coarseX = index % coarseCells;
    const coarseY = Math.floor(index / coarseCells);
    const fineX = Math.min(grid.cells - 1, coarseX * factor + centreOffset);
    const fineY = Math.min(grid.cells - 1, coarseY * factor + centreOffset);
    return {
      index,
      fineIndex: fineY * grid.cells + fineX,
      pos: {
        x: (fineX + 0.5) * grid.cellSizeM,
        y: (fineY + 0.5) * grid.cellSizeM,
      },
    };
  });
};

// ---------------------------------------------------------------------------
// Geometry helpers with no dedicated constant (documented design choices).
// ---------------------------------------------------------------------------

/** 1 at the map centre, 0 at a corner — no unlisted constant, scaled by `grid.sizeM`. */
const centerBias = (grid: Grid, pos: Vec2): number => {
  const center: Vec2 = { x: grid.sizeM / 2, y: grid.sizeM / 2 };
  const halfDiagonal = Math.sqrt(2) * (grid.sizeM / 2);
  return 1 - clamp01(length(sub(pos, center)) / halfDiagonal);
};

/**
 * 1 at the CBD itself, smoothstepping to 0 by a full map diagonal away —
 * design doc §3 names "CBD proximity" as one factor of the casino score
 * without a distance scale, so this reuses the map's own extent rather than
 * inventing a constant.
 */
const cbdProximity = (grid: Grid, pos: Vec2, cbd: Vec2): number => {
  const mapDiagonal = Math.sqrt(2) * grid.sizeM;
  return smoothstep(mapDiagonal, 0, length(sub(pos, cbd)));
};

// ---------------------------------------------------------------------------
// CBD, megablock seeds, casino.
// ---------------------------------------------------------------------------

const cbdScore = (
  grid: Grid,
  slopeN: Field2D,
  derived: DerivedFields,
  cell: DownsampledCell
): number =>
  ANCHORS.cbdSlopeWeight * (1 - slopeN.data[cell.fineIndex]) +
  ANCHORS.cbdWaterBandWeight *
    band(
      derived.distWater.data[cell.fineIndex],
      ANCHORS.waterBandNearM,
      ANCHORS.waterBandFarM
    ) +
  ANCHORS.cbdCenterWeight * centerBias(grid, cell.pos);

const pickCbd = (
  grid: Grid,
  slopeN: Field2D,
  derived: DerivedFields,
  cells: readonly DownsampledCell[]
): DownsampledCell =>
  cells[
    argmaxIndex(cells.map((cell) => cbdScore(grid, slopeN, derived, cell)))
  ];

/** Cells clearing the flat-and-dry threshold (design §3: `(1-slopeN)*(1-floodRisk) > 0.6`). */
const megaSeedCandidates = (
  slopeN: Field2D,
  derived: DerivedFields,
  cells: readonly DownsampledCell[]
): readonly DownsampledCell[] =>
  cells.filter(
    (cell) =>
      (1 - slopeN.data[cell.fineIndex]) *
        (1 - derived.floodRisk.data[cell.fineIndex]) >
      ANCHORS.megaSeedThreshold
  );

const minDistanceToChosen = (pos: Vec2, chosen: readonly Vec2[]): number =>
  chosen.reduce(
    (closest, seed) => Math.min(closest, length(sub(pos, seed))),
    Number.POSITIVE_INFINITY
  );

/** One greedy farthest-point step: the pool cell farthest from every chosen seed so far. */
const pickFarthest = (
  pool: readonly DownsampledCell[],
  chosen: readonly Vec2[]
): DownsampledCell =>
  pool[argmaxIndex(pool.map((cell) => minDistanceToChosen(cell.pos, chosen)))];

interface FpsAccumulator {
  readonly chosen: readonly Vec2[];
  readonly remaining: readonly DownsampledCell[];
}

/**
 * Greedy farthest-point sampling: the first seed is the lowest-index
 * candidate (design §3/§10's tie-break convention applied to "no prior seed
 * to be far from"); each subsequent seed maximizes the minimum distance to
 * every already-chosen seed. Bounded to `count - 1` reduce steps — `count`
 * is the small fixed `ANCHORS.megaSeedCount`, never data-sized, so this is a
 * bounded reduce, not a per-cell loop.
 *
 * Every caller passes `ANCHORS.megaSeedCount` (a positive compile-time
 * constant) for `count`, and `pool` is always either the threshold-passing
 * candidates or `downsampledCells(grid)` itself, which never returns fewer
 * than one cell (its coarse grid size is `Math.max(1, ...)`) — so `pool` is
 * never empty here. If `pool` runs out before `count` seeds are chosen
 * (only possible on a pathologically small/candidate-starved grid — never
 * on a real generation grid, where the threshold leaves thousands of
 * candidates), the remaining slots are simply not filled rather than
 * duplicating a seed or crashing.
 */
const farthestPointSample = (
  pool: readonly DownsampledCell[],
  count: number
): readonly Vec2[] => {
  const first = pool[0];
  const initial: FpsAccumulator = {
    chosen: [first.pos],
    remaining: pool.filter((cell) => cell.index !== first.index),
  };
  return Array.from({ length: count - 1 }).reduce<FpsAccumulator>((acc) => {
    if (acc.remaining.length === 0) return acc;
    const next = pickFarthest(acc.remaining, acc.chosen);
    return {
      chosen: [...acc.chosen, next.pos],
      remaining: acc.remaining.filter((cell) => cell.index !== next.index),
    };
  }, initial).chosen;
};

const casinoScore = (
  grid: Grid,
  slopeN: Field2D,
  derived: DerivedFields,
  cbd: Vec2,
  cell: DownsampledCell
): number =>
  band(
    derived.distWater.data[cell.fineIndex],
    ANCHORS.waterBandNearM,
    ANCHORS.waterBandFarM
  ) *
  (1 - slopeN.data[cell.fineIndex]) *
  cbdProximity(grid, cell.pos, cbd);

const pickCasino = (
  grid: Grid,
  slopeN: Field2D,
  derived: DerivedFields,
  cbd: DownsampledCell,
  cells: readonly DownsampledCell[]
): DownsampledCell => {
  // Falls back to the full (unfiltered) list on the degenerate downsampled
  // grid that has only a single cell in total — never on any real
  // generation grid, where the downsampled grid always has thousands of
  // cells, but a stage function must still return an anchor rather than
  // crash on a pathologically small input.
  const excludingCbd = cells.filter((cell) => cell.index !== cbd.index);
  const candidates = excludingCbd.length > 0 ? excludingCbd : cells;
  return candidates[
    argmaxIndex(
      candidates.map((cell) =>
        casinoScore(grid, slopeN, derived, cbd.pos, cell)
      )
    )
  ];
};

// ---------------------------------------------------------------------------
// Constructed strip axis.
// ---------------------------------------------------------------------------

const GRADIENT_FALLBACK_DIR: Vec2 = { x: 1, y: 0 };

/** Central-difference gradient of `field` at grid coordinates `(cx, cy)`. */
const gradientAt = (field: Field2D, cx: number, cy: number): Vec2 => ({
  x:
    (fieldAt(field, cx + 1, cy) - fieldAt(field, cx - 1, cy)) /
    (2 * field.cellSizeM),
  y:
    (fieldAt(field, cx, cy + 1) - fieldAt(field, cx, cy - 1)) /
    (2 * field.cellSizeM),
});

/**
 * The shore tangent at `pos`: the water-distance gradient (points away from
 * water, across the shoreline) rotated 90 degrees, giving the direction the
 * shoreline itself runs. This is the "constructed, not discovered" strip
 * axis direction (design §6, flaw #6) — it exists at the casino anchor on
 * every seed, independent of whether any actual waterfront street would have
 * aligned there.
 */
const shoreTangentAt = (distWater: Field2D, pos: Vec2): Vec2 => {
  const cx = Math.round(pos.x / distWater.cellSizeM);
  const cy = Math.round(pos.y / distWater.cellSizeM);
  return normalize(perp(gradientAt(distWater, cx, cy)), GRADIENT_FALLBACK_DIR);
};

// ---------------------------------------------------------------------------
// Stage entry point.
// ---------------------------------------------------------------------------

export interface AnchorsInput {
  readonly grid: Grid;
  readonly derived: DerivedFields;
}

export const anchors: Stage<AnchorsInput, AnchorSet> = (input) => {
  const { grid, derived } = input;
  const slopeN = normalizeSlope(derived.slope);
  const cells = downsampledCells(grid);

  const cbdCell = pickCbd(grid, slopeN, derived, cells);

  const megaPool = megaSeedCandidates(slopeN, derived, cells);
  const megaSeeds = farthestPointSample(
    megaPool.length >= ANCHORS.megaSeedCount ? megaPool : cells,
    ANCHORS.megaSeedCount
  );

  const casinoCell = pickCasino(grid, slopeN, derived, cbdCell, cells);

  const stripAxis = {
    origin: casinoCell.pos,
    dir: shoreTangentAt(derived.distWater, casinoCell.pos),
  };

  const anchorList: readonly Anchor[] = [
    { kind: "cbd", pos: cbdCell.pos },
    ...megaSeeds.map((pos): Anchor => ({ kind: "mega", pos })),
    { kind: "casino", pos: casinoCell.pos },
  ];

  return {
    anchors: anchorList,
    cbd: cbdCell.pos,
    megaSeeds,
    casino: casinoCell.pos,
    stripAxis,
  };
};
