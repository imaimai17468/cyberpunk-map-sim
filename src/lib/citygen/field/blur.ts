import type { Field2D } from "@/entities/city";

/**
 * Separable box blur via prefix sums (design doc §3 stage 3's
 * `localEminence`, 3 passes, radius given in cells).
 *
 * Each 1D pass computes a running prefix sum (`Array.prototype.reduce`) and
 * then reads every output cell as a difference of two prefix-sum lookups —
 * O(n) per line with no loop statement. At the border the averaging window
 * shrinks to what's actually on the grid (clamp, not wrap and not a
 * fixed-size read past the edge), so edge cells are a genuine average of
 * fewer samples rather than an extrapolated one.
 */

/** `prefix[i]` = sum of `values[0..i-1]`; `prefix.length === values.length + 1`. */
const prefixSum = (values: Float64Array): Float64Array => {
  const prefix = new Float64Array(values.length + 1);
  values.reduce((runningTotal, value, index) => {
    const next = runningTotal + value;
    prefix[index + 1] = next;
    return next;
  }, 0);
  return prefix;
};

/** 1D box blur of `radius` cells either side, via one prefix-sum pass. */
const boxBlur1D = (values: Float64Array, radius: number): Float64Array => {
  const n = values.length;
  const prefix = prefixSum(values);
  return Float64Array.from({ length: n }, (_value, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    const windowSum = prefix[hi + 1] - prefix[lo];
    const windowCount = hi - lo + 1;
    return windowSum / windowCount;
  });
};

/** Reads grid row `y` into an owned buffer. */
const readRow = (data: Float32Array, cells: number, y: number): Float64Array =>
  Float64Array.from({ length: cells }, (_value, x) => data[y * cells + x]);

/** Reads grid column `x` into an owned buffer. */
const readColumn = (
  data: Float64Array,
  cells: number,
  x: number
): Float64Array =>
  Float64Array.from({ length: cells }, (_value, y) => data[y * cells + x]);

/** One separable 2D box blur pass: every row, then every column. */
const boxBlurPass = (field: Field2D, radiusCells: number): Field2D => {
  const { cells, cellSizeM, data } = field;
  const rowBlurred = new Float64Array(cells * cells);
  Array.from({ length: cells }, (_value, y) => y).forEach((y) => {
    boxBlur1D(readRow(data, cells, y), radiusCells).forEach((value, x) => {
      rowBlurred[y * cells + x] = value;
    });
  });
  const colBlurred = new Float64Array(cells * cells);
  Array.from({ length: cells }, (_value, x) => x).forEach((x) => {
    boxBlur1D(readColumn(rowBlurred, cells, x), radiusCells).forEach(
      (value, y) => {
        colBlurred[y * cells + x] = value;
      }
    );
  });
  return { cells, cellSizeM, data: Float32Array.from(colBlurred) };
};

const PASS_COUNT = 3;

/**
 * Separable box blur, `radiusCells` cells either side, repeated
 * {@link PASS_COUNT} (3) times — the standard cheap approximation of a
 * Gaussian blur used for stage 3's `localEminence`.
 */
export const boxBlur3Pass = (field: Field2D, radiusCells: number): Field2D => {
  if (!Number.isInteger(radiusCells) || radiusCells < 0) {
    throw new RangeError("boxBlur3Pass requires a non-negative integer radius");
  }
  return Array.from({ length: PASS_COUNT }).reduce<Field2D>(
    (acc) => boxBlurPass(acc, radiusCells),
    field
  );
};
