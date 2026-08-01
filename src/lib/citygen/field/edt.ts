import type { Field2D } from "@/entities/city";

/**
 * Exact squared-Euclidean distance transform (Felzenszwalb & Huttenlocher,
 * "Distance Transforms of Sampled Functions"): per-line lower envelope of
 * parabolas, applied per-row then per-column (design doc §3 stage 3, §12).
 *
 * Non-source cells are conventionally fed in as `+Infinity`.
 * {@link distanceTransform1D} replaces every non-finite entry with a large
 * finite sentinel before running the envelope algorithm — subtracting two
 * `+Infinity`s (`Infinity - Infinity`) is `NaN`, and `-Infinity <= -Infinity`
 * is `true` in IEEE-754, which would otherwise pop the envelope below its
 * floor. A large *finite* sentinel keeps every intersection computation
 * finite and never accidentally satisfies that comparison, while still
 * comparing as "arbitrarily far" against any real in-line distance.
 *
 * Loop-free per §12: the two scans below are `Array.from(...).reduce(...)`
 * over a statically-known-length index array; only the envelope-popping and
 * envelope-walking steps recurse, each bounded by the line length (≤ 1024
 * for the largest supported grid), far under the ~9,765-frame engine limit.
 */

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;
const POSITIVE_INFINITY = Number.POSITIVE_INFINITY;

/**
 * Replaces every non-finite entry with a sentinel comfortably larger than
 * any finite value present plus the largest possible in-line squared
 * position offset (`n²`) — see the module doc for why this must be finite.
 */
const sanitizeLine = (f: Float64Array): Float64Array => {
  const maxFinite = f.reduce(
    (max, value) => (Number.isFinite(value) && value > max ? value : max),
    0
  );
  const sentinel = maxFinite + f.length * f.length + 1;
  return Float64Array.from(f, (value) =>
    Number.isFinite(value) ? value : sentinel
  );
};

/** X-coordinate where the parabolas rooted at `i` and `q` intersect. */
const parabolaIntersection = (f: Float64Array, i: number, q: number): number =>
  (f[q] + q * q - (f[i] + i * i)) / (2 * q - 2 * i);

/**
 * Pops envelope entries dominated by the parabola rooted at `q`, returning
 * the surviving index and the (now valid) intersection there. Recursion
 * depth is bounded by the current envelope size (`k`), which never exceeds
 * the line length.
 */
const popDominated = (
  f: Float64Array,
  v: Int32Array,
  z: Float64Array,
  k: number,
  q: number
): { readonly k: number; readonly s: number } => {
  const s = parabolaIntersection(f, v[k], q);
  return s <= z[k] ? popDominated(f, v, z, k - 1, q) : { k, s };
};

interface Envelope {
  readonly v: Int32Array;
  readonly z: Float64Array;
}

/** Builds the lower envelope of parabolas rooted at each sample of `f`. */
const buildLowerEnvelope = (f: Float64Array, n: number): Envelope => {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  v[0] = 0;
  z[0] = NEGATIVE_INFINITY;
  z[1] = POSITIVE_INFINITY;
  Array.from({ length: n - 1 }, (_value, offset) => offset + 1).reduce(
    (k, q) => {
      const popped = popDominated(f, v, z, k, q);
      const nextK = popped.k + 1;
      v[nextK] = q;
      z[nextK] = popped.s;
      z[nextK + 1] = POSITIVE_INFINITY;
      return nextK;
    },
    0
  );
  return { v, z };
};

/**
 * Advances the envelope pointer until `z[k]..z[k+1]` covers `q`. Recursion
 * depth is bounded by the envelope size, same limit as {@link popDominated}.
 */
const advanceEnvelopeIndex = (z: Float64Array, k: number, q: number): number =>
  z[k + 1] < q ? advanceEnvelopeIndex(z, k + 1, q) : k;

/** Reads the squared distance at every position from the built envelope. */
const fillFromEnvelope = (
  f: Float64Array,
  envelope: Envelope,
  n: number
): Float64Array => {
  const d = new Float64Array(n);
  Array.from({ length: n }, (_value, q) => q).reduce((k, q) => {
    const nextK = advanceEnvelopeIndex(envelope.z, k, q);
    const diff = q - envelope.v[nextK];
    d[q] = diff * diff + f[envelope.v[nextK]];
    return nextK;
  }, 0);
  return d;
};

/**
 * Exact 1D squared-distance transform: for every index `q`, the minimum
 * over all `i` of `(q - i)² + f[i]`. Feed `0` at source samples and
 * `Infinity` (or any large value) elsewhere.
 */
export const distanceTransform1D = (f: Float64Array): Float64Array => {
  const n = f.length;
  if (n === 0) {
    return new Float64Array(0);
  }
  const sanitized = sanitizeLine(f);
  if (n === 1) {
    return Float64Array.from(sanitized);
  }
  const envelope = buildLowerEnvelope(sanitized, n);
  return fillFromEnvelope(sanitized, envelope, n);
};

/**
 * Exact 2D squared-Euclidean distance transform over a `cells × cells`
 * grid: a row-wise pass (indicator along x) followed by a column-wise pass
 * (using the row pass's output), per the standard two-pass FH method.
 * `isSeed(index)` marks source cells (distance 0) by linear row-major index.
 */
export const squaredEuclideanDistanceTransform = (
  isSeed: (index: number) => boolean,
  cells: number
): Float64Array => {
  const rowPass = new Float64Array(cells * cells);
  Array.from({ length: cells }, (_value, y) => y).forEach((y) => {
    const rowInput = Float64Array.from({ length: cells }, (_value, x) =>
      isSeed(y * cells + x) ? 0 : POSITIVE_INFINITY
    );
    distanceTransform1D(rowInput).forEach((value, x) => {
      rowPass[y * cells + x] = value;
    });
  });
  const result = new Float64Array(cells * cells);
  Array.from({ length: cells }, (_value, x) => x).forEach((x) => {
    const colInput = Float64Array.from(
      { length: cells },
      (_value, y) => rowPass[y * cells + x]
    );
    distanceTransform1D(colInput).forEach((value, y) => {
      result[y * cells + x] = value;
    });
  });
  return result;
};

/**
 * {@link squaredEuclideanDistanceTransform}, converted to an actual-distance
 * `Field2D` in metres (`sqrt(squared) * cellSizeM`).
 */
export const euclideanDistanceTransform = (
  isSeed: (index: number) => boolean,
  cells: number,
  cellSizeM: number
): Field2D => {
  const squared = squaredEuclideanDistanceTransform(isSeed, cells);
  const data = Float32Array.from(
    squared,
    (value) => Math.sqrt(value) * cellSizeM
  );
  return { cells, cellSizeM, data };
};
