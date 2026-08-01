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

  it("should pass the arterial graph through unchanged when subdividing", () => {
    expect(layer.roads).toBe(emptyRoads);
  });
});
