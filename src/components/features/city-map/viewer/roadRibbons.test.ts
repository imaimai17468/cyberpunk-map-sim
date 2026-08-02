import type { Vec2 } from "@/entities/city";
import { ROAD_WIDTH_M } from "@/lib/citygen/constants";
import { describe, expect, it } from "vitest";
import { ribbonOf } from "./roadRibbons";

const FLAT = () => 0;

/**
 * No length limit, for the cases about a face's shape rather than about how
 * many faces a run becomes.
 */
const WHOLE = Number.POSITIVE_INFINITY;

const HALF = ROAD_WIDTH_M.street / 2;

/** Every vertex as (x, z), dropping the height component. */
const cornersOf = (positions: Float32Array): Vec2[] =>
  Array.from({ length: positions.length / 3 }, (_v, i) => ({
    x: positions[i * 3],
    y: positions[i * 3 + 2],
  }));

interface Mesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** One triangle's three (x, z) corners, read through the index buffer. */
const triangleAt = (mesh: Mesh, t: number): Vec2[] =>
  Array.from({ length: 3 }, (_v, k) => {
    const i = mesh.indices[t * 3 + k];
    return { x: mesh.positions[i * 3], y: mesh.positions[i * 3 + 2] };
  });

/** True when `tri` faces up once the generator's `y` becomes three's `z`. */
const facesUp = (tri: readonly Vec2[]): boolean => {
  const [p, q, r] = tri;
  const u = { x: q.x - p.x, y: q.y - p.y };
  const v = { x: r.x - p.x, y: r.y - p.y };
  return u.y * v.x - u.x * v.y > 0;
};

const near = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

describe("ribbonOf", () => {
  const straight: readonly (readonly Vec2[])[] = [
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
  ];

  it("should emit four vertices per run when building a ribbon", () => {
    expect(ribbonOf(straight, "street", FLAT, WHOLE).positions.length).toBe(12);
  });

  it("should emit two triangles per run when building a ribbon", () => {
    expect(ribbonOf(straight, "street", FLAT, WHOLE).indices.length).toBe(6);
  });

  it("should span the class's full carriageway when widening a run", () => {
    const [a, b] = cornersOf(
      ribbonOf(straight, "street", FLAT, WHOLE).positions
    );
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(
      ROAD_WIDTH_M.street,
      6
    );
  });

  it.each([
    ["highway", ROAD_WIDTH_M.highway],
    ["avenue", ROAD_WIDTH_M.avenue],
    ["street", ROAD_WIDTH_M.street],
    ["alley", ROAD_WIDTH_M.alley],
  ] as const)("should widen a %s to %s metres", (cls, width) => {
    const [a, b] = cornersOf(ribbonOf(straight, cls, FLAT, WHOLE).positions);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(width, 6);
  });

  it("should centre the ribbon on the centreline when widening", () => {
    const corners = cornersOf(
      ribbonOf(straight, "street", FLAT, WHOLE).positions
    );
    expect(corners.every((c) => Math.abs(Math.abs(c.y) - HALF) < 1e-6)).toBe(
      true
    );
  });

  /**
   * The winding was wrong first time and the entire road network vanished:
   * the generator's `(x, y)` becomes three's `(x, z)` with `y` up, which flips
   * handedness, so a ring that looks counter-clockwise on paper is a back face
   * seen from above. This pins the resulting orientation.
   */
  it("should wind its triangles to face upward when seen from above", () => {
    const mesh = ribbonOf(straight, "street", FLAT, WHOLE);
    expect([
      facesUp(triangleAt(mesh, 0)),
      facesUp(triangleAt(mesh, 1)),
    ]).toEqual([true, true]);
  });

  it("should sample the height at every corner when the ground is not flat", () => {
    const { positions } = ribbonOf(straight, "street", (p) => p.x / 10, WHOLE);
    const heights = Array.from({ length: 4 }, (_v, c) => positions[c * 3 + 1]);
    expect(heights.toSorted((a, b) => a - b)).toEqual([0, 0, 10, 10]);
  });

  it("should skip a run when its two endpoints coincide", () => {
    const degenerate: readonly (readonly Vec2[])[] = [
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
    ];
    expect(ribbonOf(degenerate, "street", FLAT, WHOLE).indices.length).toBe(0);
  });

  it("should return an empty mesh when given no polylines", () => {
    expect(ribbonOf([], "street", FLAT, WHOLE).positions.length).toBe(0);
  });

  it("should keep the surviving runs when one of them is degenerate", () => {
    const mixed: readonly (readonly Vec2[])[] = [
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ],
    ];
    expect(ribbonOf(mixed, "street", FLAT, WHOLE).indices.length).toBe(6);
  });

  /**
   * Subdivision is not cosmetic: one quad is flat between its corners, so a run
   * longer than a terrain cell is a plank laid over the relief. These pin the
   * cut; `terrainMesh.test.ts` pins the heights it samples.
   */
  describe("cutting a run to the span", () => {
    it("should cut into one quad per span when the run is longer", () => {
      expect(ribbonOf(straight, "street", FLAT, 25).indices.length).toBe(24);
    });

    it("should leave the run whole when it is shorter than the span", () => {
      expect(ribbonOf(straight, "street", FLAT, 250).indices.length).toBe(6);
    });

    it("should round up when the length is not a whole number of spans", () => {
      // 100 m at 30 m is 3.33 spans, which has to become four quads, not three.
      expect(ribbonOf(straight, "street", FLAT, 30).indices.length).toBe(24);
    });

    it("should cover the original run exactly when cutting it up", () => {
      const xs = cornersOf(
        ribbonOf(straight, "street", FLAT, 25).positions
      ).map((c) => c.x);
      expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 100]);
    });

    it("should leave no gap between pieces when cutting a run", () => {
      const c = cornersOf(ribbonOf(straight, "street", FLAT, 25).positions);
      // Quad q's far edge (corners 2,3) must be quad q+1's near edge (0,1).
      const seams = Array.from({ length: 3 }, (_v, q) => [
        near(c[q * 4 + 2], c[(q + 1) * 4]),
        near(c[q * 4 + 3], c[(q + 1) * 4 + 1]),
      ]);
      expect(seams.flat().every(Boolean)).toBe(true);
    });

    it("should still span the full carriageway on every piece when cutting", () => {
      const c = cornersOf(ribbonOf(straight, "street", FLAT, 25).positions);
      const widths = Array.from({ length: 4 }, (_v, q) =>
        Math.hypot(c[q * 4].x - c[q * 4 + 1].x, c[q * 4].y - c[q * 4 + 1].y)
      );
      expect(
        widths.every((w) => Math.abs(w - ROAD_WIDTH_M.street) < 1e-6)
      ).toBe(true);
    });

    it("should follow a slope piece by piece when a cut run crosses one", () => {
      const { positions } = ribbonOf(straight, "street", (p) => p.x / 10, 25);
      const seamHeights = Array.from(
        { length: 4 },
        (_v, q) => positions[q * 12 + 1]
      );
      expect(seamHeights).toEqual([0, 2.5, 5, 7.5]);
    });

    it("should treat a non-positive span as no limit when cutting", () => {
      expect(ribbonOf(straight, "street", FLAT, 0).indices.length).toBe(6);
    });
  });

  /**
   * Where a polyline bends, the two runs pivot apart and leave a notch on the
   * outside of the turn — a median third of the carriageway, so the wide roads
   * read as torn rather than bent. A bevel closes it; `roadRibbons.ts` carries
   * the measurements.
   */
  describe("closing the outside of a turn", () => {
    /** East, then north: a left turn through 90 degrees at (100, 0). */
    const leftTurn: readonly (readonly Vec2[])[] = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    ];
    /** East, then south: the mirror image, turning right. */
    const rightTurn: readonly (readonly Vec2[])[] = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: -100 },
      ],
    ];

    it("should add one triangle per bend when a polyline turns", () => {
      // Two runs (two quads, twelve indices) plus one wedge (three).
      expect(ribbonOf(leftTurn, "street", FLAT, WHOLE).indices.length).toBe(15);
    });

    /**
     * A reversal has the same zero sine as a straight run, so it takes the same
     * branch and draws nothing — arbitrary rather than right, since "outside of
     * the turn" names nothing at 180 degrees. It has never been observed: these
     * are shortest paths, and across nine seeds at three extents the sharpest
     * interior turn was exactly 90 degrees. Pinned so a change to the path
     * builder cannot reach it quietly; if this fails, the reversal became
     * possible and needs deciding.
     */
    it("should add no triangle when the polyline doubles back on itself", () => {
      const hairpin: readonly (readonly Vec2[])[] = [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 0, y: 0 },
        ],
      ];
      expect(ribbonOf(hairpin, "street", FLAT, WHOLE).indices.length).toBe(12);
    });

    it("should add no triangle when three points are collinear", () => {
      const collinear: readonly (readonly Vec2[])[] = [
        [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 100, y: 0 },
        ],
      ];
      expect(ribbonOf(collinear, "street", FLAT, WHOLE).indices.length).toBe(
        12
      );
    });

    it("should meet both runs' outer corners when closing a left turn", () => {
      // Outside of a left turn is the right hand of travel: -y off the first
      // run, +x off the second.
      const wedge = triangleAt(ribbonOf(leftTurn, "street", FLAT, WHOLE), 4);
      const wanted = [
        { x: 100, y: 0 },
        { x: 100, y: -HALF },
        { x: 100 + HALF, y: 0 },
      ];
      expect(wanted.every((w) => wedge.some((c) => near(c, w)))).toBe(true);
    });

    it("should meet both runs' outer corners when closing a right turn", () => {
      const wedge = triangleAt(ribbonOf(rightTurn, "street", FLAT, WHOLE), 4);
      const wanted = [
        { x: 100, y: 0 },
        { x: 100, y: HALF },
        { x: 100 + HALF, y: 0 },
      ];
      expect(wanted.every((w) => wedge.some((c) => near(c, w)))).toBe(true);
    });

    it.each([
      ["a left turn", leftTurn],
      ["a right turn", rightTurn],
    ])(
      "should wind the wedge to face upward when closing %s",
      (_label, line) => {
        expect(
          facesUp(triangleAt(ribbonOf(line, "street", FLAT, WHOLE), 4))
        ).toBe(true);
      }
    );

    it("should leave the inside alone when closing the outside of a turn", () => {
      // The inner corners are already covered twice by the two runs; a wedge
      // there would be the mitre this deliberately does not build.
      const wedge = triangleAt(ribbonOf(leftTurn, "street", FLAT, WHOLE), 4);
      expect(wedge.some((c) => c.y > 1e-6)).toBe(false);
    });

    it("should sample the wedge's height when the ground is not flat", () => {
      const mesh = ribbonOf(leftTurn, "street", (p) => p.x / 10, WHOLE);
      const heights = Array.from(
        { length: 3 },
        (_v, k) => mesh.positions[mesh.indices[12 + k] * 3 + 1]
      );
      // The wedge sits at x = 100 twice and at x = 100 + HALF once. Rounded
      // because the buffer is float32 and 10.55 does not survive the round trip.
      expect(
        heights.toSorted((a, b) => a - b).map((h) => Math.round(h * 1e5) / 1e5)
      ).toEqual([10, 10, 10 + HALF / 10]);
    });

    it("should close every bend when a polyline turns more than once", () => {
      const zigzag: readonly (readonly Vec2[])[] = [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 150, y: 50 },
          { x: 250, y: 0 },
        ],
      ];
      // Three runs (18 indices) plus two wedges (6).
      expect(ribbonOf(zigzag, "street", FLAT, WHOLE).indices.length).toBe(24);
    });

    it("should keep one wedge per bend when the runs were cut into pieces", () => {
      // Cutting a run does not create a bend, so only quads are added: each
      // 100 m run becomes four, so six more quads at six indices each.
      const cut = ribbonOf(leftTurn, "street", FLAT, 25);
      const whole = ribbonOf(leftTurn, "street", FLAT, WHOLE);
      expect(cut.indices.length - whole.indices.length).toBe(6 * 6);
    });
  });
});
