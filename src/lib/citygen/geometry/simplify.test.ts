import { describe, expect, it } from "vitest";
import { douglasPeucker } from "./simplify";

describe("douglasPeucker", () => {
  it("should return the polyline unchanged when it has fewer than three points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(douglasPeucker(points, 0.1)).toBe(points);
  });

  it.each([
    [
      1.0,
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    ],
    [
      0.5,
      [
        { x: 0, y: 0 },
        { x: 5, y: 1 },
        { x: 10, y: 0 },
      ],
    ],
  ])(
    "should return %j when epsilon=%d is compared against the exact perpendicular distance of 1",
    (epsilon, expected) => {
      const points = [
        { x: 0, y: 0 },
        { x: 5, y: 1 },
        { x: 10, y: 0 },
      ];
      expect(douglasPeucker(points, epsilon)).toEqual(expected);
    }
  );

  /**
   * Both rows have two interior candidates (so the farthest-point reduce
   * actually invokes its comparator, unlike the single-candidate cases
   * above) with distances 1 and 3 in opposite orders — one row exercises
   * the reduce replacing its running best, the other exercises it keeping
   * the running best.
   */
  it.each([
    [
      [
        { x: 0, y: 0 },
        { x: 5, y: 1 },
        { x: 2, y: 3 },
        { x: 10, y: 0 },
      ],
    ],
    [
      [
        { x: 0, y: 0 },
        { x: 2, y: 3 },
        { x: 5, y: 1 },
        { x: 10, y: 0 },
      ],
    ],
  ])(
    "should keep every point when neither interior candidate is within epsilon, regardless of which is farthest in %j",
    (points) => {
      expect(douglasPeucker(points, 0.1)).toEqual(points);
    }
  );

  it("should measure distance from the shared endpoint when the base segment is degenerate", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 0 },
    ];
    expect(douglasPeucker(points, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 0 },
    ]);
  });
});
