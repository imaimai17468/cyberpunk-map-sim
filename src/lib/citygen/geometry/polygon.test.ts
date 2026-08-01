import { describe, expect, it } from "vitest";
import {
  area,
  centroid,
  containsPoint,
  insetPolygon,
  samplePolygonInteriorPoints,
  signedArea,
  splitPolygon,
} from "./polygon";

const square = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

describe("signedArea", () => {
  it("should return zero when the ring has fewer than three vertices", () => {
    expect(
      signedArea([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ])
    ).toBe(0);
  });

  it("should return the positive shoelace sum when the ring is CCW", () => {
    expect(signedArea(square)).toBe(16);
  });
});

describe("area", () => {
  it("should return the absolute area when given a CCW ring", () => {
    expect(area(square)).toBe(16);
  });
});

describe("centroid", () => {
  it("should return the zero vector when the ring is empty", () => {
    expect(centroid([])).toEqual({ x: 0, y: 0 });
  });

  it("should return the vertex mean when the ring is collinear (zero area)", () => {
    const collinear = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    expect(centroid(collinear)).toEqual({ x: 1, y: 0 });
  });

  it("should return the area-weighted centroid when the ring has positive area", () => {
    expect(centroid(square)).toEqual({ x: 2, y: 2 });
  });
});

describe("containsPoint", () => {
  it("should return false when the ring has fewer than three vertices", () => {
    expect(
      containsPoint(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        { x: 0, y: 0 }
      )
    ).toBe(false);
  });

  it("should return true when the point is inside the ring", () => {
    expect(containsPoint(square, { x: 2, y: 2 })).toBe(true);
  });

  it("should return false when the point is outside the ring", () => {
    expect(containsPoint(square, { x: 5, y: 2 })).toBe(false);
  });
});

describe("insetPolygon", () => {
  it("should return the ring unchanged when it has fewer than three vertices", () => {
    const degenerate = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(insetPolygon(degenerate, 1)).toBe(degenerate);
  });

  it("should return the inward-offset square when inset by a known distance", () => {
    expect(insetPolygon(square, 1)).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]);
  });

  /**
   * A square with an extra collinear point (2,0) on its bottom edge: the
   * two edges meeting at that vertex share the direction (1, 0), so their
   * offset lines are parallel and `lineIntersection` must fall back to the
   * offset-endpoint midpoint rather than divide by (near) zero.
   */
  it("should split the difference when two adjacent offset edges are parallel", () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(insetPolygon(ring, 1)).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]);
  });
});

describe("splitPolygon", () => {
  it("should split into the two known half-rectangles when the line crosses the square's middle", () => {
    const result = splitPolygon(square, {
      point: { x: 2, y: 0 },
      dir: { x: 0, y: 1 },
    });
    expect(result).toEqual({
      positive: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 4 },
        { x: 0, y: 4 },
      ],
      negative: [
        { x: 2, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 2, y: 4 },
      ],
    });
  });

  it("should return null when the line misses the polygon entirely", () => {
    const result = splitPolygon(square, {
      point: { x: 10, y: 0 },
      dir: { x: 0, y: 1 },
    });
    expect(result).toBeNull();
  });
});

describe("samplePolygonInteriorPoints", () => {
  it("should return only the centroid when the ring is empty", () => {
    expect(samplePolygonInteriorPoints([], 4)).toEqual([{ x: 0, y: 0 }]);
  });

  it("should return only the centroid when the requested count is zero", () => {
    expect(samplePolygonInteriorPoints(square, 0)).toEqual([{ x: 2, y: 2 }]);
  });

  it("should return the centroid plus evenly spaced interior points when the count matches the vertex count", () => {
    expect(samplePolygonInteriorPoints(square, 4)).toEqual([
      { x: 2, y: 2 },
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]);
  });
});
