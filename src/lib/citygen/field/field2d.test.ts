import { describe, expect, it } from "vitest";
import {
  bilinearSample,
  combineFields,
  createField2D,
  fieldAt,
  fieldIndex,
  mapField,
} from "./field2d";

describe("createField2D", () => {
  it("should zero-fill the data when no fill function is given", () => {
    const field = createField2D(2, 4);
    expect(Array.from(field.data)).toEqual([0, 0, 0, 0]);
  });

  it("should compute every cell from its index and coordinates when a fill function is given", () => {
    const field = createField2D(
      2,
      4,
      (index, x, y) => index + x * 10 + y * 100
    );
    expect({
      cells: field.cells,
      cellSizeM: field.cellSizeM,
      data: Array.from(field.data),
    }).toEqual({
      cells: 2,
      cellSizeM: 4,
      data: [0, 11, 102, 113],
    });
  });
});

describe("fieldIndex", () => {
  const field = createField2D(3, 1);

  it.each([
    [-1, 0, 0],
    [0, 0, 0],
    [3, 0, 2],
    [2, 0, 2],
    [0, -1, 0],
    [0, 3, 6],
    [1, 1, 4],
  ])("should clamp (%d, %d) to index %d", (cx, cy, expected) => {
    expect(fieldIndex(field, cx, cy)).toBe(expected);
  });
});

describe("fieldAt", () => {
  const field = createField2D(2, 1, (index) => index);

  it("should read the exact cell value when coordinates are in range", () => {
    expect(fieldAt(field, 1, 1)).toBe(3);
  });

  it("should read the clamped border value when coordinates are out of range", () => {
    expect(fieldAt(field, 5, 5)).toBe(3);
  });
});

describe("bilinearSample", () => {
  // 2x2 field: (0,0)=0, (1,0)=10, (0,1)=20, (1,1)=30
  const field = createField2D(2, 1, (index) => [0, 10, 20, 30][index]);

  it("should return the exact cell value when sampled at an integer coordinate", () => {
    expect(bilinearSample(field, 1, 0)).toBe(10);
  });

  it("should interpolate between all four neighbours when given fractional coordinates", () => {
    // Hand-computed: top = 0 + (10-0)*0.5 = 5; bottom = 20 + (30-20)*0.5 = 25;
    // result = 5 + (25-5)*0.5 = 15.
    expect(bilinearSample(field, 0.5, 0.5)).toBeCloseTo(15);
  });

  it("should clamp to the border cell when sampling past the grid edge", () => {
    expect(bilinearSample(field, 5, 5)).toBe(30);
  });
});

describe("mapField", () => {
  it("should apply the mapper to every cell when the field is mapped", () => {
    const field = createField2D(2, 4, (index) => index);
    const doubled = mapField(field, (value) => value * 2);
    expect({
      cells: doubled.cells,
      cellSizeM: doubled.cellSizeM,
      data: Array.from(doubled.data),
    }).toEqual({ cells: 2, cellSizeM: 4, data: [0, 2, 4, 6] });
  });
});

describe("combineFields", () => {
  it("should throw a RangeError when given no fields", () => {
    expect(() => combineFields([], (values) => values[0])).toThrow(RangeError);
  });

  it.each([
    [createField2D(2, 1), createField2D(3, 1)],
    [createField2D(2, 1), createField2D(2, 2)],
  ])("should throw a RangeError when the fields' shapes disagree", (a, b) => {
    expect(() =>
      combineFields([a, b], (values) => values[0] + values[1])
    ).toThrow(RangeError);
  });

  it("should combine matching fields cell-by-cell when shapes agree", () => {
    const a = createField2D(2, 1, (index) => index);
    const b = createField2D(2, 1, () => 100);
    const combined = combineFields([a, b], (values) => values[0] + values[1]);
    expect(Array.from(combined.data)).toEqual([100, 101, 102, 103]);
  });
});
