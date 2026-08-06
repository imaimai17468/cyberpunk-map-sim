import type {
  RoadGraph,
  Block,
  BoundaryRef,
  DistrictKind,
  PolygonPool,
  Vec2,
} from "@/entities/city";
import { describe, expect, it } from "vitest";
import type { Grid } from "./types";
import { LOTS, LOT_TARGET_AREA_M2 } from "../constants";
import type { RngStream } from "../rng/types";
import {
  alleyChordsOf,
  buildableRingOf,
  chordsOf,
  classifyFrontages,
  computeAreaScale,
  type CutTree,
  insetForAlleys,
  leavesOf,
  lotsStage,
  streetFrontageDirs,
  subdivideBlock,
} from "./lots";
import { area as polygonArea, isSelfIntersecting } from "../geometry/polygon";
import { ROAD_WIDTH_M } from "../constants";

const rectRing = (
  x0: number,
  y0: number,
  w: number,
  h: number
): readonly Vec2[] => [
  { x: x0, y: y0 },
  { x: x0 + w, y: y0 },
  { x: x0 + w, y: y0 + h },
  { x: x0, y: y0 + h },
];

const BORDER: BoundaryRef = { kind: "border", refId: 0 };
const CUT: BoundaryRef = { kind: "cut", refId: 0 };

const ALL_BORDER: readonly BoundaryRef[] = [BORDER, BORDER, BORDER, BORDER];

const prefixSums = (lengths: readonly number[]): number[] =>
  lengths.reduce<number[]>(
    (acc, len) => {
      acc.push(acc[acc.length - 1] + len);
      return acc;
    },
    [0]
  );

const buildPolygonPool = (
  rings: readonly (readonly Vec2[])[]
): PolygonPool => ({
  starts: Uint32Array.from(prefixSums(rings.map((ring) => ring.length))),
  coords: Float32Array.from(
    rings.flatMap((ring) => ring.flatMap((p) => [p.x, p.y]))
  ),
});

/** A stream whose draws never vary — deterministic midline cuts, no jitter flip. */
const constantStream = (value: number): RngStream => ({
  next: () => value,
  nextInt: () => 0,
  fork: () => constantStream(value),
});

/** Throws if drawn from at all — proves a code path never touches the RNG. */
const poisonStream = (): RngStream => ({
  next: () => {
    throw new Error("unexpected draw");
  },
  nextInt: () => {
    throw new Error("unexpected draw");
  },
  fork: () => poisonStream(),
});

/** Fixture extent. Only `sizeM` matters here — it sets the density denominator. */
const TEST_GRID: Grid = { cells: 64, sizeM: 2048, cellSizeM: 32 };

/** The default 2048 m extent, in square kilometres. */
const DEFAULT_AREA_KM2 = (2048 * 2048) / 1_000_000;

describe("computeAreaScale", () => {
  it.each([
    [100, LOTS.areaScaleMin],
    [1_000_000, LOTS.areaScaleMax],
    // Unclamped midpoint: the expected count that exactly meets the target
    // density over the default extent. Derived from the constants rather than
    // written as a literal, so retuning either cannot silently pass.
    [
      LOTS.targetBuildingDensityPerKm2 * DEFAULT_AREA_KM2,
      LOTS.subdivisionOvershoot,
    ],
  ])(
    "should compute the area scale when expected count is %s",
    (expected, scale) => {
      expect(computeAreaScale(expected, DEFAULT_AREA_KM2)).toBeCloseTo(
        scale,
        6
      );
    }
  );

  /** The point of the density target: a bigger map is not a denser map. */
  it("should return the same scale when area and expected count both quadruple", () => {
    const base = LOTS.targetBuildingDensityPerKm2 * DEFAULT_AREA_KM2;
    expect(computeAreaScale(base * 4, DEFAULT_AREA_KM2 * 4)).toBeCloseTo(
      computeAreaScale(base, DEFAULT_AREA_KM2),
      6
    );
  });
});

describe("subdivideBlock", () => {
  it("should return the ring unchanged without drawing from the stream when area is already at or below target", () => {
    const ring = rectRing(0, 0, 10, 10);
    const result = subdivideBlock(ring, 1_000, false, 0, 0, "", poisonStream());
    expect(result).toEqual({ kind: "leaf", ring });
  });

  it("should return the ring unchanged when the OBB-derived cut fails to cross the polygon", () => {
    const degenerateRing = [
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
    ];
    const result = subdivideBlock(
      degenerateRing,
      -1,
      false,
      0,
      0,
      "",
      constantStream(0.5)
    );
    expect(result).toEqual({ kind: "leaf", ring: degenerateRing });
  });

  it("should split into two leaves when the halves already satisfy the target", () => {
    const ring = rectRing(0, 0, 200, 100);
    const result = subdivideBlock(
      ring,
      10_001,
      false,
      0,
      0,
      "",
      constantStream(0.5)
    );
    expect(leavesOf(result).length).toBe(2);
  });

  it("should split into two leaves when the block is a slum with jittered cut direction", () => {
    const ring = rectRing(0, 0, 200, 100);
    const result = subdivideBlock(
      ring,
      10_001,
      true,
      0,
      0,
      "",
      constantStream(0.5)
    );
    expect(leavesOf(result).length).toBe(2);
  });

  it("should record the cut as the segment the two halves share when a convex region is bisected", () => {
    const ring = rectRing(0, 0, 200, 100);
    const result = subdivideBlock(
      ring,
      10_001,
      false,
      0,
      0,
      "",
      constantStream(0.5)
    );
    // A midline cut of a 200x100 rectangle: the shared edge runs the full
    // height of the block at x = 100.
    expect(result.kind === "split" && result.chords).toEqual([
      [
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    ]);
  });

  /**
   * The reason the chord is read as runs rather than as the two extreme points
   * on the cut line. This C-shaped region is crossed twice by its own midline,
   * and the gap between the two crossings is the notch — ground the region does
   * not cover. Taking the extremes would lay one alley straight across it.
   */
  it("should record two cuts when the line leaves and re-enters a concave region", () => {
    const cShape: readonly Vec2[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 200, y: 60 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    const result = subdivideBlock(
      cShape,
      9_300,
      false,
      0,
      0,
      "",
      constantStream(0.5)
    );
    expect(result.kind === "split" && result.chords).toEqual([
      [
        { x: 100, y: 0 },
        { x: 100, y: 40 },
      ],
      [
        { x: 100, y: 60 },
        { x: 100, y: 100 },
      ],
    ]);
  });
});

describe("chordsOf", () => {
  /**
   * The degenerate region: every vertex sits on the cut line, so there is no
   * interior to divide and nothing to publish. `subdivideBlock` cannot reach
   * this — `splitPolygon` refuses a line with no vertex strictly either side —
   * which is why it is asserted here rather than through the stage.
   */
  it("should publish no chord when the whole ring lies on the cut line", () => {
    const flat: readonly Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    expect(
      chordsOf(flat, { point: { x: 0, y: 0 }, dir: { x: 1, y: 0 } })
    ).toEqual([]);
  });

  it("should drop a run when its two ends coincide", () => {
    // Two vertices on the line at the same point, so the run has length 2 and
    // zero extent — a road with no direction if it were published.
    const pinched: readonly Vec2[] = [
      { x: 0, y: 5 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 5 },
    ];
    expect(
      chordsOf(pinched, { point: { x: 0, y: 0 }, dir: { x: 1, y: 0 } })
    ).toEqual([]);
  });
});

/** A split whose two children are leaves, with one chord between them. */
const splitOf = (
  chord: readonly [Vec2, Vec2],
  positive: CutTree,
  negative: CutTree
): CutTree => ({ kind: "split", chords: [chord], positive, negative });

const leafOf = (ring: readonly Vec2[]): CutTree => ({ kind: "leaf", ring });

const CHORD_A: readonly [Vec2, Vec2] = [
  { x: 0, y: 0 },
  { x: 0, y: 100 },
];
const CHORD_B: readonly [Vec2, Vec2] = [
  { x: 50, y: 0 },
  { x: 50, y: 100 },
];

describe("alleyChordsOf", () => {
  it("should publish no cut when every leaf already fronts a street", () => {
    const tree = splitOf(CHORD_A, leafOf([]), leafOf([]));
    expect(alleyChordsOf(tree, [false, false]).chords).toEqual([]);
  });

  it("should publish the cut above a leaf when that leaf fronts no street", () => {
    const tree = splitOf(CHORD_A, leafOf([]), leafOf([]));
    expect(alleyChordsOf(tree, [false, true]).chords).toEqual([CHORD_A]);
  });

  /**
   * The minimality that makes this a pruned tree rather than every cut: the
   * right-hand split has no leaf needing access, so it contributes nothing,
   * while the root still does because the left-hand leaf does.
   */
  it("should publish nothing for a subtree when all of its leaves front a street", () => {
    const tree = splitOf(
      CHORD_A,
      leafOf([]),
      splitOf(CHORD_B, leafOf([]), leafOf([]))
    );
    expect(alleyChordsOf(tree, [true, false, false]).chords).toEqual([CHORD_A]);
  });

  it("should publish both cuts when the leaf needing access is the deepest one", () => {
    const tree = splitOf(
      CHORD_A,
      leafOf([]),
      splitOf(CHORD_B, leafOf([]), leafOf([]))
    );
    expect(alleyChordsOf(tree, [false, false, true]).chords).toEqual([
      CHORD_A,
      CHORD_B,
    ]);
  });

  it("should report one leaf consumed per leaf when the walk returns, so a sibling subtree is indexed from the right place", () => {
    const tree = splitOf(
      CHORD_A,
      leafOf([]),
      splitOf(CHORD_B, leafOf([]), leafOf([]))
    );
    expect(alleyChordsOf(tree, [false, false, false]).next).toBe(3);
  });
});

describe("classifyFrontages", () => {
  it.each<[number, "street" | "landlocked"]>([
    [6.1, "street"],
    [5.9, "landlocked"],
  ])("should classify a %sm cut-provenance edge as %s", (width, expected) => {
    const ring = rectRing(0, 0, width, 50);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const result = classifyFrontages(
      streetFrontageDirs(ring, boundary, [ring]),
      [],
      [ring],
      false
    );
    expect(result[0].frontage).toBe(expected);
  });

  it("should merge a landlocked leaf into its street-fronting sibling when the block is not a slum", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const leaves = [rectRing(0, 0, 200, 50), rectRing(0, 50, 200, 50)];
    const result = classifyFrontages(
      streetFrontageDirs(blockRing, boundary, leaves),
      [],
      leaves,
      false
    );
    expect(result.map((entry) => entry.frontage)).toEqual([
      "street",
      "landlocked-merged",
    ]);
  });

  it("should keep a landlocked leaf unmerged when the block is a slum", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const leaves = [rectRing(0, 0, 200, 50), rectRing(0, 50, 200, 50)];
    const result = classifyFrontages(
      streetFrontageDirs(blockRing, boundary, leaves),
      [],
      leaves,
      true
    );
    expect(result.map((entry) => entry.frontage)).toEqual([
      "street",
      "landlocked",
    ]);
  });

  it.each<[number, "alley" | "landlocked"]>([
    [6.1, "alley"],
    [5.9, "landlocked"],
  ])(
    "should classify a leaf sharing %sm of an alley chord as %s",
    (overlap, expected) => {
      const blockRing = rectRing(0, 0, 200, 100);
      const leaves = [rectRing(0, 0, 50, 50)];
      // Collinear with the leaf's bottom edge and stopping short of its far
      // end, so the shared length is the only quantity under test.
      const chord: readonly [Vec2, Vec2] = [
        { x: 0, y: 0 },
        { x: overlap, y: 0 },
      ];
      expect(
        classifyFrontages(
          streetFrontageDirs(blockRing, ALL_BORDER, leaves),
          [chord],
          leaves,
          true
        )[0].frontage
      ).toBe(expected);
    }
  );

  it("should square the lot to the alley rather than the street when only the alley reaches it", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const leaves = [rectRing(0, 0, 200, 100)];
    const chord: readonly [Vec2, Vec2] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ];
    const result = classifyFrontages(
      streetFrontageDirs(blockRing, ALL_BORDER, leaves),
      [chord],
      leaves,
      true
    );
    expect(result[0]).toEqual({ frontage: "alley", dir: { x: 1, y: 0 } });
  });

  it("should prefer the street when the lot fronts both a street and an alley", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const leaves = [rectRing(0, 0, 200, 100)];
    const alleyUpTheSide: readonly [Vec2, Vec2] = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ];
    const result = classifyFrontages(
      streetFrontageDirs(blockRing, boundary, leaves),
      [alleyUpTheSide],
      leaves,
      true
    );
    expect(result[0]).toEqual({ frontage: "street", dir: { x: 1, y: 0 } });
  });
});

describe("insetForAlleys", () => {
  it("should return the ring untouched when no edge lies on an alley", () => {
    const ring = rectRing(0, 0, 20, 20);
    const elsewhere: readonly [Vec2, Vec2] = [
      { x: 100, y: 0 },
      { x: 100, y: 20 },
    ];
    expect(insetForAlleys(ring, [elsewhere])).toEqual(ring);
  });

  it("should take half the alley off every edge lying on one when the lot can afford it", () => {
    const ring = rectRing(0, 0, 20, 20);
    const right: readonly [Vec2, Vec2] = [
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ];
    const left: readonly [Vec2, Vec2] = [
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ];
    const half = ROAD_WIDTH_M.alley / 2;
    expect(insetForAlleys(ring, [right, left])).toEqual([
      { x: half, y: 0 },
      { x: 20 - half, y: 0 },
      { x: 20 - half, y: 20 },
      { x: half, y: 20 },
    ]);
  });

  /**
   * The inside-out case, and the reason the guard reads the winding rather than
   * the area. This lot is narrower than the alley it borders, so the two sides
   * pass through each other: the result is a perfectly simple rectangle wound
   * the wrong way, whose absolute shoelace area is an ordinary 20 m². Probed
   * directly, `isSelfIntersecting` returns false on it and `signedArea` -20.
   */
  it("should keep the whole ring when the inset would turn the lot inside out", () => {
    const ring: readonly Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 20 },
      { x: 0, y: 20 },
    ];
    const right: readonly [Vec2, Vec2] = [
      { x: 1, y: 0 },
      { x: 1, y: 20 },
    ];
    const left: readonly [Vec2, Vec2] = [
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ];
    expect(insetForAlleys(ring, [right, left])).toEqual(ring);
  });

  /**
   * The fold case, which the winding test cannot see: this chevron's notch
   * inverts under the inset and the ring crosses itself, yet its signed area
   * comes back positive at 77.4. The two guards each catch what the other
   * misses, which is why both are there.
   */
  it("should keep the whole ring when the inset would fold a concave lot", () => {
    const chevron: readonly Vec2[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 0.5 },
      { x: 0, y: 10 },
    ];
    const notchRight: readonly [Vec2, Vec2] = [
      { x: 20, y: 10 },
      { x: 10, y: 0.5 },
    ];
    const notchLeft: readonly [Vec2, Vec2] = [
      { x: 10, y: 0.5 },
      { x: 0, y: 10 },
    ];
    expect(insetForAlleys(chevron, [notchRight, notchLeft])).toEqual(chevron);
  });
});

/**
 * No arterials: every block boundary in these fixtures is a `cut`, which the
 * stage prices as a street. That is what these cases were written against —
 * the point under test is subdivision, not which road bounds which edge.
 */
const EMPTY_ROADS: RoadGraph = {
  nodes: [],
  edges: [],
  polylines: { starts: Uint32Array.from([0]), coords: Float32Array.from([]) },
};

const rawBlock = (
  overrides: Partial<Block> & {
    readonly id: number;
    readonly ringIndex: number;
  }
): Block => ({
  boundary: ALL_BORDER,
  neighbourIds: [],
  district: "suburb",
  water: false,
  scoreMargin: 1,
  ...overrides,
});

describe("lotsStage", () => {
  it("should produce a single unsplit lot when the block is a megablock", () => {
    const ring = rectRing(0, 0, 300, 300);
    const blocks = [rawBlock({ id: 0, ringIndex: 0, district: "megablock" })];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([ring]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      poisonStream()
    );
    expect(result.lots.length).toBe(1);
  });

  it("should produce no lots for a block when it is marked water", () => {
    const waterRing = rectRing(0, 0, 100, 100);
    const suburbRing = rectRing(500, 0, 20, 20);
    const blocks = [
      rawBlock({ id: 0, ringIndex: 0, water: true, district: "suburb" }),
      rawBlock({ id: 1, ringIndex: 1, district: "suburb" }),
    ];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([waterRing, suburbRing]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect(result.lots.every((lot) => lot.blockId === 1)).toBe(true);
  });

  it("should split into more than one lot when the block area exceeds its scaled target", () => {
    const district: DistrictKind = "suburb";
    const targetArea = LOT_TARGET_AREA_M2[district];
    const ring = rectRing(0, 0, targetArea, 1);
    const blocks = [rawBlock({ id: 0, ringIndex: 0, district })];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([ring]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect(result.lots.length).toBeGreaterThan(1);
  });

  /**
   * A slum block one street runs along: the lots the street cannot reach are
   * the ones the alleys exist for, so what used to be `landlocked` here is now
   * access rather than the absence of it.
   */
  it("should give the lots a street cannot reach an alley when the block district is slum", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const blocks = [
      rawBlock({
        id: 0,
        ringIndex: 0,
        district: "slum",
        boundary,
      }),
    ];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([blockRing]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    // Asserted as one object so the classification and the road it names are
    // pinned by the same run: a lot called "alley" with no alley in the graph
    // is the exact disagreement this stage has to be unable to produce.
    expect({
      alleyLots: result.lots.some((lot) => lot.frontage === "alley"),
      landlockedLots: result.lots.some((lot) => lot.frontage === "landlocked"),
      alleyEdges: result.roads.edges.some((edge) => edge.cls === "alley"),
    }).toEqual({ alleyLots: true, landlockedLots: false, alleyEdges: true });
  });

  /**
   * The block-level guard. Every boundary here is map border, so there is no
   * road for an alley to end on and publishing one would be a lane to nowhere.
   */
  it("should leave the lots landlocked and publish no alley when no boundary is street-capable", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const blocks = [
      rawBlock({
        id: 0,
        ringIndex: 0,
        district: "slum",
        boundary: ALL_BORDER,
      }),
    ];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([blockRing]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect({
      allLandlocked: result.lots.every((lot) => lot.frontage === "landlocked"),
      edges: result.roads.edges,
    }).toEqual({ allLandlocked: true, edges: [] });
  });

  it("should carry the street network through unchanged when no block needs an alley", () => {
    const ring = rectRing(0, 0, 300, 300);
    const blocks = [rawBlock({ id: 0, ringIndex: 0, district: "megablock" })];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([ring]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      poisonStream()
    );
    expect(result.roads).toEqual(EMPTY_ROADS);
  });

  /**
   * The pool arithmetic `appendSegmentRoads` exists to get right: every alley
   * edge has to index a two-vertex range of its own, or the roads are drawn
   * with each other's geometry.
   */
  it("should give every published alley a two-vertex polyline of its own when the pool is appended to", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const blocks = [
      rawBlock({ id: 0, ringIndex: 0, district: "slum", boundary }),
    ];
    const { roads } = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([blockRing]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect({
      starts: roads.polylines.starts.length,
      everyRangeIsTwo: roads.edges.every(
        (edge) =>
          roads.polylines.starts[edge.polylineIndex + 1] -
            roads.polylines.starts[edge.polylineIndex] ===
          2
      ),
      coords: roads.polylines.coords.length,
    }).toEqual({
      starts: roads.edges.length + 1,
      everyRangeIsTwo: true,
      coords: roads.edges.length * 4,
    });
  });

  it("should size the polygon pool to match the lot count when lots are built", () => {
    const ring = rectRing(0, 0, 300, 300);
    const blocks = [rawBlock({ id: 0, ringIndex: 0, district: "megablock" })];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([ring]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      poisonStream()
    );
    expect(result.polygons.starts.length).toBe(result.lots.length + 1);
  });
});

/**
 * The carriageway comes off the block before any lot is cut, so these cover the
 * geometry that decides how far a building can ever be from a road.
 */
const boundaryOf = (
  kinds: readonly BoundaryRef["kind"][]
): readonly BoundaryRef[] => kinds.map((kind) => ({ kind, refId: 0 }));

describe("buildableRingOf", () => {
  it("should take half a street off every side when every edge is a cut", () => {
    const ring = rectRing(0, 0, 200, 200);
    const inset = buildableRingOf(
      ring,
      boundaryOf(["cut", "cut", "cut", "cut"]),
      EMPTY_ROADS
    );
    const side = 200 - ROAD_WIDTH_M.street;
    expect(polygonArea(inset ?? [])).toBeCloseTo(side * side, 3);
  });

  it("should take nothing off an edge when that edge is the map border", () => {
    const ring = rectRing(0, 0, 200, 200);
    const inset = buildableRingOf(
      ring,
      boundaryOf(["border", "border", "border", "border"]),
      EMPTY_ROADS
    );
    expect(polygonArea(inset ?? [])).toBeCloseTo(200 * 200, 3);
  });

  it("should take half a highway off an edge when a highway bounds it", () => {
    const ring = rectRing(0, 0, 200, 200);
    const roads: RoadGraph = {
      nodes: [],
      edges: [
        {
          id: 7,
          a: 0,
          b: 1,
          cls: "highway",
          crossing: "none",
          polylineIndex: 0,
          strip: false,
        },
      ],
      polylines: {
        starts: Uint32Array.from([0]),
        coords: Float32Array.from([]),
      },
    };
    const boundary: readonly BoundaryRef[] = [
      { kind: "arterial", refId: 7 },
      { kind: "border", refId: 0 },
      { kind: "border", refId: 0 },
      { kind: "border", refId: 0 },
    ];
    const inset = buildableRingOf(ring, boundary, roads);
    // One side loses half a highway; the other three are untouched border.
    expect(polygonArea(inset ?? [])).toBeCloseTo(
      200 * (200 - ROAD_WIDTH_M.highway / 2),
      3
    );
  });

  it("should yield nothing when the roads consume the whole block", () => {
    const ring = rectRing(0, 0, 8, 8);
    expect(
      buildableRingOf(
        ring,
        boundaryOf(["cut", "cut", "cut", "cut"]),
        EMPTY_ROADS
      )
    ).toBeNull();
  });
});

describe("lotsStage frontage direction", () => {
  /**
   * The direction a building squares up to. Nothing asserted what `lotsStage`
   * actually writes here until this existed — the value was produced, carried
   * on the `Lot`, and never checked.
   */
  it("should record the bounding street's direction when a lot fronts one", () => {
    // Wide and shallow, so a single un-split lot keeps the whole ring and its
    // longest cut-provenance edge is the horizontal one.
    const ring = rectRing(0, 0, 400, 60);
    const blocks = [
      rawBlock({
        id: 0,
        ringIndex: 0,
        district: "megablock",
        boundary: boundaryOf(["cut", "border", "border", "border"]),
      }),
    ];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([ring]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      poisonStream()
    );
    expect(result.lots[0].frontageDir).toEqual({ x: 1, y: 0 });
  });

  it("should record no direction when the lot fronts no street", () => {
    const ring = rectRing(0, 0, 400, 60);
    const blocks = [rawBlock({ id: 0, ringIndex: 0, district: "megablock" })];
    const result = lotsStage(
      {
        blocks,
        blockPolygons: buildPolygonPool([ring]),
        grid: TEST_GRID,
        roads: EMPTY_ROADS,
      },
      poisonStream()
    );
    expect(result.lots[0].frontageDir).toBeNull();
  });
});

describe("isSelfIntersecting", () => {
  it("should report false when the ring is a simple rectangle", () => {
    expect(isSelfIntersecting(rectRing(0, 0, 10, 10))).toBe(false);
  });

  it("should report true when two non-adjacent edges cross", () => {
    // A bow tie: the classic folded quad.
    expect(
      isSelfIntersecting([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ])
    ).toBe(true);
  });

  it("should report false when the ring has fewer than four vertices", () => {
    expect(
      isSelfIntersecting([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ])
    ).toBe(false);
  });
});
