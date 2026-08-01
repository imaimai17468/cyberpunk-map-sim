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
  obbAlignedTo,
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
  /** Fills the whole water mask, so every lot reads as submerged. */
  readonly allWater?: boolean;
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
  waterMask: new Uint8Array(GRID.cells * GRID.cells).fill(
    opts.allWater === true ? 1 : 0
  ),
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
  frontageDir: null,
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

  /**
   * The lot is shallow and the strip runs past it rather than through it. Both
   * matter: the snap needs the strip within `facingSnapM` of the lot centroid,
   * and the footprint needs to clear the strip's own carriageway — a strip laid
   * down the middle of the lot satisfies the first and makes the second
   * impossible, which collapses the building and leaves nothing to assert on.
   */
  it("should snap a casino's facing toward the strip when within the snap distance", () => {
    const ring = rectRing(0, 0, 100, 20);
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
          { x: -1000, y: 45 },
          { x: 1000, y: 45 },
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

/**
 * The box a building is massed inside. Its angle is what decides whether a
 * facade ends up parallel to the street or at an arbitrary angle to it.
 */
describe("obbAlignedTo", () => {
  const square: readonly Vec2[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 0, y: 4 },
  ];

  it("should take the given axis as its facing when aligning to an axis", () => {
    const axis = { x: 0, y: 1 };
    expect(obbAlignedTo(square, axis).facing).toEqual(axis);
  });

  it("should measure width along the axis when the axis is the long side", () => {
    const result = obbAlignedTo(square, { x: 1, y: 0 });
    expect([result.w, result.d]).toEqual([10, 4]);
  });

  it("should swap the extents when the axis is the short side", () => {
    const result = obbAlignedTo(square, { x: 0, y: 1 });
    expect([result.w, result.d]).toEqual([4, 10]);
  });

  it("should centre the box on the points when aligning to an axis", () => {
    const result = obbAlignedTo(square, { x: 1, y: 0 });
    expect([result.cx, result.cy]).toEqual([5, 2]);
  });

  /** A 45-degree axis over a unit square: both extents become the diagonal. */
  it("should span the diagonal when the axis runs corner to corner", () => {
    const unit: readonly Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const d = Math.SQRT1_2;
    const result = obbAlignedTo(unit, { x: d, y: d });
    expect(result.w).toBeCloseTo(Math.SQRT2, 6);
  });
});

/**
 * The geometry that decides where a footprint may sit. These branches were
 * unreachable from the fixtures above — every lot there is a large rectangle
 * with no road near it, so the fit always succeeded on its first try and the
 * shrink was never entered.
 */
const footprintArea = (o: { readonly w: number; readonly d: number }): number =>
  o.w * o.d;

describe("buildingsStage footprint fitting", () => {
  /**
   * The regression this was written for. An avenue laid straight through the
   * middle of the lot puts the footprint's own centre inside a carriageway,
   * and every concentric shrink shares that centre, so the fit collapses to
   * zero at any scale. The lot used to then vanish from `buildings` *and* from
   * `plazaLotIds`, contradicting this stage's contract that a vetoed lot is
   * always named. A hole is the one outcome that is not allowed.
   */
  it("should still name the lot as a plaza when its footprint collapses", () => {
    const ring = rectRing(0, 0, 100, 100);
    const context = buildContext();
    const blocks = [rawBlock(0, "suburb")];
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    // A highway: 30 m of carriageway, so its 15 m half-width swallows the
    // footprint's centre wherever the massing puts it along the lot.
    const throughTheMiddle: RoadGraph = {
      nodes: [],
      edges: [
        {
          id: 0,
          a: -1,
          b: -1,
          cls: "highway",
          crossing: "none",
          polylineIndex: 0,
          strip: false,
        },
      ],
      polylines: polylinePool([
        [
          { x: -50, y: 50 },
          { x: 150, y: 50 },
        ],
      ]),
    };
    const result = buildingsStage(
      { context, blocks, lotLayer, roads: throughTheMiddle },
      constantStream(0.5)
    );
    const named =
      result.buildings.some((b) => b.lotId === 0) ||
      result.plazaLotIds.includes(0);
    expect(named).toBe(true);
  });

  /**
   * A road crossing the lot's interior bounds nothing — no block boundary
   * corresponds to it — so the block inset never accounted for it. The
   * footprint has to give way to it here or it stands in the carriageway.
   */
  it("should shrink the footprint when a road crosses the lot interior", () => {
    const ring = rectRing(0, 0, 100, 100);
    const context = buildContext();
    const blocks = [rawBlock(0, "suburb")];
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    const clear = buildingsStage(
      { context, blocks, lotLayer, roads: EMPTY_ROADS },
      constantStream(0.5)
    );
    // An avenue along the lot's own edge, offset enough that its carriageway
    // eats into the plot without swallowing the centre.
    const crossed: RoadGraph = {
      nodes: [],
      edges: [stripRoadEdge(0, 0)],
      polylines: polylinePool([
        [
          { x: -50, y: 20 },
          { x: 150, y: 20 },
        ],
      ]),
    };
    const withRoad = buildingsStage(
      { context, blocks, lotLayer, roads: crossed },
      constantStream(0.5)
    );
    expect(footprintArea(withRoad.buildings[0].obb)).toBeLessThan(
      footprintArea(clear.buildings[0].obb)
    );
  });

  it("should square the footprint to the street when the lot fronts one", () => {
    const ring = rectRing(0, 0, 100, 60);
    const context = buildContext();
    const blocks = [rawBlock(0, "suburb")];
    // The ring's own long axis is +x; the frontage points the other way, so a
    // result matching it can only have come from `frontageDir`.
    const frontageDir = { x: 0, y: 1 };
    const lotLayer = {
      lots: [{ ...rawLot(0, 0), frontageDir }],
      polygons: buildPolygonPool([ring]),
    };
    const result = buildingsStage(
      { context, blocks, lotLayer, roads: EMPTY_ROADS },
      constantStream(0.5)
    );
    expect(result.buildings[0].obb.facing).toEqual(frontageDir);
  });
});

/**
 * The corner-only clearance test's blind spot, pinned.
 *
 * A corridor running lengthwise down the middle of a footprint is at its
 * furthest from all four corners, so a corner test passes at full scale and
 * the shrink never runs — the road goes through the building end to end. The
 * perpendicular case above does not catch this: there, shrinking eventually
 * pulls the corners back into the corridor, so the fit bottoms out correctly.
 */
describe("buildingsStage clearance along the footprint's own axis", () => {
  it("should shrink the footprint when a road runs lengthwise through it", () => {
    const ring = rectRing(0, 0, 100, 100);
    const context = buildContext();
    const blocks = [rawBlock(0, "suburb")];
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    const clear = buildingsStage(
      { context, blocks, lotLayer, roads: EMPTY_ROADS },
      constantStream(0.5)
    );
    const alongTheAxis: RoadGraph = {
      nodes: [],
      edges: [
        {
          id: 0,
          a: -1,
          b: -1,
          cls: "alley",
          crossing: "none",
          polylineIndex: 0,
          strip: false,
        },
      ],
      polylines: polylinePool([
        [
          { x: -50, y: 50 },
          { x: 150, y: 50 },
        ],
      ]),
    };
    const withRoad = buildingsStage(
      { context, blocks, lotLayer, roads: alongTheAxis },
      constantStream(0.5)
    );
    // Absent counts as zero: an alley down the centre line leaves no scale at
    // which the box clears it, so the honest result here is no building at all
    // rather than a smaller one.
    const builtArea = (result: typeof clear): number =>
      result.buildings.reduce((sum, b) => sum + footprintArea(b.obb), 0);
    expect(builtArea(withRoad)).toBeLessThan(builtArea(clear));
  });
});

/**
 * A block is called water by a majority vote over five interior samples, so a
 * block that is four-tenths sea is land and its lots run out past the shore.
 * Nothing downstream looked at water at all, which put whole slum districts in
 * the sea. The veto is per lot for that reason.
 */
describe("buildingsStage over water", () => {
  it("should build nothing when the lot is submerged", () => {
    const ring = rectRing(0, 0, 100, 100);
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    const result = buildingsStage(
      {
        context: buildContext({ allWater: true }),
        blocks: [rawBlock(0, "suburb")],
        lotLayer,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect(result.buildings).toEqual([]);
  });

  it("should name the lot as a plaza when it is submerged", () => {
    const ring = rectRing(0, 0, 100, 100);
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    const result = buildingsStage(
      {
        context: buildContext({ allWater: true }),
        blocks: [rawBlock(0, "suburb")],
        lotLayer,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect(result.plazaLotIds).toEqual([0]);
  });

  it("should still build when the lot is entirely dry", () => {
    const ring = rectRing(0, 0, 100, 100);
    const lotLayer = {
      lots: [rawLot(0, 0)],
      polygons: buildPolygonPool([ring]),
    };
    const result = buildingsStage(
      {
        context: buildContext(),
        blocks: [rawBlock(0, "suburb")],
        lotLayer,
        roads: EMPTY_ROADS,
      },
      constantStream(0.5)
    );
    expect(result.buildings.length).toBeGreaterThan(0);
  });
});
