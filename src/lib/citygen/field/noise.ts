import type { Vec2 } from "@/entities/city";
import { splitmix32 } from "../rng/hash";

/**
 * 2D gradient noise in the simplex family (OpenSimplex2S-style: a skewed
 * triangular lattice, gradients selected by integer hashing rather than a
 * permutation table), plus fBm, domain warp, and a ridged-multifractal
 * variant built on top of it.
 *
 * Determinism (design doc §5): only `+ - * /`, `Math.sqrt/floor/abs`,
 * `Math.imul` and bitwise ops appear anywhere below. No
 * `sin/cos/tan/exp/log/pow/atan2/hypot`, no `**`, no `Math.random`.
 */

/** `0.5 * (sqrt(3) - 1)` — skews (x, y) onto the simplex triangle grid. */
const SKEW_2D = 0.5 * (Math.sqrt(3) - 1);
/** `(3 - sqrt(3)) / 6` — unskews a lattice point back to noise space. */
const UNSKEW_2D = (3 - Math.sqrt(3)) / 6;

/** The eight lattice gradients used by classic 2D simplex noise. */
const GRADIENTS_2D: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

const GRID_HASH_X = 0x27d4eb2f;
const GRID_HASH_Y = 0x165667b1;

/** Folds a 32-bit state and one lattice coordinate into a new 32-bit state. */
const mixCoord = (state: number, coord: number, multiplier: number): number =>
  splitmix32((state ^ Math.imul(coord | 0, multiplier)) | 0).state;

/** Deterministic gradient for one lattice point, given the noise's seed. */
const gradientAt = (
  seed: number,
  i: number,
  j: number
): readonly [number, number] => {
  const mixedX = mixCoord(seed, i, GRID_HASH_X);
  const mixedY = mixCoord(mixedX, j, GRID_HASH_Y);
  const index = splitmix32(mixedY).value % GRADIENTS_2D.length;
  return GRADIENTS_2D[index];
};

/** Squared falloff radius of one simplex corner's contribution. */
const CONTRIBUTION_RADIUS_SQ = 0.5;

/** One lattice corner's contribution to the simplex value; 0 outside its radius. */
const cornerContribution = (
  seed: number,
  i: number,
  j: number,
  dx: number,
  dy: number
): number => {
  const fade = CONTRIBUTION_RADIUS_SQ - dx * dx - dy * dy;
  if (fade <= 0) {
    return 0;
  }
  const [gx, gy] = gradientAt(seed, i, j);
  const fadeSquared = fade * fade;
  return fadeSquared * fadeSquared * (gx * dx + gy * dy);
};

/** Empirical output scale bringing the raw corner sum roughly into [-1, 1]. */
const NOISE_SCALE = 70;

/**
 * 2D simplex-style gradient noise, roughly in `[-1, 1]`. Deterministic in
 * `seed`, `x`, `y`.
 */
export const noise2D = (seed: number, x: number, y: number): number => {
  const skew = (x + y) * SKEW_2D;
  const i = Math.floor(x + skew);
  const j = Math.floor(y + skew);
  const unskew = (i + j) * UNSKEW_2D;
  const originX = i - unskew;
  const originY = j - unskew;
  const dx0 = x - originX;
  const dy0 = y - originY;

  const [i1, j1] = dx0 > dy0 ? [1, 0] : [0, 1];

  const dx1 = dx0 - i1 + UNSKEW_2D;
  const dy1 = dy0 - j1 + UNSKEW_2D;
  const dx2 = dx0 - 1 + 2 * UNSKEW_2D;
  const dy2 = dy0 - 1 + 2 * UNSKEW_2D;

  const n0 = cornerContribution(seed, i, j, dx0, dy0);
  const n1 = cornerContribution(seed, i + i1, j + j1, dx1, dy1);
  const n2 = cornerContribution(seed, i + 1, j + 1, dx2, dy2);

  return NOISE_SCALE * (n0 + n1 + n2);
};

const OCTAVE_SALT = 0x9e3779b1;

/** Derives an independent per-octave seed so octaves don't share a lattice. */
const octaveSeed = (seed: number, octave: number): number =>
  splitmix32((seed ^ Math.imul(octave + 1, OCTAVE_SALT)) | 0).value;

export interface FbmOptions {
  readonly octaves?: number;
  readonly lacunarity?: number;
  readonly gain?: number;
}

const DEFAULT_OCTAVES = 6;
const DEFAULT_LACUNARITY = 2;
const DEFAULT_GAIN = 0.5;

interface FbmAccumulator {
  readonly sum: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly amplitudeSum: number;
}

const INITIAL_FBM_ACCUMULATOR: FbmAccumulator = {
  sum: 0,
  amplitude: 1,
  frequency: 1,
  amplitudeSum: 0,
};

/** Normalizes a weighted-octave sum by the total amplitude actually used. */
const normalizeAccumulator = (acc: FbmAccumulator): number =>
  acc.amplitudeSum > 0 ? acc.sum / acc.amplitudeSum : 0;

/**
 * How an octave's raw sample is weighted before it is summed.
 *
 * The two variants differ in this and in nothing else, so it is the parameter
 * rather than the function: plain and ridged fBm were two copies of the same
 * octave fold and the same octave schedule, agreeing on the accumulator, the
 * defaults and the normalizer, which is a shape one edit can make inconsistent.
 */
type OctaveTransform = (raw: number) => number;

const PLAIN: OctaveTransform = (raw) => raw;

/** The "one dominant ridge" transform (design §3 stage 1). */
const RIDGED: OctaveTransform = (raw) => 1 - Math.abs(raw);

/** One octave folded into the running accumulator under `transform`. */
const accumulateOctave = (
  transform: OctaveTransform,
  seed: number,
  x: number,
  y: number,
  gain: number,
  lacunarity: number,
  acc: FbmAccumulator,
  octave: number
): FbmAccumulator => {
  const raw = noise2D(
    octaveSeed(seed, octave),
    x * acc.frequency,
    y * acc.frequency
  );
  return {
    sum: acc.sum + transform(raw) * acc.amplitude,
    amplitude: acc.amplitude * gain,
    frequency: acc.frequency * lacunarity,
    amplitudeSum: acc.amplitudeSum + acc.amplitude,
  };
};

const octaveIndices = (octaves: number): readonly number[] =>
  Array.from({ length: octaves }, (_value, octave) => octave);

/** The octave schedule both variants run: defaults, fold, normalize. */
const foldOctaves = (
  transform: OctaveTransform,
  seed: number,
  x: number,
  y: number,
  options: FbmOptions | undefined
): number => {
  const octaves = options?.octaves ?? DEFAULT_OCTAVES;
  const lacunarity = options?.lacunarity ?? DEFAULT_LACUNARITY;
  const gain = options?.gain ?? DEFAULT_GAIN;
  return normalizeAccumulator(
    octaveIndices(octaves).reduce<FbmAccumulator>(
      (acc, octave) =>
        accumulateOctave(transform, seed, x, y, gain, lacunarity, acc, octave),
      INITIAL_FBM_ACCUMULATOR
    )
  );
};

/**
 * Fractal Brownian motion: `octaves` (default 6) layers of `noise2D` at
 * doubling frequency (`lacunarity`, default 2.0) and halving amplitude
 * (`gain`, default 0.5), normalized to stay roughly in `[-1, 1]` regardless
 * of octave count.
 */
export const fbm2D = (
  seed: number,
  x: number,
  y: number,
  options?: FbmOptions
): number => foldOctaves(PLAIN, seed, x, y, options);

/**
 * Ridged-multifractal fBm: identical octave/lacunarity/gain shape as
 * {@link fbm2D}, but each octave is transformed by `1 - |n|` before being
 * weighted in — the "one dominant ridge" variant (design §3 stage 1).
 * Result stays roughly in `[0, 1]`.
 */
export const ridgedFbm2D = (
  seed: number,
  x: number,
  y: number,
  options?: FbmOptions
): number => foldOctaves(RIDGED, seed, x, y, options);

export interface DomainWarpOptions {
  readonly amplitude: number;
  readonly frequency?: number;
  readonly octaves?: number;
  readonly lacunarity?: number;
  readonly gain?: number;
}

const DEFAULT_WARP_OCTAVES = 2;
const WARP_X_SALT = 0x1f83d9ab;
const WARP_Y_SALT = 0x2545f491;

/**
 * Domain warp: offsets `(x, y)` by two independent 2-octave fBm fields
 * scaled by `options.amplitude`, before the caller re-samples any noise at
 * the warped position. `frequency` scales the warp's own sampling
 * coordinates (default 1 — same space as `x`/`y`).
 */
export const domainWarp2D = (
  seed: number,
  x: number,
  y: number,
  options: DomainWarpOptions
): Vec2 => {
  const frequency = options.frequency ?? 1;
  const fbmOptions: FbmOptions = {
    octaves: options.octaves ?? DEFAULT_WARP_OCTAVES,
    lacunarity: options.lacunarity ?? DEFAULT_LACUNARITY,
    gain: options.gain ?? DEFAULT_GAIN,
  };
  const seedX = splitmix32((seed ^ WARP_X_SALT) | 0).value;
  const seedY = splitmix32((seed ^ WARP_Y_SALT) | 0).value;
  const dx =
    fbm2D(seedX, x * frequency, y * frequency, fbmOptions) * options.amplitude;
  const dy =
    fbm2D(seedY, x * frequency, y * frequency, fbmOptions) * options.amplitude;
  return { x: x + dx, y: y + dy };
};
