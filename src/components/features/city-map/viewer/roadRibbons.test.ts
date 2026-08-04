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

/**
 * Triangles one round cap adds, at street width.
 *
 * `capFaces` sweeps a half-disc as two quarters, and `rimFan` cuts each into
 * chords of at most `RIM_CHORD_M`. A quarter of a 5.5 m rim is a 7.78 m chord, so
 * four apiece and eight an end — which makes the caps most of the triangle count on
 * the short fixtures below, and is why the totals here are what they are.
 */
const CAP_TRIS_PER_END = 8;

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

  /** The quad's own four corners, which `facesOf` emits before any fan. */
  const RUN_VERTS = 4;

  it("should emit four vertices per run when building a ribbon", () => {
    // Sixteen cap triangles at three vertices each follow them.
    expect(ribbonOf(straight, "street", FLAT, WHOLE).positions.length).toBe(
      (RUN_VERTS + 2 * CAP_TRIS_PER_END * 3) * 3
    );
  });

  it("should emit two triangles per run when building a ribbon", () => {
    expect(ribbonOf(straight, "street", FLAT, WHOLE).indices.length).toBe(
      (2 + 2 * CAP_TRIS_PER_END) * 3
    );
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
    // The quad's corners only. A cap's corners sweep the rim rather than sitting
    // on the two kerbs, and its fan's apex is the centreline point itself.
    const corners = cornersOf(
      ribbonOf(straight, "street", FLAT, WHOLE).positions
    ).slice(0, RUN_VERTS);
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
    // The degenerate one contributes no cap either — it has no direction to put
    // one on, which is the same reason it draws no quad.
    expect(ribbonOf(mixed, "street", FLAT, WHOLE).indices.length).toBe(
      (2 + 2 * CAP_TRIS_PER_END) * 3
    );
  });

  /**
   * Subdivision is not cosmetic: one quad is flat between its corners, so a run
   * longer than a terrain cell is a plank laid over the relief. These pin the
   * cut; `terrainMesh.test.ts` pins the heights it samples.
   */
  describe("cutting a run to the span", () => {
    /** Indices the two caps add, unchanged by how the run between them is cut. */
    const CAPS = 2 * CAP_TRIS_PER_END * 3;

    it("should cut into one quad per span when the run is longer", () => {
      expect(ribbonOf(straight, "street", FLAT, 25).indices.length).toBe(
        24 + CAPS
      );
    });

    it("should leave the run whole when it is shorter than the span", () => {
      expect(ribbonOf(straight, "street", FLAT, 250).indices.length).toBe(
        6 + CAPS
      );
    });

    it("should round up when the length is not a whole number of spans", () => {
      // 100 m at 30 m is 3.33 spans, which has to become four quads, not three.
      expect(ribbonOf(straight, "street", FLAT, 30).indices.length).toBe(
        24 + CAPS
      );
    });

    it("should cover the original run exactly when cutting it up", () => {
      // The quads' corners, which come first. The caps deliberately reach half a
      // carriageway past each end — `should round each end` below pins that.
      const xs = cornersOf(ribbonOf(straight, "street", FLAT, 25).positions)
        .slice(0, 4 * RUN_VERTS)
        .map((c) => c.x);
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
      expect(ribbonOf(straight, "street", FLAT, 0).indices.length).toBe(
        6 + CAPS
      );
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

    /**
     * A right angle at street width sweeps a 7.78 m rim, which at `RIM_CHORD_M`
     * is four chords. A shallower turn is fewer, and under one chord it is the
     * single flat triangle this used to always draw.
     */
    const RIGHT_ANGLE_FAN_TRIS = 4;

    it("should add a fan of triangles per bend when a polyline turns", () => {
      // Two quads (four triangles), the fan, and a cap at each end.
      expect(ribbonOf(leftTurn, "street", FLAT, WHOLE).indices.length).toBe(
        (4 + RIGHT_ANGLE_FAN_TRIS + 2 * CAP_TRIS_PER_END) * 3
      );
    });

    /**
     * The fan degenerates to exactly the bevel it replaced when the turn is small
     * enough, which is the common case: since the generator started rounding
     * arterial centrelines the median interior turn is 4.5 degrees. At street
     * width a 20-degree turn sweeps 1.9 m of rim, inside one chord.
     */
    it("should add a single flat triangle when the bend is shallower than one chord", () => {
      const shallow: readonly (readonly Vec2[])[] = [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 193.97, y: 34.2 },
        ],
      ];
      expect(ribbonOf(shallow, "street", FLAT, WHOLE).indices.length).toBe(
        (4 + 1 + 2 * CAP_TRIS_PER_END) * 3
      );
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
      expect(ribbonOf(hairpin, "street", FLAT, WHOLE).indices.length).toBe(
        (4 + 2 * CAP_TRIS_PER_END) * 3
      );
    });

    /**
     * A repeated vertex leaves one leg of the bend with no direction, so there is
     * no turn to close and no end to round on that side either — both read the
     * same `directionOf`. What is left is the one real segment and the cap on its
     * far end. The generator drops consecutive duplicates, so this is a guard
     * rather than a live case; it was the one branch in this file no test reached.
     */
    it("should add no triangle when one leg of the bend has no length", () => {
      const repeated: readonly (readonly Vec2[])[] = [
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      ];
      expect(ribbonOf(repeated, "street", FLAT, WHOLE).indices.length).toBe(
        (2 + CAP_TRIS_PER_END) * 3
      );
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
        (4 + 2 * CAP_TRIS_PER_END) * 3
      );
    });

    /** The fan's triangles, which `facesOf` emits after every quad. */
    const fanOf = (line: readonly (readonly Vec2[])[]): Vec2[][] =>
      Array.from({ length: RIGHT_ANGLE_FAN_TRIS }, (_v, i) =>
        triangleAt(ribbonOf(line, "street", FLAT, WHOLE), 4 + i)
      );

    it("should meet both runs' outer corners when closing a left turn", () => {
      // Outside of a left turn is the right hand of travel: -y off the first run,
      // +x off the second. The fan starts on one kerb and ends on the other;
      // between them its rim points are on the arc, on neither.
      const corners = fanOf(leftTurn).flat();
      const wanted = [
        { x: 100, y: -HALF },
        { x: 100 + HALF, y: 0 },
      ];
      expect(wanted.every((w) => corners.some((c) => near(c, w)))).toBe(true);
    });

    it("should meet both runs' outer corners when closing a right turn", () => {
      const corners = fanOf(rightTurn).flat();
      const wanted = [
        { x: 100, y: HALF },
        { x: 100 + HALF, y: 0 },
      ];
      expect(wanted.every((w) => corners.some((c) => near(c, w)))).toBe(true);
    });

    it("should pivot every fan triangle on the bend when closing a turn", () => {
      expect(
        fanOf(leftTurn).every((tri) =>
          tri.some((c) => near(c, { x: 100, y: 0 }))
        )
      ).toBe(true);
    });

    it("should hold every fan corner on the carriageway rim when closing a turn", () => {
      const rim = fanOf(leftTurn)
        .flat()
        .filter((c) => !near(c, { x: 100, y: 0 }))
        .map((c) => Math.hypot(c.x - 100, c.y));
      expect(rim.every((d) => Math.abs(d - HALF) < 1e-5)).toBe(true);
    });

    it.each([
      ["a left turn", leftTurn],
      ["a right turn", rightTurn],
    ])(
      "should wind every fan triangle to face upward when closing %s",
      (_label, line) => {
        expect(fanOf(line).every(facesUp)).toBe(true);
      }
    );

    it("should leave the inside alone when closing the outside of a turn", () => {
      // The inner corners are already covered twice by the two runs; a fan there
      // would be the mitre this deliberately does not build.
      const corners = fanOf(leftTurn).flat();
      expect(corners.some((c) => c.y > 1e-6)).toBe(false);
    });

    it("should sample the fan's height when the ground is not flat", () => {
      const mesh = ribbonOf(leftTurn, "street", (p) => p.x / 10, WHOLE);
      const heights = Array.from(
        { length: 3 },
        (_v, k) => mesh.positions[mesh.indices[12 + k] * 3 + 1]
      );
      // The fan's first triangle is the pivot at x = 100, then its second rim
      // point, then its first. The rim steps by normalising a lerp, so the second
      // is `normalize(lerp((0,-1), (1,0), 1/4))` = (0.3162, -0.9487), which at a
      // 5.5 m radius stands at x = 101.739. Rounded because the buffer is float32.
      expect(heights.map((h) => Math.round(h * 1e3) / 1e3)).toEqual([
        10, 10.174, 10,
      ]);
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
      // Three quads (six triangles), a 45-degree bend's fan (three) and a
      // 71.6-degree bend's (four), plus a cap at each end.
      expect(ribbonOf(zigzag, "street", FLAT, WHOLE).indices.length).toBe(
        (6 + 3 + 4 + 2 * CAP_TRIS_PER_END) * 3
      );
    });

    it("should keep one wedge per bend when the runs were cut into pieces", () => {
      // Cutting a run does not create a bend, so only quads are added: each
      // 100 m run becomes four, so six more quads at six indices each.
      const cut = ribbonOf(leftTurn, "street", FLAT, 25);
      const whole = ribbonOf(leftTurn, "street", FLAT, WHOLE);
      expect(cut.indices.length - whole.indices.length).toBe(6 * 6);
    });
  });

  /**
   * Rounding the ends, which is the half streets and alleys need.
   *
   * They are always two-vertex straights, so no bend of theirs ever reaches the
   * fan above; their corners are between two separate cut edges meeting at a block
   * ring vertex. Two butt ends there leave the same notch a bend leaves.
   */
  describe("rounding the ends", () => {
    /** The cap triangles, which `facesOf` emits after every quad and fan. */
    const capsOf = (
      line: readonly (readonly Vec2[])[],
      quadsAndFans: number
    ): Vec2[][] => {
      const mesh = ribbonOf(line, "street", FLAT, WHOLE);
      return Array.from(
        { length: mesh.indices.length / 3 - quadsAndFans },
        (_v, i) => triangleAt(mesh, quadsAndFans + i)
      );
    };

    it("should add a half-disc at each end when building a ribbon", () => {
      expect(capsOf(straight, 2).length).toBe(2 * CAP_TRIS_PER_END);
    });

    it("should hold every cap corner on the rim or at the end itself when rounding", () => {
      const corners = capsOf(straight, 2).flat();
      const off = corners
        .map((c) => Math.min(Math.hypot(c.x, c.y), Math.hypot(c.x - 100, c.y)))
        .filter((d) => Math.abs(d) > 1e-5 && Math.abs(d - HALF) > 1e-5);
      // The corner count travels with the assertion so this cannot pass by there
      // being no caps to check — which is how it read before, caps removed.
      expect([off, corners.length]).toEqual([[], 2 * CAP_TRIS_PER_END * 3]);
    });

    it("should wind every cap triangle to face upward when rounding an end", () => {
      expect(capsOf(straight, 2).map(facesUp)).toEqual(
        Array.from({ length: 2 * CAP_TRIS_PER_END }, () => true)
      );
    });

    it("should reach half a carriageway past each end when rounding", () => {
      const xs = capsOf(straight, 2)
        .flat()
        .map((c) => c.x);
      expect([Math.min(...xs), Math.max(...xs)]).toEqual([-HALF, 100 + HALF]);
    });

    /**
     * The notch this exists for. Two streets meeting at a right angle at the
     * origin — the shape a block ring corner makes — leave the quarter between
     * their two butt ends unpaved. Sampled just inside that quarter, on the
     * bisector: without caps nothing covers it, and the cap of either street does.
     */
    it("should cover the corner between two streets when they meet at a ring vertex", () => {
      const corner: readonly (readonly Vec2[])[] = [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        [
          { x: 0, y: 0 },
          { x: 0, y: 100 },
        ],
      ];
      const probe = { x: -2, y: -2 };
      const inside = (tri: readonly Vec2[]): boolean => {
        const sign = (a: Vec2, b: Vec2): number =>
          (probe.x - b.x) * (a.y - b.y) - (a.x - b.x) * (probe.y - b.y);
        const [p, q, r] = tri;
        const d1 = sign(p, q);
        const d2 = sign(q, r);
        const d3 = sign(r, p);
        return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
      };
      const mesh = ribbonOf(corner, "street", FLAT, WHOLE);
      const covered = Array.from({ length: mesh.indices.length / 3 }, (_v, t) =>
        triangleAt(mesh, t)
      ).filter(inside);
      expect(covered.length).toBeGreaterThan(0);
    });

    /**
     * A cap indexes the polyline where every other helper here slices it, so it is
     * the one that can be handed a `polyline[1]` that does not exist. Nothing
     * produces such a line today — `polylinePoints` returns `[]` below two points
     * and both edge sources emit at least two — but `ribbonOf` accepts any array of
     * arrays, and without the guard this throws and takes the whole class's mesh
     * with it rather than skipping one line.
     */
    it.each([
      ["empty", []],
      ["a single point", [{ x: 5, y: 5 }]],
    ])("should draw nothing when a polyline is %s", (_label, line) => {
      const mesh = ribbonOf([line], "street", FLAT, WHOLE);
      expect([mesh.positions.length, mesh.indices.length]).toEqual([0, 0]);
    });

    it("should round no end when the run has no direction to round it on", () => {
      const degenerate: readonly (readonly Vec2[])[] = [
        [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
        ],
      ];
      expect(ribbonOf(degenerate, "street", FLAT, WHOLE).indices.length).toBe(
        0
      );
    });
  });
});
