import type { Crossing, RoadClass, TerrainLayer, Vec2 } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { describe, expect, it } from "vitest";
import { createField2D } from "../field/field2d";
import {
  arterialsStage,
  backtrackPath,
  buildArterialCostField,
  buildAugmentedVertices,
  buildAvenuePaths,
  buildHighwayPaths,
  buildStripCostField,
  buildStripPath,
  cellIndexToWorld,
  groupRuns,
  pickBorderTarget,
  planarizeArterials,
  runDijkstra,
  runsFromGroups,
  splitIntoEdgeVertexLists,
  waterfrontBand,
  worldToCellIndex,
  type ArterialsInput,
  type FamilyRun,
} from "./arterials";
import type { AnchorSet, DerivedFields, Grid } from "./types";
import type { RngStream } from "../rng/types";

/** `arterialsStage` never draws from its stream, so a no-op stub is enough. */
const noopStream: RngStream = {
  next: () => 0,
  nextInt: () => 0,
  fork: () => noopStream,
};

const NONE_ORDINAL = WATER_CLASSES.indexOf("none");
const OCEAN_ORDINAL = WATER_CLASSES.indexOf("ocean");

const isWaterOrdinal = (waterMask: Uint8Array, index: number): boolean =>
  waterMask[index] !== NONE_ORDINAL;

const makeGrid = (cells: number, cellSizeM: number): Grid => ({
  cells,
  sizeM: cells * cellSizeM,
  cellSizeM,
});

const makeDerived = (
  cells: number,
  cellSizeM: number,
  distLandAt: (index: number) => number = () => 0,
  distWaterAt: (index: number) => number = () => 1000
): DerivedFields => ({
  slope: createField2D(cells, cellSizeM),
  distWater: createField2D(cells, cellSizeM, (index) => distWaterAt(index)),
  distLand: createField2D(cells, cellSizeM, (index) => distLandAt(index)),
  localEminence: createField2D(cells, cellSizeM),
  floodRisk: createField2D(cells, cellSizeM),
});

const makeTerrain = (
  cells: number,
  cellSizeM: number,
  isWater: (index: number) => boolean = () => false
): TerrainLayer => ({
  elevation: createField2D(cells, cellSizeM),
  waterMask: Uint8Array.from({ length: cells * cells }, (_value, index) =>
    isWater(index) ? OCEAN_ORDINAL : NONE_ORDINAL
  ),
  waterDepth: createField2D(cells, cellSizeM),
  seaLevelM: 0,
});

const makeAnchors = (cbd: Vec2, casino: Vec2): AnchorSet => ({
  anchors: [],
  cbd,
  megaSeeds: [],
  casino,
  stripAxis: { origin: cbd, dir: { x: 1, y: 0 } },
});

describe("waterfrontBand", () => {
  it.each([
    [230, 1],
    [0, 0],
  ])(
    "should score %i metres from water as %i against the 60-400m band",
    (distWaterM, expected) => {
      expect(waterfrontBand(distWaterM, 60, 400)).toBeCloseTo(expected);
    }
  );
});

describe("buildArterialCostField", () => {
  it("should classify land, near-water, and far-water cells when costing the grid", () => {
    // A hand-built 3-cell row: land, water within bridgeSpanM, water beyond
    // it. `createField2D`/`makeTerrain` assume a square `cells x cells`
    // field, so this fixture builds the flat arrays directly instead.
    const terrain: TerrainLayer = {
      elevation: { cells: 1, cellSizeM: 10, data: new Float32Array(3) },
      waterMask: Uint8Array.from([NONE_ORDINAL, OCEAN_ORDINAL, OCEAN_ORDINAL]),
      waterDepth: { cells: 1, cellSizeM: 10, data: new Float32Array(3) },
      seaLevelM: 0,
    };
    const derived: DerivedFields = {
      slope: { cells: 1, cellSizeM: 10, data: new Float32Array(3) },
      distWater: { cells: 1, cellSizeM: 10, data: new Float32Array(3) },
      distLand: {
        cells: 1,
        cellSizeM: 10,
        data: Float32Array.from([0, 50, 200]),
      },
      localEminence: { cells: 1, cellSizeM: 10, data: new Float32Array(3) },
      floodRisk: { cells: 1, cellSizeM: 10, data: new Float32Array(3) },
    };
    expect(Array.from(buildArterialCostField(terrain, derived))).toEqual([
      1,
      61,
      Number.POSITIVE_INFINITY,
    ]);
  });
});

describe("buildStripCostField", () => {
  it("should discount finite cost by the waterfront band when the cost is finite, passing it through unchanged when it is not", () => {
    const derived = makeDerived(2, 10, undefined, (index) =>
      index === 0 ? 230 : 0
    );
    const baseCost = Float64Array.from([10, Number.POSITIVE_INFINITY]);
    expect(Array.from(buildStripCostField(baseCost, derived))).toEqual([
      4,
      Number.POSITIVE_INFINITY,
    ]);
  });
});

describe("worldToCellIndex", () => {
  it("should clamp to the nearest border cell when the position is out of range", () => {
    const grid = makeGrid(4, 10);
    expect(worldToCellIndex({ x: -50, y: 5000 }, grid)).toBe(12);
  });
});

describe("cellIndexToWorld", () => {
  it("should return the cell-centre world position when converting an index back", () => {
    const grid = makeGrid(4, 10);
    expect(cellIndexToWorld(12, grid)).toEqual({ x: 5, y: 35 });
  });
});

describe("runDijkstra", () => {
  it("should compute the exact diagonal geodesic distance when the grid is flat", () => {
    const grid = makeGrid(2, 10);
    const costField = Float64Array.from([1, 1, 1, 1]);
    const result = runDijkstra(costField, grid, 0);
    expect(result.dist[3]).toBeCloseTo(Math.sqrt(2) * 10);
  });

  it("should still reach the far corner when an obstacle blocks the direct diagonal", () => {
    const grid = makeGrid(3, 10);
    const terrain = makeTerrain(3, 10, (index) => index === 4);
    const derived = makeDerived(3, 10, (index) => (index === 4 ? 999 : 0));
    const costField = buildArterialCostField(terrain, derived);
    const result = runDijkstra(costField, grid, 0);
    expect(Number.isFinite(result.dist[8])).toBe(true);
  });
});

describe("backtrackPath", () => {
  it("should return the source-to-target order when walking from target to source", () => {
    const prev = Int32Array.from([-1, 0, 1]);
    expect(backtrackPath(prev, 0, 2, 10)).toEqual([0, 1, 2]);
  });

  it("should stop early when the predecessor chain breaks before reaching the source", () => {
    const prev = Int32Array.from([-1, -1, 1]);
    expect(backtrackPath(prev, 0, 2, 10)).toEqual([1, 2]);
  });
});

describe("pickBorderTarget", () => {
  it.each([
    ["top", 2],
    ["bottom", 14],
    ["left", 8],
    ["right", 11],
  ] as const)(
    "should pick the %s edge midpoint when every cell is reachable",
    (side, expected) => {
      const dist = new Float64Array(16).fill(0);
      expect(pickBorderTarget(makeGrid(4, 10), side, dist)).toBe(expected);
    }
  );

  it("should return null when every cell on the side is unreachable", () => {
    const dist = new Float64Array(16).fill(Number.POSITIVE_INFINITY);
    expect(pickBorderTarget(makeGrid(4, 10), "top", dist)).toBeNull();
  });

  it("should keep the first-found candidate when two reachable cells tie on distance to the ideal", () => {
    const dist = Float64Array.from([
      10,
      5,
      Number.POSITIVE_INFINITY,
      5,
      ...new Float64Array(12),
    ]);
    expect(pickBorderTarget(makeGrid(4, 10), "top", dist)).toBe(1);
  });
});

describe("buildHighwayPaths", () => {
  it("should drop the target when the whole side is unreachable", () => {
    const grid = makeGrid(4, 10);
    const terrain = makeTerrain(4, 10);
    const derived = makeDerived(4, 10);
    const costField = buildArterialCostField(terrain, derived);
    const dijkstra = runDijkstra(costField, grid, 0);
    const tamperedDist = Float64Array.from(dijkstra.dist);
    [0, 4, 8, 12].forEach((leftColumnIndex) => {
      tamperedDist[leftColumnIndex] = Number.POSITIVE_INFINITY;
    });
    const tampered = { dist: tamperedDist, prev: dijkstra.prev };
    expect(buildHighwayPaths(tampered, grid, 0).length).toBe(3);
  });
});

describe("buildAvenuePaths", () => {
  it("should keep only the valid target when one target is degenerate and another is unreachable", () => {
    const grid = makeGrid(4, 10);
    const terrain = makeTerrain(4, 10);
    const derived = makeDerived(4, 10);
    const costField = buildArterialCostField(terrain, derived);
    const dijkstra = runDijkstra(costField, grid, 0);
    const tamperedDist = Float64Array.from(dijkstra.dist);
    tamperedDist[15] = Number.POSITIVE_INFINITY;
    const tampered = { dist: tamperedDist, prev: dijkstra.prev };
    const targets = [
      cellIndexToWorld(0, grid),
      cellIndexToWorld(5, grid),
      cellIndexToWorld(15, grid),
    ];
    expect(buildAvenuePaths(tampered, grid, 0, targets).length).toBe(1);
  });
});

describe("buildStripPath", () => {
  it("should return null when the two strip endpoints collapse into the same cell", () => {
    const grid = makeGrid(2, 2000);
    const terrain = makeTerrain(2, 2000);
    const derived = makeDerived(2, 2000);
    const costField = buildArterialCostField(terrain, derived);
    const anchors = makeAnchors({ x: 1000, y: 1000 }, { x: 1000, y: 1000 });
    expect(buildStripPath(costField, grid, derived, anchors)).toBeNull();
  });

  it("should return null when the far strip endpoint is excluded water", () => {
    const grid = makeGrid(4, 100);
    const terrain = makeTerrain(4, 100, (index) => index === 7);
    const derived = makeDerived(4, 100, (index) => (index === 7 ? 999 : 0));
    const costField = buildArterialCostField(terrain, derived);
    const anchors = makeAnchors({ x: 150, y: 150 }, { x: 150, y: 150 });
    expect(buildStripPath(costField, grid, derived, anchors)).toBeNull();
  });

  it("should return a path tagged as a strip avenue when both endpoints are reachable", () => {
    const grid = makeGrid(200, 5);
    const terrain = makeTerrain(200, 5);
    const derived = makeDerived(200, 5);
    const costField = buildArterialCostField(terrain, derived);
    const anchors = makeAnchors({ x: 500, y: 500 }, { x: 500, y: 500 });
    const path = buildStripPath(costField, grid, derived, anchors);
    expect(path?.strip).toBe(true);
  });
});

describe("groupRuns", () => {
  it("should start a new group when the flag changes and extend it when the flag repeats", () => {
    expect(groupRuns([false, false, true])).toEqual([
      { flag: false, start: 0, end: 1 },
      { flag: true, start: 2, end: 2 },
    ]);
  });
});

describe("runsFromGroups", () => {
  it("should tag each group as bridge or none when the flag is water or land", () => {
    const grid = makeGrid(5, 10);
    const cellIndices = [0, 1, 2, 3, 4];
    const groups = groupRuns([false, false, true, false, false]);
    const runs = runsFromGroups(groups, cellIndices, grid, 100);
    expect(runs.map((r) => r.crossing)).toEqual(["none", "bridge", "none"]);
  });

  it.each([
    [2, 5],
    [3, 7],
  ])(
    "should keep %i points when the corner deviates by %i metres against a 6m epsilon",
    (expectedPointCount, cellSizeM) => {
      const grid = makeGrid(3, cellSizeM);
      const cellIndices = [0, 4, 2];
      const groups = groupRuns([false, false, false]);
      const runs = runsFromGroups(groups, cellIndices, grid, 6);
      expect(runs[0].points.length).toBe(expectedPointCount);
    }
  );
});

describe("buildAugmentedVertices", () => {
  it("should mark only the first and last vertex as breaks when there are no insertions", () => {
    const run = {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 0 },
      ],
    };
    expect(buildAugmentedVertices(run, []).map((p) => p.isBreak)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("should insert a break point in along-segment order when insertions are present", () => {
    const run = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    };
    const insertions = [{ localSegIndex: 0, point: { x: 5, y: 0 }, t: 5 }];
    expect(buildAugmentedVertices(run, insertions).map((p) => p.pos)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
  });
});

describe("splitIntoEdgeVertexLists", () => {
  it("should produce a single edge when only the two endpoints are breaks", () => {
    const augmented = [
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 1, y: 1 }, isBreak: false },
      { pos: { x: 2, y: 0 }, isBreak: true },
    ];
    expect(splitIntoEdgeVertexLists(augmented).length).toBe(1);
  });

  it("should produce two edges when an interior break point splits the run", () => {
    const augmented = [
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 5, y: 0 }, isBreak: true },
      { pos: { x: 10, y: 0 }, isBreak: true },
    ];
    expect(splitIntoEdgeVertexLists(augmented).length).toBe(2);
  });

  /**
   * Every Dijkstra path leaves the CBD, so every run's own start break sits on
   * top of a crossing insertion with every other run — two break points at one
   * position. Splitting between them once produced a zero-length edge, and
   * `buildRoadGraph` resolved both of its ends to the same node: on `akiba-01`
   * at 512 cells, 169 of the 257 pieces produced had no length. They bound
   * nothing, and they hand `comparePseudoAngle` a zero vector, which leaves the
   * face traversal with no angle to sort them by.
   */
  it("should drop the piece when two break points share a position", () => {
    const augmented = [
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 10, y: 0 }, isBreak: true },
    ];
    expect(splitIntoEdgeVertexLists(augmented).length).toBe(1);
  });

  it("should keep the surviving piece intact when a duplicate break is dropped", () => {
    const augmented = [
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 10, y: 0 }, isBreak: true },
    ];
    expect(splitIntoEdgeVertexLists(augmented)[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it("should drop a piece when its interior points all sit on its endpoints", () => {
    const augmented = [
      { pos: { x: 4, y: 4 }, isBreak: true },
      { pos: { x: 4, y: 4 }, isBreak: false },
      { pos: { x: 4, y: 4 }, isBreak: true },
    ];
    expect(splitIntoEdgeVertexLists(augmented).length).toBe(0);
  });

  it("should keep a piece when it returns to its start but encloses real length", () => {
    const augmented = [
      { pos: { x: 0, y: 0 }, isBreak: true },
      { pos: { x: 50, y: 30 }, isBreak: false },
      { pos: { x: 0, y: 0 }, isBreak: true },
    ];
    expect(splitIntoEdgeVertexLists(augmented).length).toBe(1);
  });
});

/**
 * One straight run along the x axis. Two of these on different path indices are
 * byte-identical routes, which is what gives `dedupeCoincident` something to merge.
 */
const straightRun = (
  cls: RoadClass,
  crossing: Crossing,
  strip: boolean,
  pathIndex: number
): FamilyRun => ({
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
  crossing,
  cls,
  strip,
  pathIndex,
});

describe("planarizeArterials", () => {
  it("should split each polyline into two edges when two polylines cross once", () => {
    const runA: FamilyRun = {
      points: [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
      crossing: "none",
      cls: "avenue",
      strip: false,
      pathIndex: 0,
    };
    const runB: FamilyRun = {
      points: [
        { x: 50, y: 0 },
        { x: 50, y: 100 },
      ],
      crossing: "none",
      cls: "avenue",
      strip: false,
      pathIndex: 1,
    };
    const graph = planarizeArterials([runA, runB]);
    expect({ nodes: graph.nodes.length, edges: graph.edges.length }).toEqual({
      nodes: 5,
      edges: 4,
    });
  });

  it("should split a run at each crossing when a nearby non-crossing candidate pair is also present", () => {
    const horizontalNear: FamilyRun = {
      points: [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
      crossing: "none",
      cls: "avenue",
      strip: false,
      pathIndex: 0,
    };
    // Both verticals stop at y=52 — past the y=50 crossing with
    // `horizontalNear` but short of `parallelNoCrossing`'s y=55, so they
    // cross the former but only ever form a non-intersecting candidate pair
    // with the latter (same spatial-hash bucket, no actual intersection).
    const verticalAt50: FamilyRun = {
      points: [
        { x: 50, y: 0 },
        { x: 50, y: 54 },
      ],
      crossing: "none",
      cls: "avenue",
      strip: false,
      pathIndex: 1,
    };
    const parallelNoCrossing: FamilyRun = {
      points: [
        { x: 0, y: 55 },
        { x: 100, y: 55 },
      ],
      crossing: "none",
      cls: "avenue",
      strip: false,
      pathIndex: 2,
    };
    const verticalAt20: FamilyRun = {
      points: [
        { x: 20, y: 0 },
        { x: 20, y: 54 },
      ],
      crossing: "none",
      cls: "avenue",
      strip: false,
      pathIndex: 3,
    };
    const graph = planarizeArterials([
      horizontalNear,
      verticalAt50,
      parallelNoCrossing,
      verticalAt20,
    ]);
    expect({ nodes: graph.nodes.length, edges: graph.edges.length }).toEqual({
      nodes: 10,
      edges: 8,
    });
  });

  /**
   * The discard path with nobody listening.
   *
   * Every other case here either passes an observer or discards nothing, which left
   * the `observe: DiscardObserver = () => undefined` default assigned but never
   * called — and V8 counts a default argument as covered only once the default value
   * is actually invoked, so three existing calls that omit it were not enough. Two
   * byte-identical runs on different paths give `dedupeCoincident` something to merge,
   * which is what fires `observe` inside the function rather than at its signature.
   */
  it("should still merge a duplicate route when no observer is attached", () => {
    const graph = planarizeArterials([
      straightRun("avenue", "none", false, 0),
      straightRun("avenue", "none", false, 1),
    ]);
    expect({ nodes: graph.nodes.length, edges: graph.edges.length }).toEqual({
      nodes: 2,
      edges: 1,
    });
  });

  /**
   * Which of two coincident routes decides the survivor's class, marking and strip.
   *
   * `dedupeCoincident` keeps the strongest class, any bridge marking and any strip
   * flag, and each of those is a branch that only runs once two routes actually
   * merge — which nothing exercised until the case above. Both orders are here
   * because the class test compares the incoming route against the kept one, so a
   * single order proves only the half of it that happened to win.
   */
  it.each([
    ["the strongest route arrives second", 1],
    ["the strongest route arrived first", 0],
  ] as const)(
    "should keep the strongest class, the bridge and the strip when %s",
    (_label, strongIndex) => {
      // Both orders, so each of the three merge rules is exercised from both
      // sides: the class test compares the arriving route against the kept one,
      // and the bridge test reads only the kept one.
      const strong = straightRun("highway", "bridge", true, strongIndex);
      const weak = straightRun("avenue", "none", false, 1 - strongIndex);
      const graph = planarizeArterials(
        strongIndex === 0 ? [strong, weak] : [weak, strong]
      );
      expect(
        graph.edges.map((e) => ({
          cls: e.cls,
          crossing: e.crossing,
          strip: e.strip,
        }))
      ).toEqual([{ cls: "highway", crossing: "bridge", strip: true }]);
    }
  );

  it("should not insert a split when two touching runs share the same path index", () => {
    const runA: FamilyRun = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      crossing: "none",
      cls: "street",
      strip: false,
      pathIndex: 5,
    };
    const runB: FamilyRun = {
      points: [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      crossing: "none",
      cls: "street",
      strip: false,
      pathIndex: 5,
    };
    const graph = planarizeArterials([runA, runB]);
    expect(graph.edges.length).toBe(2);
  });
});

describe("arterialsStage", () => {
  const flatGrid = makeGrid(24, 20);
  const flatTerrain = makeTerrain(24, 20);
  const flatDerived = makeDerived(24, 20);

  it("should never mark a crossing bridge when the whole map is dry land", () => {
    const anchors: AnchorSet = {
      anchors: [],
      cbd: { x: 240, y: 240 },
      megaSeeds: [
        { x: 40, y: 40 },
        { x: 440, y: 40 },
        { x: 40, y: 440 },
        { x: 440, y: 440 },
      ],
      casino: { x: 240, y: 40 },
      stripAxis: { origin: { x: 240, y: 40 }, dir: { x: 1, y: 0 } },
    };
    const input: ArterialsInput = {
      grid: flatGrid,
      terrain: flatTerrain,
      derived: flatDerived,
      anchors,
    };
    const graph = arterialsStage(input, noopStream);
    expect(graph.edges.every((e) => e.crossing === "none")).toBe(true);
  });

  it("should include a strip-tagged edge when the strip axis endpoints are distinct and reachable", () => {
    const anchors: AnchorSet = {
      anchors: [],
      cbd: { x: 240, y: 240 },
      megaSeeds: [
        { x: 40, y: 40 },
        { x: 440, y: 40 },
        { x: 40, y: 440 },
        { x: 440, y: 440 },
      ],
      casino: { x: 240, y: 400 },
      stripAxis: { origin: { x: 240, y: 400 }, dir: { x: 1, y: 0 } },
    };
    const input: ArterialsInput = {
      grid: flatGrid,
      terrain: flatTerrain,
      derived: flatDerived,
      anchors,
    };
    const graph = arterialsStage(input, noopStream);
    expect(graph.edges.some((e) => e.strip)).toBe(true);
  });

  it("should omit any strip-tagged edge when the strip axis collapses to a single cell", () => {
    const anchors: AnchorSet = {
      anchors: [],
      cbd: { x: 240, y: 240 },
      megaSeeds: [],
      casino: { x: 240, y: 240 },
      stripAxis: { origin: { x: 240, y: 240 }, dir: { x: 1, y: 0 } },
    };
    const input: ArterialsInput = {
      grid: makeGrid(2, 2000),
      terrain: makeTerrain(2, 2000),
      derived: makeDerived(2, 2000),
      anchors,
    };
    const graph = arterialsStage(input, noopStream);
    expect(graph.edges.some((e) => e.strip)).toBe(false);
  });
});

describe("arterial channel feasibility", () => {
  const cells = 16;
  const cellSizeM = 25;

  const channelColumn = (index: number): number => index % cells;
  const channelRow = (index: number): number => Math.floor(index / cells);

  const isChannelWater = (
    index: number,
    startCol: number,
    endCol: number,
    fullHeight: boolean
  ): boolean => {
    if (!fullHeight && channelRow(index) === 0) return false;
    const col = channelColumn(index);
    return col >= startCol && col <= endCol;
  };

  const nearestLandDistanceM = (
    col: number,
    startCol: number,
    endCol: number
  ): number =>
    Math.min(Math.abs(col - (startCol - 1)), Math.abs(col - (endCol + 1))) *
    cellSizeM;

  const buildChannelInput = (
    startCol: number,
    endCol: number,
    fullHeight: boolean
  ) => {
    const grid = makeGrid(cells, cellSizeM);
    const terrain = makeTerrain(cells, cellSizeM, (index) =>
      isChannelWater(index, startCol, endCol, fullHeight)
    );
    const derived = makeDerived(cells, cellSizeM, (index) =>
      isChannelWater(index, startCol, endCol, fullHeight)
        ? nearestLandDistanceM(channelColumn(index), startCol, endCol)
        : 0
    );
    return { grid, terrain, derived };
  };

  it.each([
    [4, 11, true, true],
    [2, 13, false, false],
  ])(
    "should cross water when channel columns %i-%i force it (fullHeight=%s, expected=%s)",
    (startCol, endCol, fullHeight, expectedCrossesWater) => {
      const { grid, terrain, derived } = buildChannelInput(
        startCol,
        endCol,
        fullHeight
      );
      const costField = buildArterialCostField(terrain, derived);
      const sourceIndex = worldToCellIndex({ x: 0, y: 8 * cellSizeM }, grid);
      const targetIndex = worldToCellIndex(
        { x: 15 * cellSizeM, y: 8 * cellSizeM },
        grid
      );
      const dijkstra = runDijkstra(costField, grid, sourceIndex);
      const path = backtrackPath(
        dijkstra.prev,
        sourceIndex,
        targetIndex,
        grid.cells * grid.cells
      );
      const crossesWater = path.some((index) =>
        isWaterOrdinal(terrain.waterMask, index)
      );
      expect(crossesWater).toBe(expectedCrossesWater);
    }
  );
});
