import type { Field2D } from "@/entities/city";

/**
 * Core helpers over `Field2D` (design doc §4): a dense row-major scalar grid.
 * Every function here is pure and loop-free — grid fills go through
 * `Float32Array.from`/`.map`, never a `for`/`while` statement (AGENTS.md
 * `style-rules/no-loops`).
 */

/**
 * Creates a `Field2D`. Without `fill` the data is zero-initialized; with
 * `fill` every cell is computed from its linear index and (x, y) grid
 * coordinates, entirely via `Float32Array.from` (no loop statement).
 */
export const createField2D = (
  cells: number,
  cellSizeM: number,
  fill?: (index: number, x: number, y: number) => number
): Field2D => {
  const data = fill
    ? Float32Array.from({ length: cells * cells }, (_value, index) =>
        fill(index, index % cells, Math.floor(index / cells))
      )
    : new Float32Array(cells * cells);
  return { cells, cellSizeM, data };
};

/**
 * Row-major linear index for grid coordinates `(cx, cy)`, clamped to the
 * field's bounds (clamp-to-edge — every out-of-range read resolves to the
 * nearest border cell rather than wrapping or throwing).
 */
export const fieldIndex = (field: Field2D, cx: number, cy: number): number => {
  const maxIndex = field.cells - 1;
  const clampedX = Math.min(Math.max(Math.floor(cx), 0), maxIndex);
  const clampedY = Math.min(Math.max(Math.floor(cy), 0), maxIndex);
  return clampedY * field.cells + clampedX;
};

/** Reads the value at grid coordinates `(cx, cy)`, clamped to the field's bounds. */
export const fieldAt = (field: Field2D, cx: number, cy: number): number =>
  field.data[fieldIndex(field, cx, cy)];

/**
 * Bilinear sample at fractional grid coordinates `(x, y)`. Coordinates
 * outside `[0, cells - 1]` clamp to the border cell (via `fieldAt`), so the
 * sampled surface never wraps and never reads out of bounds.
 */
export const bilinearSample = (
  field: Field2D,
  x: number,
  y: number
): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const v00 = fieldAt(field, x0, y0);
  const v10 = fieldAt(field, x0 + 1, y0);
  const v01 = fieldAt(field, x0, y0 + 1);
  const v11 = fieldAt(field, x0 + 1, y0 + 1);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
};

/** Maps every cell of `field` through `f(value, index)`, preserving shape. */
export const mapField = (
  field: Field2D,
  f: (value: number, index: number) => number
): Field2D => ({
  cells: field.cells,
  cellSizeM: field.cellSizeM,
  data: Float32Array.from(field.data, f),
});

/**
 * Combines any number of same-shaped fields cell-by-cell. `combine` receives
 * the per-field values at each index in the same order as `fields`, plus the
 * linear index itself (for position-dependent combinators).
 *
 * A single n-ary primitive covers both the pairwise case (stage 3's
 * `floodRisk` from two fields) and the wider argmax-style combinations later
 * stages need (e.g. zoning's five-field affinities) without adding a second
 * binary-only helper.
 */
export const combineFields = (
  fields: readonly Field2D[],
  combine: (values: readonly number[], index: number) => number
): Field2D => {
  const [first, ...rest] = fields;
  if (!first) {
    throw new RangeError("combineFields requires at least one field");
  }
  const mismatched = rest.some(
    (field) =>
      field.cells !== first.cells || field.cellSizeM !== first.cellSizeM
  );
  if (mismatched) {
    throw new RangeError(
      "combineFields requires every field to share cells and cellSizeM"
    );
  }
  const data = Float32Array.from(
    { length: first.data.length },
    (_value, index) =>
      combine(
        fields.map((field) => field.data[index]),
        index
      )
  );
  return { cells: first.cells, cellSizeM: first.cellSizeM, data };
};
