import { describe, expect, it } from "vitest";
import {
  distanceTransform1D,
  euclideanDistanceTransform,
  squaredEuclideanDistanceTransform,
} from "./edt";

describe("distanceTransform1D", () => {
  it("should return an empty array when given an empty input", () => {
    expect(distanceTransform1D(new Float64Array(0)).length).toBe(0);
  });

  it("should return the sanitized single value when given a one-element input", () => {
    expect(Array.from(distanceTransform1D(Float64Array.from([7])))).toEqual([
      7,
    ]);
  });

  it("should compute exact squared distances when the source sits at the boundary", () => {
    const input = Float64Array.from([
      0,
      Infinity,
      Infinity,
      Infinity,
      Infinity,
    ]);
    expect(Array.from(distanceTransform1D(input))).toEqual([0, 1, 4, 9, 16]);
  });

  it("should compute exact squared distances when the source sits inside the line", () => {
    const input = Float64Array.from([Infinity, 0, Infinity, Infinity]);
    expect(Array.from(distanceTransform1D(input))).toEqual([1, 0, 1, 4]);
  });

  it("should compute exact squared distances when there are multiple sources", () => {
    const input = Float64Array.from([0, Infinity, 0, Infinity, 0]);
    expect(Array.from(distanceTransform1D(input))).toEqual([0, 1, 0, 1, 0]);
  });

  it("should compute exact squared distances when two sources sit far apart", () => {
    const input = Float64Array.from([
      0,
      Infinity,
      Infinity,
      Infinity,
      Infinity,
      Infinity,
      Infinity,
      Infinity,
      0,
    ]);
    expect(Array.from(distanceTransform1D(input))).toEqual([
      0, 1, 4, 9, 16, 9, 4, 1, 0,
    ]);
  });

  it("should produce no NaN values when every entry is non-finite", () => {
    const input = Float64Array.from([Infinity, Infinity, Infinity]);
    const result = Array.from(distanceTransform1D(input));
    expect(result.some((value) => Number.isNaN(value))).toBe(false);
  });
});

const isCornerSeed = (index: number): boolean => index === 0;

describe("squaredEuclideanDistanceTransform", () => {
  it("should compute exact 2D squared Euclidean distances when there is a single source corner", () => {
    // 3x3 grid, source at (0, 0). True squared distance at (x, y) is x^2+y^2 —
    // this is what distinguishes an exact EDT from a chamfer approximation.
    const result = Array.from(
      squaredEuclideanDistanceTransform(isCornerSeed, 3)
    );
    expect(result).toEqual([0, 1, 4, 1, 2, 5, 4, 5, 8]);
  });

  it("should produce no NaN values when there is no source anywhere in the grid", () => {
    const result = Array.from(
      squaredEuclideanDistanceTransform(() => false, 2)
    );
    expect(result.some((value) => Number.isNaN(value))).toBe(false);
  });
});

describe("euclideanDistanceTransform", () => {
  it("should convert the squared transform to metres when given a cell size", () => {
    const field = euclideanDistanceTransform(isCornerSeed, 3, 2);
    // Farthest corner (2, 2): squared distance 8, so sqrt(8) * 2 metres.
    expect(field.data[8]).toBeCloseTo(Math.sqrt(8) * 2, 2);
  });
});
