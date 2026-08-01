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
  buildableRingOf,
  classifyFrontages,
  computeAreaScale,
  lotsStage,
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
    expect(result).toEqual([ring]);
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
    expect(result).toEqual([degenerateRing]);
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
    expect(result.length).toBe(2);
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
    expect(result.length).toBe(2);
  });
});

describe("classifyFrontages", () => {
  it.each<[number, "street" | "landlocked"]>([
    [6.1, "street"],
    [5.9, "landlocked"],
  ])("should classify a %sm cut-provenance edge as %s", (width, expected) => {
    const ring = rectRing(0, 0, width, 50);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const result = classifyFrontages(ring, boundary, [ring], false);
    expect(result[0]).toBe(expected);
  });

  it("should merge a landlocked leaf into its street-fronting sibling when the block is not a slum", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const bottomHalf = rectRing(0, 0, 200, 50);
    const topHalf = rectRing(0, 50, 200, 50);
    const result = classifyFrontages(
      blockRing,
      boundary,
      [bottomHalf, topHalf],
      false
    );
    expect(result).toEqual(["street", "landlocked-merged"]);
  });

  it("should keep a landlocked leaf unmerged when the block is a slum", () => {
    const blockRing = rectRing(0, 0, 200, 100);
    const boundary: readonly BoundaryRef[] = [CUT, BORDER, BORDER, BORDER];
    const bottomHalf = rectRing(0, 0, 200, 50);
    const topHalf = rectRing(0, 50, 200, 50);
    const result = classifyFrontages(
      blockRing,
      boundary,
      [bottomHalf, topHalf],
      true
    );
    expect(result).toEqual(["street", "landlocked"]);
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

  it("should keep at least one lot landlocked when the block district is slum", () => {
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
    expect(result.lots.some((lot) => lot.frontage === "landlocked")).toBe(true);
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
