import type { Field2D } from "@/entities/city";
import { createField2D } from "../field/field2d";
import { domainWarp2D, fbm2D, ridgedFbm2D } from "../field/noise";
import type { FbmOptions } from "../field/noise";
import type { RngStream } from "../rng/types";
import { TERRAIN } from "../constants";
import type { Grid, Stage } from "./types";

/**
 * Stage 1 — terrain (design doc §3 stage 1): elevation via 6-octave fBm,
 * a 2-octave domain warp, and a 25% ridged-multifractal blend for one
 * dominant ridge, normalized to `[0, TERRAIN.maxElevationM]`.
 *
 * Loop-free per §12: the grid fill goes through `createField2D`'s
 * `Float32Array.from`; normalization is two `reduce` scans (min, max) plus
 * one `Float32Array.from` rescale. No recursion anywhere in this stage.
 */

/** 2^32 — the exact upper bound handed to `nextInt` for a raw 32-bit seed. */
const SEED_RANGE = 0x100000000;

interface TerrainSeeds {
  readonly baseSeed: number;
  readonly ridgedSeed: number;
  readonly warpSeed: number;
}

/** Three independent 32-bit seeds drawn from the stage's own stream. */
const drawSeeds = (stream: RngStream): TerrainSeeds => ({
  baseSeed: stream.nextInt(SEED_RANGE),
  ridgedSeed: stream.nextInt(SEED_RANGE),
  warpSeed: stream.nextInt(SEED_RANGE),
});

const FBM_OPTIONS: FbmOptions = {
  octaves: TERRAIN.octaves,
  lacunarity: TERRAIN.lacunarity,
  gain: TERRAIN.gain,
};

/**
 * Raw (unnormalized) elevation at one grid cell: the domain-warped
 * coordinate is sampled by both the plain fBm and the ridged-multifractal
 * fBm, blended `TERRAIN.ridgedBlend` toward the ridged variant. The plain
 * fBm (roughly `[-1, 1]`) is rescaled to `[0, 1]` before blending so both
 * terms share the same range; the final global normalization (see
 * {@link normalizeToElevationRange}) is what actually guarantees the
 * `[0, maxElevationM]` output range, so this intermediate scaling only
 * needs to keep the blend meaningful, not exact.
 */
const rawElevationAt = (
  seeds: TerrainSeeds,
  cellSizeM: number,
  cx: number,
  cy: number
): number => {
  const worldX = cx * cellSizeM;
  const worldY = cy * cellSizeM;
  const warped = domainWarp2D(seeds.warpSeed, worldX, worldY, {
    amplitude: TERRAIN.warpAmplitudeM,
    frequency: TERRAIN.baseFrequency,
    octaves: TERRAIN.warpOctaves,
    lacunarity: TERRAIN.lacunarity,
    gain: TERRAIN.gain,
  });
  const nx = warped.x * TERRAIN.baseFrequency;
  const ny = warped.y * TERRAIN.baseFrequency;
  const base = fbm2D(seeds.baseSeed, nx, ny, FBM_OPTIONS);
  const ridged = ridgedFbm2D(seeds.ridgedSeed, nx, ny, FBM_OPTIONS);
  const baseNormalized = (base + 1) / 2;
  return (
    (1 - TERRAIN.ridgedBlend) * baseNormalized + TERRAIN.ridgedBlend * ridged
  );
};

/**
 * Rescales `field` so its minimum and maximum map to `0` and
 * `TERRAIN.maxElevationM`. When every cell holds the same value (the
 * degenerate single-cell or perfectly-flat case) the range is zero, so the
 * result is `0` everywhere rather than dividing by zero.
 */
const normalizeToElevationRange = (field: Field2D): Field2D => {
  const min = field.data.reduce(
    (acc, value) => Math.min(acc, value),
    Number.POSITIVE_INFINITY
  );
  const max = field.data.reduce(
    (acc, value) => Math.max(acc, value),
    Number.NEGATIVE_INFINITY
  );
  const range = max - min;
  return {
    cells: field.cells,
    cellSizeM: field.cellSizeM,
    data: Float32Array.from(field.data, (value) =>
      range > 0 ? ((value - min) / range) * TERRAIN.maxElevationM : 0
    ),
  };
};

export type TerrainStage = Stage<Grid, Field2D>;

/** Stage 1: `Grid` geometry in, normalized elevation `Field2D` out. */
export const terrainStage: TerrainStage = (grid, stream) => {
  const seeds = drawSeeds(stream);
  const raw = createField2D(grid.cells, grid.cellSizeM, (_index, x, y) =>
    rawElevationAt(seeds, grid.cellSizeM, x, y)
  );
  return normalizeToElevationRange(raw);
};
