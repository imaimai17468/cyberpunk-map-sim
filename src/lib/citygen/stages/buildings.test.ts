import {
  DISTRICT_KINDS,
  type Block,
  type BuildingArchetype,
  type DistrictKind,
  type FieldStack,
  type GenerationParams,
  type Lot,
  type PolygonPool,
  type RoadEdge,
  type RoadGraph,
  type TerrainLayer,
  type Vec2,
} from "@/entities/city";
import { describe, expect, it } from "vitest";
import { BUILDINGS } from "../constants";
import { createField2D } from "../field/field2d";
import type { RngStream } from "../rng/types";
import type { AnchorSet, DerivedFields, PipelineContext } from "./types";
import {
  applySlenderness,
  buildingsStage,
  casinoMassing,
  corpoMassing,
  DISTRICT_ARCHETYPE,
  luxuryMassing,
  type MassingContext,
  megabuildingMassing,
  slumBaseZ,
  slumFloorHeight,
  slumMassing,
  suburbMassing,
} from "./buildings";

const GRID = { cells: 8, sizeM: 800, cellSizeM: 100 };

const constantField = (value: number) =>
  createField2D(GRID.cells, GRID.cellSizeM, () => value);

/** Elevation that rises linearly in world x — bilinear-interpolates back exactly. */
const linearElevationField = (slope: number) =>
  createField2D(
    GRID.cells,
    GRID.cellSizeM,
    (_index, cx) => slope * cx * GRID.cellSizeM
  );

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

// similarity-ignore: a local fixture builder; sharing it with zoning.test.ts would couple two stages' test setups so that retuning one silently changes the other's fixtures.
const polylinePool = (
  polylines: readonly (readonly Vec2[])[]
): {
  readonly coords: Float32Array;
  readonly starts: Uint32Array;
} => ({
  starts: Uint32Array.from(prefixSums(polylines.map((line) => line.length))),
  coords: Float32Array.from(
    polylines.flatMap((line) => line.flatMap((p) => [p.x, p.y]))
  ),
});

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

const PARAMS: GenerationParams = {
  seed: "test",
  sizeM: GRID.sizeM,
  cells: GRID.cells,
};

const buildAnchors = (): AnchorSet => ({
  anchors: [],
  cbd: { x: 0, y: 0 },
  megaSeeds: [],
  casino: { x: 0, y: 0 },
  stripAxis: { origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 } },
});

const buildDerived = (): DerivedFields => ({
  slope: constantField(0),
  distWater: constantField(1000),
  distLand: constantField(0),
  localEminence: constantField(0),
  floodRisk: constantField(0),
});

interface ContextOptions {
  readonly elevationSlope?: number;
  readonly centrality?: number;
  readonly prestige?: number;
  readonly decay?: number;
}

const buildFields = (opts: ContextOptions): FieldStack => ({
  slope: constantField(0),
  distWater: constantField(1000),
  distLand: constantField(0),
  localEminence: constantField(0),
  floodRisk: constantField(0),
  centrality: constantField(opts.centrality ?? 0),
  shadow: constantField(0),
  prestige: constantField(opts.prestige ?? 0),
  decay: constantField(opts.decay ?? 0),
});

const buildTerrain = (opts: ContextOptions): TerrainLayer => ({
  elevation: linearElevationField(opts.elevationSlope ?? 0),
  waterMask: new Uint8Array(GRID.cells * GRID.cells),
  waterDepth: constantField(0),
  seaLevelM: 0,
});

const buildContext = (opts: ContextOptions = {}): PipelineContext => ({
  params: PARAMS,
  grid: GRID,
  terrain: buildTerrain(opts),
  derived: buildDerived(),
  anchors: buildAnchors(),
  fields: buildFields(opts),
});

const constantStream = (value: number): RngStream => ({
  next: () => value,
  nextInt: () => 0,
  fork: () => constantStream(value),
});

const sequenceStream = (values: readonly number[]): RngStream => {
  const state = { index: 0 };
  return {
    next: () => {
      const v = values[state.index] ?? 0;
      state.index += 1;
      return v;
    },
    nextInt: () => 0,
    fork: () => sequenceStream(values.slice(state.index)),
  };
};

const BASE_CTX: MassingContext = {
  lotObb: { cx: 0, cy: 0, facing: { x: 1, y: 0 }, w: 100, d: 50 },
  centrality: 0.5,
  prestige: 0,
  decay: 0,
  minElevation: 0,
  maxElevation: 0,
  relief: 0,
  stripDistance: Number.POSITIVE_INFINITY,
  stripDirection: null,
  stream: constantStream(0.5),
};

describe("DISTRICT_ARCHETYPE", () => {
  it.each<[DistrictKind, BuildingArchetype]>([
    ["corporate", "corpoTower"],
    ["megablock", "megabuilding"],
    ["casino", "casino"],
    ["luxury", "luxuryResidence"],
    ["suburb", "detachedHouse"],
    ["slum", "slumShack"],
  ])("should map district %s to archetype %s", (district, expected) => {
    expect(DISTRICT_ARCHETYPE[district]).toBe(expected);
  });

  it("should map every district kind when the table is complete", () => {
    expect(Object.keys(DISTRICT_ARCHETYPE).length).toBe(DISTRICT_KINDS.length);
  });
});

describe("corpoMassing", () => {
  /**
   * Both rows share `centrality = 0.5` (base = 90 + 240*0.25 = 150). At
   * u = 0.95 (below the 0.96 spike threshold) height is 150 * (0.72 + 0.28*0.95)
   * = 147.9, well under the 330 m clamp. At u = 0.98 the spike multiplier
   * (1.5 + 2.5*(0.98-0.96)/0.04 = 2.75) pushes the raw height past 330,
   * so the clamp — not the spike formula — determines the result.
   */
  it.each<[number, number]>([
    [0.95, 147.9],
    [0.98, 330],
  ])("should compute height %s for draw u=%s", (u, expected) => {
    const ctx: MassingContext = { ...BASE_CTX, stream: constantStream(u) };
    expect(corpoMassing(ctx).heightM).toBeCloseTo(expected, 4);
  });
});

describe("megabuildingMassing", () => {
  it("should sum tier height fractions to one when tiers are generated", () => {
    const ctx: MassingContext = { ...BASE_CTX, stream: constantStream(0.5) };
    const result = megabuildingMassing(ctx);
    const total = result.tiers.reduce((sum, tier) => sum + tier.heightFrac, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("casinoMassing", () => {
  it.each<[number, Vec2 | null, Vec2]>([
    [10, { x: 1, y: 0 }, { x: -0, y: 1 }],
    [100, { x: 1, y: 0 }, { x: 1, y: 0 }],
    [10, null, { x: 1, y: 0 }],
  ])(
    "should resolve facing when stripDistance=%s and stripDirection=%s",
    (stripDistance, stripDirection, expectedFacing) => {
      const ctx: MassingContext = {
        ...BASE_CTX,
        stripDistance,
        stripDirection,
      };
      expect(casinoMassing(ctx).footprint.facing).toEqual(expectedFacing);
    }
  );
});

describe("luxuryMassing", () => {
  it("should shrink the footprint when prestige grows", () => {
    const low = luxuryMassing({ ...BASE_CTX, prestige: 0 }).footprint.w;
    const high = luxuryMassing({ ...BASE_CTX, prestige: 1 }).footprint.w;
    expect(high).toBeLessThan(low);
  });
});

describe("suburbMassing", () => {
  it("should offset the footprint when placed on the frontage-side third", () => {
    const result = suburbMassing(BASE_CTX);
    expect(result.footprint.cx).not.toBe(BASE_CTX.lotObb.cx);
  });
});

describe("slumBaseZ", () => {
  it.each<[number, number]>([
    [2.79, 0],
    [2.81, BUILDINGS.shackTerraceStepM],
  ])(
    "should quantise relief=%s to a terrace step base of %s",
    (relief, expected) => {
      const ctx: MassingContext = { ...BASE_CTX, relief, minElevation: 0 };
      expect(slumBaseZ(ctx)).toBeCloseTo(expected, 6);
    }
  );
});

describe("slumFloorHeight", () => {
  it.each<[number, number]>([
    [0, BUILDINGS.shackTerraceStepM],
    [0.99, 3 * BUILDINGS.shackTerraceStepM],
  ])("should floor-quantise draw u=%s to %s metres", (u, expected) => {
    expect(slumFloorHeight(u)).toBeCloseTo(expected, 6);
  });
});

describe("slumMassing", () => {
  it("should return only the primary box when the second-box draw is at or above the chance threshold", () => {
    const ctx: MassingContext = {
      ...BASE_CTX,
      stream: sequenceStream([0.5, 0.5, 0.5]),
    };
    expect(slumMassing(ctx).length).toBe(1);
  });

  it("should return a secondary lean-to box when the second-box draw is below the chance threshold", () => {
    const ctx: MassingContext = {
      ...BASE_CTX,
      stream: sequenceStream([0.5, 0.5, 0.2, 0.5, 0.5]),
    };
    expect(slumMassing(ctx).length).toBe(2);
  });
});

describe("applySlenderness", () => {
  it.each<[number, number]>([
    [1000, BUILDINGS.maxSlenderness * 10],
    [50, 50],
  ])(
    "should clamp a %sm tower to %s when it exceeds the slenderness limit",
    (heightM, expected) => {
      const result = applySlenderness({
        footprint: { cx: 0, cy: 0, facing: { x: 1, y: 0 }, w: 10, d: 10 },
        heightM,
        baseZM: 0,
        tiers: [],
      });
      expect(result.heightM).toBeCloseTo(expected, 6);
    }
  );
});

const rawBlock = (id: number, district: DistrictKind): Block => ({
  id,
  ringIndex: id,
  boundary: [],
  neighbourIds: [],
  district,
  water: false,
  scoreMargin: 1,
});

const rawLot = (id: number, blockId: number): Lot => ({
  id,
  blockId,
  ringIndex: id,
  frontage: "street",
});

describe("buildingsStage", () => {
  it.each<[DistrictKind, number, number]>([
    ["corporate", 0.118, 0],
    ["corporate", 0.122, 1],
    ["slum", 0.122, 0],
  ])(
    "should veto district %s to a plaza only when relief exceeds the veto threshold for non-shack archetypes",
    (district, slope, expectedPlazaCount) => {
      const ring = rectRing(0, 0, 100, 100);
      const context = buildContext({ elevationSlope: slope });
      const blocks = [rawBlock(0, district)];
      const lotLayer = {
        lots: [rawLot(0, 0)],
        polygons: buildPolygonPool([ring]),
      };
      const result = buildingsStage(
        { context, blocks, lotLayer, roads: EMPTY_ROADS },
        constantStream(0.5)
      );
      expect(result.plazaLotIds.length).toBe(expectedPlazaCount);
    }
  );

  it("should veto a lot to a plaza when its footprint is below the minimum area", () => {
    const ring = rectRing(0, 0, 1, 1);
    const context = buildContext();
    const blocks = [rawBlock(0, "corporate")];
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    const result = buildingsStage(
      { context, blocks, lotLayer, roads: EMPTY_ROADS },
      constantStream(0.5)
    );
    expect(result.plazaLotIds).toEqual([0]);
  });

  it("should throw when a lot references a block id that does not exist", () => {
    const ring = rectRing(0, 0, 100, 100);
    const context = buildContext();
    const blocks: readonly Block[] = [];
    const lotLayer = {
      lots: [rawLot(0, 999)],
      polygons: buildPolygonPool([ring]),
    };
    expect(() =>
      buildingsStage(
        { context, blocks, lotLayer, roads: EMPTY_ROADS },
        constantStream(0.5)
      )
    ).toThrow("buildings: unknown block id 999");
  });

  it("should snap a casino's facing toward the strip when within the snap distance", () => {
    const ring = rectRing(0, 0, 100, 100);
    const context = buildContext();
    const blocks = [rawBlock(0, "casino")];
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
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
    const result = buildingsStage(
      { context, blocks, lotLayer, roads },
      constantStream(0.5)
    );
    expect(result.buildings[0].obb.facing).toEqual({ x: -0, y: 1 });
  });

  it("should produce one building per buildable lot when nothing is vetoed", () => {
    const ringA = rectRing(0, 0, 100, 100);
    const ringB = rectRing(200, 0, 100, 100);
    const ringC = rectRing(400, 0, 100, 100);
    const context = buildContext();
    const blocks = [
      rawBlock(0, "megablock"),
      rawBlock(1, "luxury"),
      rawBlock(2, "suburb"),
    ];
    const lotLayer = {
      lots: [rawLot(0, 0), rawLot(1, 1), rawLot(2, 2)],
      polygons: buildPolygonPool([ringA, ringB, ringC]),
    };
    const result = buildingsStage(
      { context, blocks, lotLayer, roads: EMPTY_ROADS },
      constantStream(0.5)
    );
    expect(result.buildings.length).toBe(3);
  });
});
