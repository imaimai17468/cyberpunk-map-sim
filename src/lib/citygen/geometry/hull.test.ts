import type { Obb } from "@/entities/city";
import { describe, expect, it } from "vitest";
import { convexHull, minimumAreaObb } from "./hull";

describe("convexHull", () => {
  it("should return the points unchanged when fewer than three points are given", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(convexHull(points)).toBe(points);
  });

  it("should exclude the collinear point when it lies on a hull edge", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(convexHull(points)).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ]);
  });
});

describe("minimumAreaObb", () => {
  it("should return the degenerate origin box when given no points", () => {
    expect(minimumAreaObb([])).toEqual({
      cx: 0,
      cy: 0,
      facing: { x: 1, y: 0 },
      w: 0,
      d: 0,
    });
  });

  it("should return a zero-extent box at the point when given a single point", () => {
    expect(minimumAreaObb([{ x: 5, y: 7 }])).toEqual({
      cx: 5,
      cy: 7,
      facing: { x: 1, y: 0 },
      w: 0,
      d: 0,
    });
  });

  it("should return a zero-depth segment box when given exactly two points", () => {
    const obb = minimumAreaObb([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ]);
    expect(obb).toSatisfy(
      (o: Obb) =>
        o.cx === 1.5 &&
        o.cy === 2 &&
        o.w === 5 &&
        o.d === 0 &&
        Math.abs(o.facing.x - 0.6) < 1e-9 &&
        Math.abs(o.facing.y - 0.8) < 1e-9
    );
  });

  /**
   * A 10x4 rectangle centred on the origin, rotated so its long axis is the
   * exact 3-4-5 direction (0.6, 0.8). Hand-traced through this module's own
   * monotone-chain ordering (sort by x then y, lower then upper chain): the
   * hull comes out as [D, C, B, A] below, whose first edge direction is
   * (0.8, -0.6) — the short axis — and every edge of a rectangle ties on
   * minimal area, so the first-found candidate (this one) must win.
   */
  it("should return the known width, depth, facing, and center when given a rectangle rotated to the 3-4-5 direction", () => {
    const dir = { x: 0.6, y: 0.8 };
    const side = { x: -0.8, y: 0.6 };
    const a = { x: 5 * dir.x + 2 * side.x, y: 5 * dir.y + 2 * side.y };
    const b = { x: 5 * dir.x - 2 * side.x, y: 5 * dir.y - 2 * side.y };
    const c = { x: -5 * dir.x - 2 * side.x, y: -5 * dir.y - 2 * side.y };
    const d = { x: -5 * dir.x + 2 * side.x, y: -5 * dir.y + 2 * side.y };
    const obb = minimumAreaObb([a, b, c, d]);
    expect(obb).toSatisfy(
      (o: Obb) =>
        Math.abs(o.cx) < 1e-9 &&
        Math.abs(o.cy) < 1e-9 &&
        Math.abs(o.w - 4) < 1e-9 &&
        Math.abs(o.d - 10) < 1e-9 &&
        Math.abs(o.facing.x - 0.8) < 1e-9 &&
        Math.abs(o.facing.y - -0.6) < 1e-9
    );
  });

  /**
   * A convex quadrilateral whose first hull edge (0,0)->(5,0) gives an
   * axis-aligned box of area 30 (w=6, d=5), but the next edge (5,0)->(6,4)
   * gives a strictly smaller area (~27.18) — hand-computed via the same
   * projection formula this module uses. This is what a plain rectangle
   * fixture cannot exercise: a later candidate has to replace the running
   * best, not just tie it.
   */
  it("should prefer a later hull edge when it gives a strictly smaller area than the first", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 6, y: 4 },
      { x: 1, y: 5 },
    ];
    const obb = minimumAreaObb(points);
    expect(obb.w * obb.d).toBeLessThan(29);
  });
});
