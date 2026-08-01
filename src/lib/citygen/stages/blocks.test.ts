import { describe, expect, it } from "vitest";
import type { Field2D, RoadGraph, TerrainLayer, Vec2 } from "@/entities/city";
import { BLOCKS } from "../constants";
import { streamFromSeedWord } from "../rng/xoshiro";
import { blockAreaTargetAt, blocksStage, cutDirectionAt } from "./blocks";
import type { DerivedFields, Grid, SocialFields } from "./types";

/**
 * Stage 7 tests.
 *
 * The boundary-arity assertion below exists because of a real defect: an
 * earlier version returned a flat list of cut ids rather than one entry per
 * ring edge, and `lots.ts` indexes `boundary[i]` by edge. Nothing caught it
 * until the whole pipeline ran, so it is pinned here.
 */

const GRID: Grid = { cells: 16, sizeM: 512, cellSizeM: 32 };

const uniform = (value: number): Field2D => ({
  cells: GRID.cells,
  cellSizeM: GRID.cellSizeM,
  data: new Float32Array(GRID.cells * GRID.cells).fill(value),
});

/** A field that ramps along +x, giving a gradient of a known direction. */
const rampX = (scale: number): Field2D => ({
  cells: GRID.cells,
  cellSizeM: GRID.cellSizeM,
  data: Float32Array.from(
    { length: GRID.cells * GRID.cells },
    (_unused, i) => (i % GRID.cells) * scale
  ),
});

const terrainOf = (elevation: Field2D, water = 0): TerrainLayer => ({
  elevation,
  waterMask: new Uint8Array(GRID.cells * GRID.cells).fill(water),
  waterDepth: uniform(0),
  seaLevelM: 0,
});

/**
 * Terrain with a coastline: `wet(cx, cy)` decides each cell.
 *
 * `terrainOf` can only fill uniformly, which leaves the interesting case
 * unreachable — a map that is all dry never exercises the water filter, and one
 * that is all wet rejects every cut on block membership before the endpoint
 * test is ever consulted.
 */
const terrainWithCoast = (
  wet: (cx: number, cy: number) => boolean
): TerrainLayer => ({
  elevation: uniform(10),
  waterMask: Uint8Array.from({ length: GRID.cells * GRID.cells }, (_v, i) =>
    wet(i % GRID.cells, Math.floor(i / GRID.cells)) ? 1 : 0
  ),
  waterDepth: uniform(0),
  seaLevelM: 0,
});

const derivedOf = (overrides: Partial<DerivedFields> = {}): DerivedFields => ({
  slope: uniform(0),
  distWater: uniform(1000),
  distLand: uniform(0),
  localEminence: uniform(0),
  floodRisk: uniform(0),
  ...overrides,
});

const socialOf = (overrides: Partial<SocialFields> = {}): SocialFields => ({
  centrality: uniform(0),
  shadow: uniform(0),
  strip: uniform(0),
  prestige: uniform(0),
  decay: uniform(0),
  ...overrides,
});

/** Empty road graph: the map border alone becomes the single region. */
const emptyRoads: RoadGraph = {
  nodes: [],
  edges: [],
  polylines: { coords: new Float32Array(0), starts: Uint32Array.from([0]) },
};

const inputOf = (
  overrides: Partial<Parameters<typeof blocksStage>[0]> = {}
): Parameters<typeof blocksStage>[0] => ({
  grid: GRID,
  terrain: terrainOf(uniform(10)),
  derived: derivedOf(),
  social: socialOf(),
  roads: emptyRoads,
  ...overrides,
});

const SQUARE: readonly Vec2[] = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 100 },
  { x: 0, y: 100 },
];

describe("blockAreaTargetAt", () => {
  it("should return the largest target when urban intensity is zero", () => {
    expect(blockAreaTargetAt({ x: 100, y: 100 }, socialOf())).toBeCloseTo(
      BLOCKS.maxBlockAreaM2,
      6
    );
  });

  it("should return the smallest target when urban intensity saturates", () => {
    const dense = socialOf({
      centrality: uniform(1),
      prestige: uniform(1),
      decay: uniform(1),
    });
    expect(blockAreaTargetAt({ x: 100, y: 100 }, dense)).toBeCloseTo(
      BLOCKS.minBlockAreaM2,
      6
    );
  });

  it("should fall between the bounds when intensity is partial", () => {
    const mid = socialOf({ centrality: uniform(0.5) });
    const target = blockAreaTargetAt({ x: 100, y: 100 }, mid);
    expect(
      target < BLOCKS.maxBlockAreaM2 && target > BLOCKS.minBlockAreaM2
    ).toBe(true);
  });
});

describe("cutDirectionAt", () => {
  /**
   * With every influence at zero the blended tensor is degenerate, and the
   * design requires an explicit fallback rather than an arbitrary direction.
   * The square is 400x100, so its long axis is +x and the fallback cut runs
   * perpendicular to it.
   */
  it("should cut perpendicular to the long axis when the tensor is degenerate", () => {
    const dir = cutDirectionAt(
      SQUARE,
      inputOf(),
      { x: 1, y: 0 },
      streamFromSeedWord(1),
      0
    );
    expect(Math.abs(dir.x)).toBeCloseTo(0, 6);
  });

  it("should return a unit vector when the tensor is degenerate", () => {
    const dir = cutDirectionAt(
      SQUARE,
      inputOf(),
      { x: 1, y: 0 },
      streamFromSeedWord(1),
      0
    );
    expect(Math.sqrt(dir.x * dir.x + dir.y * dir.y)).toBeCloseTo(1, 6);
  });

  it("should return a finite direction when the shore gradient dominates", () => {
    const dir = cutDirectionAt(
      SQUARE,
      inputOf({ derived: derivedOf({ distWater: rampX(4) }) }),
      { x: 1, y: 0 },
      streamFromSeedWord(2),
      0
    );
    expect(Number.isFinite(dir.x) && Number.isFinite(dir.y)).toBe(true);
  });

  it("should still return a unit vector when the slum tangle jitter applies", () => {
    const dir = cutDirectionAt(
      SQUARE,
      inputOf({ derived: derivedOf({ distWater: rampX(4) }) }),
      { x: 1, y: 0 },
      streamFromSeedWord(3),
      BLOCKS.slumTangleDecay + 0.2
    );
    expect(Math.sqrt(dir.x * dir.x + dir.y * dir.y)).toBeCloseTo(1, 6);
  });
});

describe("blocksStage", () => {
  const layer = blocksStage(inputOf(), streamFromSeedWord(7));

  it("should subdivide the border region when no arterials exist", () => {
    expect(layer.blocks.length).toBeGreaterThan(1);
  });

  it("should emit one polygon ring per block when subdividing", () => {
    expect(layer.polygons.starts.length).toBe(layer.blocks.length + 1);
  });

  /** The defect that only surfaced end-to-end: boundary is per ring edge. */
  it("should emit one boundary entry per ring edge when building blocks", () => {
    const mismatched = layer.blocks.filter((block) => {
      const start = layer.polygons.starts[block.ringIndex];
      const end = layer.polygons.starts[block.ringIndex + 1];
      return block.boundary.length !== end - start;
    });
    expect(mismatched).toEqual([]);
  });

  it("should keep adjacency symmetric when neighbours share a cut", () => {
    const asymmetric = layer.blocks.filter((block) =>
      block.neighbourIds.some(
        (other) => !layer.blocks[other].neighbourIds.includes(block.id)
      )
    );
    expect(asymmetric).toEqual([]);
  });

  it("should never list a block as its own neighbour when computing adjacency", () => {
    expect(layer.blocks.filter((b) => b.neighbourIds.includes(b.id))).toEqual(
      []
    );
  });

  it("should mark blocks dry when the water mask is empty", () => {
    expect(layer.blocks.every((b) => !b.water)).toBe(true);
  });

  it("should mark blocks wet when the whole map is water", () => {
    const wet = blocksStage(
      inputOf({ terrain: terrainOf(uniform(10), 1) }),
      streamFromSeedWord(7)
    );
    expect(wet.blocks.every((b) => b.water)).toBe(true);
  });

  it("should produce identical block counts when run twice with one seed", () => {
    expect(blocksStage(inputOf(), streamFromSeedWord(7)).blocks.length).toBe(
      layer.blocks.length
    );
  });

  it("should stop subdividing when blocks reach the target area", () => {
    const dense = blocksStage(
      inputOf({ social: socialOf({ centrality: uniform(1) }) }),
      streamFromSeedWord(7)
    );
    expect(dense.blocks.length).toBeGreaterThan(layer.blocks.length);
  });

  it("should keep every arterial edge when subdividing", () => {
    expect(layer.roads.edges.slice(0, emptyRoads.edges.length)).toEqual(
      emptyRoads.edges
    );
  });

  it("should emit street edges when the subdivision makes cuts", () => {
    expect(
      layer.roads.edges.filter((edge) => edge.cls === "street").length
    ).toBeGreaterThan(0);
  });

  /**
   * The cut between two blocks belongs to both of their rings, so without
   * deduplication every interior street would be emitted twice and the map
   * would draw each one over itself.
   */
  it("should emit a cut once when two blocks share it", () => {
    const streets = layer.roads.edges.filter((edge) => edge.cls === "street");
    const keys = streets.map((edge) => {
      const start = layer.roads.polylines.starts[edge.polylineIndex];
      const end = layer.roads.polylines.starts[edge.polylineIndex + 1];
      const at = (i: number): string =>
        `${layer.roads.polylines.coords[i * 2].toFixed(2)},${layer.roads.polylines.coords[i * 2 + 1].toFixed(2)}`;
      return [at(start), at(end - 1)].toSorted().join("|");
    });

    expect(new Set(keys).size).toBe(streets.length);
  });

  /**
   * Subdivision runs over water faces too, so without a filter the open sea is
   * carved into blocks and every cut published as a street. An all-water map is
   * the sharpest form of the case: not one street should come out of it.
   */
  it("should emit no street edges when the whole map is water", () => {
    const wet = blocksStage(
      inputOf({ terrain: terrainOf(uniform(10), 1) }),
      streamFromSeedWord(7)
    );
    expect(wet.roads.edges.filter((e) => e.cls === "street")).toEqual([]);
  });

  it("should address a two-point polyline when emitting a street edge", () => {
    const { starts } = layer.roads.polylines;
    expect(
      layer.roads.edges
        .filter((edge) => edge.cls === "street")
        .every(
          (edge) =>
            edge.polylineIndex + 1 < starts.length &&
            starts[edge.polylineIndex + 1] - starts[edge.polylineIndex] === 2
        )
    ).toBe(true);
  });
});

/**
 * The coastline cases. Neither uniform fixture reaches them: an all-dry map has
 * no water to test against, and an all-wet one rejects every cut on block
 * membership before the endpoint check runs.
 */
describe("blocksStage along a coastline", () => {
  // West half sea, east half land, so cuts fall on both sides and across.
  const coastal = blocksStage(
    inputOf({ terrain: terrainWithCoast((cx) => cx < GRID.cells / 2) }),
    streamFromSeedWord(7)
  );

  /** The same west-half rule the fixture was built from, in world metres. */
  const isWet = (p: Vec2): boolean =>
    Math.min(GRID.cells - 1, Math.max(0, Math.floor(p.x / GRID.cellSizeM))) <
    GRID.cells / 2;

  const streetEnds = (): readonly (readonly [Vec2, Vec2])[] =>
    coastal.roads.edges
      .filter((edge) => edge.cls === "street")
      .map((edge) => {
        const { starts, coords } = coastal.roads.polylines;
        const s = starts[edge.polylineIndex];
        const e = starts[edge.polylineIndex + 1];
        return [
          { x: coords[s * 2], y: coords[s * 2 + 1] },
          { x: coords[(e - 1) * 2], y: coords[(e - 1) * 2 + 1] },
        ] as const;
      });

  it("should drop a street when both of its ends are in water", () => {
    expect(streetEnds().filter(([a, b]) => isWet(a) && isWet(b))).toEqual([]);
  });

  it("should keep the shoreline crossing when only one end is in water", () => {
    expect(streetEnds().some(([a, b]) => isWet(a) !== isWet(b))).toBe(true);
  });

  /**
   * The boundary is what `lots.ts` prices as carriageway and treats as
   * frontage, so a `cut` ref left behind for a street the filter dropped would
   * have the lot layer inset for a road that is not in the graph.
   */
  it("should retag a cut boundary when its street was dropped", () => {
    const streetKeys = new Set(
      streetEnds().map(([a, b]) =>
        [
          `${a.x.toFixed(2)},${a.y.toFixed(2)}`,
          `${b.x.toFixed(2)},${b.y.toFixed(2)}`,
        ]
          .toSorted()
          .join("|")
      )
    );
    const orphaned = coastal.blocks.filter((block) => {
      const s = coastal.polygons.starts[block.ringIndex];
      const e = coastal.polygons.starts[block.ringIndex + 1];
      const ring = Array.from({ length: e - s }, (_v, i) => ({
        x: coastal.polygons.coords[(s + i) * 2],
        y: coastal.polygons.coords[(s + i) * 2 + 1],
      }));
      return block.boundary.some((ref, i) => {
        if (ref.kind !== "cut") return false;
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const key = [
          `${a.x.toFixed(2)},${a.y.toFixed(2)}`,
          `${b.x.toFixed(2)},${b.y.toFixed(2)}`,
        ]
          .toSorted()
          .join("|");
        return !streetKeys.has(key);
      });
    });
    expect(orphaned).toEqual([]);
  });
});
