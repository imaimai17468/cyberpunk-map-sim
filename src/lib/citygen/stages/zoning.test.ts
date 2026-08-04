import type {
  DistrictKind,
  FieldStack,
  GenerationParams,
  PolygonPool,
  PolylinePool,
  RoadEdge,
  RoadGraph,
  TerrainLayer,
  Vec2,
} from "@/entities/city";
import { describe, expect, it } from "vitest";
import { createField2D } from "../field/field2d";
import type { RngStream } from "../rng/types";
import type { AnchorSet, DerivedFields, PipelineContext } from "./types";
import {
  applyMegalotRim,
  applyModeFilterPasses,
  band,
  modeFilterStep,
  smoothstep,
  zoningStage,
} from "./zoning";

const GRID = { cells: 4, sizeM: 400, cellSizeM: 100 };

const constantField = (value: number) =>
  createField2D(GRID.cells, GRID.cellSizeM, () => value);

/**
 * One constant value per `FieldStack` layer, for building fixtures.
 *
 * Derived from `FieldStack` rather than re-declared: adding a layer to the
 * stack now forces every fixture here to account for it, instead of leaving a
 * hand-maintained copy to drift out of sync silently.
 */
type FieldValues = { readonly [K in keyof FieldStack]: number };

const DEFAULT_FIELDS: FieldValues = {
  slope: 0,
  distWater: 1000,
  distLand: 0,
  localEminence: 0,
  floodRisk: 0,
  centrality: 0,
  shadow: 0,
  prestige: 0,
  decay: 0,
};

const buildFieldStack = (overrides: Partial<FieldValues> = {}): FieldStack => {
  const v = { ...DEFAULT_FIELDS, ...overrides };
  return {
    slope: constantField(v.slope),
    distWater: constantField(v.distWater),
    distLand: constantField(v.distLand),
    localEminence: constantField(v.localEminence),
    floodRisk: constantField(v.floodRisk),
    centrality: constantField(v.centrality),
    shadow: constantField(v.shadow),
    prestige: constantField(v.prestige),
    decay: constantField(v.decay),
  };
};

const buildDerived = (): DerivedFields => ({
  slope: constantField(0),
  distWater: constantField(1000),
  distLand: constantField(0),
  localEminence: constantField(0),
  floodRisk: constantField(0),
});

const buildTerrain = (): TerrainLayer => ({
  elevation: constantField(0),
  waterMask: new Uint8Array(GRID.cells * GRID.cells),
  waterDepth: constantField(0),
  seaLevelM: 0,
});

const buildAnchors = (megaSeeds: readonly Vec2[] = []): AnchorSet => ({
  anchors: [],
  cbd: { x: 0, y: 0 },
  megaSeeds,
  casino: { x: 0, y: 0 },
  stripAxis: { origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 } },
});

const PARAMS: GenerationParams = {
  seed: "test",
  sizeM: GRID.sizeM,
  cells: GRID.cells,
};

const buildContext = (
  fieldValues: Partial<FieldValues> = {},
  megaSeeds: readonly Vec2[] = []
): PipelineContext => ({
  params: PARAMS,
  grid: GRID,
  terrain: buildTerrain(),
  derived: buildDerived(),
  anchors: buildAnchors(megaSeeds),
  fields: buildFieldStack(fieldValues),
});

const squareRing = (x0: number, y0: number, size: number): readonly Vec2[] => [
  { x: x0, y: y0 },
  { x: x0 + size, y: y0 },
  { x: x0 + size, y: y0 + size },
  { x: x0, y: y0 + size },
];

const singleRingPool = (ring: readonly Vec2[]): PolygonPool => ({
  starts: Uint32Array.from([0, ring.length]),
  coords: Float32Array.from(ring.flatMap((p) => [p.x, p.y])),
});

const multiRingPool = (rings: readonly (readonly Vec2[])[]): PolygonPool => {
  const starts = rings.reduce<number[]>(
    (acc, ring) => {
      acc.push(acc[acc.length - 1] + ring.length);
      return acc;
    },
    [0]
  );
  return {
    starts: Uint32Array.from(starts),
    coords: Float32Array.from(
      rings.flatMap((ring) => ring.flatMap((p) => [p.x, p.y]))
    ),
  };
};

/**
 * A local fixture builder; see `buildings.test.ts` — kept separate so each
 * stage's fixtures stay independent. The return type is the engine's own
 * `PolylinePool`, which is what both were spelling out field by field.
 */
const polylinePool = (
  polylines: readonly (readonly Vec2[])[]
): PolylinePool => {
  const starts = polylines.reduce<number[]>(
    (acc, line) => {
      acc.push(acc[acc.length - 1] + line.length);
      return acc;
    },
    [0]
  );
  return {
    starts: Uint32Array.from(starts),
    coords: Float32Array.from(
      polylines.flatMap((line) => line.flatMap((p) => [p.x, p.y]))
    ),
  };
};

const EMPTY_ROADS: RoadGraph = {
  nodes: [],
  edges: [],
  polylines: { coords: new Float32Array(0), starts: Uint32Array.from([0]) },
};

const stripRoadEdge = (id: number, polylineIndex: number): RoadEdge => ({
  id,
  a: -1,
  b: -1,
  cls: "avenue",
  crossing: "none",
  polylineIndex,
  strip: true,
});

const NOOP_STREAM: RngStream = {
  next: () => 0,
  nextInt: () => 0,
  fork: () => NOOP_STREAM,
};

describe("smoothstep", () => {
  it.each([
    [-5, 0],
    [50, 0.5],
    [105, 1],
  ])("should ease from 0 to 1 when x is %s", (x, expected) => {
    expect(smoothstep(0, 100, x)).toBeCloseTo(expected, 6);
  });
});

describe("band", () => {
  it.each([
    [0, 0],
    [200, 1],
    [1000, 0],
  ])(
    "should form a plateau over [60,400] when distance is %s",
    (value, expected) => {
      expect(band(value, 60, 400)).toBeCloseTo(expected, 2);
    }
  );
});

describe("modeFilterStep", () => {
  /**
   * The majority neighbour label is "slum" — later than "corporate" in
   * `DISTRICT_KINDS` — so the majority-finding reduce must replace its
   * running best at least once, exercising both sides of that comparison.
   */
  it.each<[number, DistrictKind]>([
    [0.05, "slum"],
    [0.2, "suburb"],
  ])("should decide via own margin %s", (margin, expected) => {
    const labels: readonly DistrictKind[] = [
      "suburb",
      "slum",
      "slum",
      "slum",
      "slum",
    ];
    const margins = [margin, 1, 1, 1, 1];
    const neighbourIndexLists = [[1, 2, 3, 4], [], [], [], []];
    expect(modeFilterStep(0, labels, margins, neighbourIndexLists)).toBe(
      expected
    );
  });

  it("should hold its own label when eligible but no district reaches the agreement threshold", () => {
    const labels: readonly DistrictKind[] = [
      "suburb",
      "corporate",
      "corporate",
      "slum",
      "slum",
    ];
    const margins = [0.01, 1, 1, 1, 1];
    const neighbourIndexLists = [[1, 2, 3, 4], [], [], [], []];
    expect(modeFilterStep(0, labels, margins, neighbourIndexLists)).toBe(
      "suburb"
    );
  });
});

describe("applyModeFilterPasses", () => {
  /**
   * A 3-link dependency chain (blocks 0 -> 1 -> 2, each needing the previous
   * block's flip to reach the 4-neighbour agreement threshold) plus four
   * pinned corporate blocks (3-6) supplying three of each dynamic block's
   * four neighbours. Under correct synchronous double-buffering, block 0
   * flips in pass 1 (its neighbours are already all corporate); block 1
   * needs block 0's *pass-1* result and so only flips in pass 2; block 2
   * would need block 1's pass-2 result, which no third pass ever reads, so
   * it must still be "slum" after exactly `modeFilterPasses` (2) passes. A
   * naive in-place update would let block 0's flip leak into block 1's count
   * within the very first pass, and that leak again into block 2 - cascading
   * all three to "corporate" after just one pass.
   */
  it("should hold the third block as slum when only two passes run", () => {
    const labels: readonly DistrictKind[] = [
      "slum",
      "slum",
      "slum",
      "corporate",
      "corporate",
      "corporate",
      "corporate",
    ];
    const margins = [0.01, 0.01, 0.01, 1, 1, 1, 1];
    const neighbourIndexLists = [
      [3, 4, 5, 6],
      [0, 4, 5, 6],
      [1, 4, 5, 6],
      [],
      [],
      [],
      [],
    ];
    const result = applyModeFilterPasses(labels, margins, neighbourIndexLists);
    expect(result).toEqual([
      "corporate",
      "corporate",
      "slum",
      "corporate",
      "corporate",
      "corporate",
      "corporate",
    ]);
  });
});

describe("applyMegalotRim", () => {
  it.each<[DistrictKind, number, DistrictKind, DistrictKind]>([
    ["corporate", 12001, "slum", "megablock"],
    ["corporate", 11999, "slum", "corporate"],
    ["corporate", 12001, "suburb", "corporate"],
    ["suburb", 12001, "slum", "suburb"],
  ])(
    "should resolve district %s area %s neighbour %s to %s",
    (label, area, neighbourLabel, expected) => {
      const labels: readonly DistrictKind[] = [label, neighbourLabel];
      const areas = [area, 100];
      const neighbourIndexLists = [[1], []];
      const result = applyMegalotRim(labels, areas, neighbourIndexLists);
      expect(result[0]).toBe(expected);
    }
  );
});

describe("zoningStage", () => {
  it("should throw when a block references a neighbour id that does not exist", () => {
    const ring = squareRing(0, 0, 100);
    const context = buildContext();
    const blockLayer = {
      blocks: [
        {
          id: 0,
          ringIndex: 0,
          boundary: [
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
          ],
          neighbourIds: [999],
          water: false,
        },
      ],
      polygons: singleRingPool(ring),
      roads: EMPTY_ROADS,
    };
    expect(() => zoningStage({ context, blockLayer }, NOOP_STREAM)).toThrow(
      "zoning: unknown neighbour block id 999"
    );
  });

  it("should pick slum when decay dominates every other affinity", () => {
    const ringA = squareRing(0, 0, 100);
    const ringB = squareRing(200, 0, 100);
    const context = buildContext({ decay: 1 });
    const border = [
      { kind: "border" as const, refId: 0 },
      { kind: "border" as const, refId: 0 },
      { kind: "border" as const, refId: 0 },
      { kind: "border" as const, refId: 0 },
    ];
    const blockLayer = {
      blocks: [
        {
          id: 0,
          ringIndex: 0,
          boundary: border,
          neighbourIds: [1],
          water: false,
        },
        {
          id: 1,
          ringIndex: 1,
          boundary: border,
          neighbourIds: [0],
          water: false,
        },
      ],
      polygons: multiRingPool([ringA, ringB]),
      roads: EMPTY_ROADS,
    };
    const result = zoningStage({ context, blockLayer }, NOOP_STREAM);
    expect(result[0].district).toBe("slum");
  });

  it("should force megablock when the block contains a mega seed", () => {
    const ring = squareRing(0, 0, 100);
    const context = buildContext({ decay: 1 }, [{ x: 50, y: 50 }]);
    const blockLayer = {
      blocks: [
        {
          id: 0,
          ringIndex: 0,
          boundary: [
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
          ],
          neighbourIds: [],
          water: false,
        },
      ],
      polygons: singleRingPool(ring),
      roads: EMPTY_ROADS,
    };
    const result = zoningStage({ context, blockLayer }, NOOP_STREAM);
    expect(result[0].district).toBe("megablock");
  });

  /**
   * Also exercises the strip-adjacency helpers' less common branches: a
   * degenerate one-point polyline (skipped outright), a zero-length segment
   * (the near-zero-length branch in `distanceToSegment`), and a real
   * strip segment close enough to score the block toward `casino`.
   */
  it("should pick casino when the block sits near a real strip segment", () => {
    const ring = squareRing(0, 0, 100);
    const context = buildContext({ distWater: 200 });
    const roads: RoadGraph = {
      nodes: [],
      edges: [stripRoadEdge(0, 0), stripRoadEdge(1, 1), stripRoadEdge(2, 2)],
      polylines: polylinePool([
        [
          { x: -1000, y: 50 },
          { x: 1000, y: 50 },
        ],
        [{ x: 9999, y: 9999 }],
        [
          { x: 9999, y: 9999 },
          { x: 9999, y: 9999 },
        ],
      ]),
    };
    const blockLayer = {
      blocks: [
        {
          id: 0,
          ringIndex: 0,
          boundary: [
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
            { kind: "border" as const, refId: 0 },
          ],
          neighbourIds: [],
          water: false,
        },
      ],
      polygons: singleRingPool(ring),
      roads,
    };
    const result = zoningStage({ context, blockLayer }, NOOP_STREAM);
    expect(result[0].district).toBe("casino");
  });
});
