import { describe, expect, it } from "vitest";
import type { Field2D, TerrainLayer, Vec2 } from "@/entities/city";
import { WATER_CLASSES } from "@/entities/city";
import { SOCIAL } from "../constants";
import { createField2D, fieldAt } from "../field/field2d";
import type { RngStream } from "../rng/types";
import { social } from "./social";
import type { AnchorSet, DerivedFields, Grid } from "./types";

/**
 * Stage 5 is fully deterministic and never calls its stream (see the module
 * doc); this stub only exists to satisfy the fixed `Stage` call signature.
 */
const unusedStream: RngStream = {
  next: () => 0,
  nextInt: () => 0,
  fork: () => unusedStream,
};

const CELL_SIZE_M = 10;

const gridOfCells = (cells: number): Grid => ({
  cells,
  sizeM: cells * CELL_SIZE_M,
  cellSizeM: CELL_SIZE_M,
});

const uniformField = (cells: number, value: number): Field2D =>
  createField2D(cells, CELL_SIZE_M, () => value);

const overriddenField = (
  cells: number,
  base: number,
  overrides: ReadonlyMap<number, number>
): Field2D =>
  createField2D(cells, CELL_SIZE_M, (index) => overrides.get(index) ?? base);

const flatTerrain = (
  cells: number,
  waterIndices: ReadonlySet<number> = new Set()
): TerrainLayer => {
  const OCEAN_ORDINAL = WATER_CLASSES.indexOf("ocean");
  const NONE_ORDINAL = WATER_CLASSES.indexOf("none");
  return {
    elevation: uniformField(cells, 0),
    waterMask: Uint8Array.from({ length: cells * cells }, (_value, index) =>
      waterIndices.has(index) ? OCEAN_ORDINAL : NONE_ORDINAL
    ),
    waterDepth: uniformField(cells, 0),
    seaLevelM: 0,
  };
};

const flatDerived = (cells: number): DerivedFields => ({
  slope: uniformField(cells, 0),
  distWater: uniformField(cells, 0),
  distLand: uniformField(cells, 0),
  localEminence: uniformField(cells, 0),
  floodRisk: uniformField(cells, 0),
});

const dummyAnchors = (
  cells: number,
  cbd: Vec2,
  megaSeeds: readonly Vec2[] = []
): AnchorSet => ({
  anchors: [],
  cbd,
  megaSeeds,
  casino: cbd,
  stripAxis: { origin: cbd, dir: { x: 1, y: 0 } },
});

const cellCenter = (cx: number, cy: number): Vec2 => ({
  x: (cx + 0.5) * CELL_SIZE_M,
  y: (cy + 0.5) * CELL_SIZE_M,
});

// ---------------------------------------------------------------------------
// Centrality: the geodesic Dijkstra over the cost surface.
// ---------------------------------------------------------------------------

describe("social: geodesic centrality", () => {
  it("should score a cell less central when a water channel blocks the geodesic path to it", () => {
    const cells = 9;
    const grid = gridOfCells(cells);
    const cbd = cellCenter(4, 4);
    // A near-full water column at x=6 (rows 0..7) separates the CBD from a
    // target directly to its right; the only crossing is the row-8 gap, so
    // the geodesic path detours the long way around rather than the 40 m
    // Euclidean straight line. A target directly below the CBD, at the same
    // Euclidean distance, has no such obstruction.
    const waterIndices = new Set(
      Array.from({ length: 8 }, (_value, y) => y * cells + 6)
    );
    const terrain = flatTerrain(cells, waterIndices);
    const derived = flatDerived(cells);
    const anchors = dummyAnchors(cells, cbd);
    const result = social({ grid, terrain, derived, anchors }, unusedStream);
    const acrossWaterCentrality = fieldAt(result.centrality, 8, 4);
    const clearCentrality = fieldAt(result.centrality, 4, 8);
    expect(acrossWaterCentrality < clearCentrality).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shadow: Euclidean falloff around every mega seed.
// ---------------------------------------------------------------------------

describe("social: shadow field", () => {
  it("should reach the maximum shadow value when sampled exactly at a mega seed's own cell", () => {
    const cells = 100;
    const grid = gridOfCells(cells);
    const seed = cellCenter(0, 0);
    const terrain = flatTerrain(cells);
    const derived = flatDerived(cells);
    const anchors = dummyAnchors(cells, cellCenter(40, 40), [seed]);
    const result = social({ grid, terrain, derived, anchors }, unusedStream);
    expect(fieldAt(result.shadow, 0, 0)).toBe(1);
  });

  it("should fade shadow to zero when a cell is beyond the shadow radius from every mega seed", () => {
    const cells = 100;
    const grid = gridOfCells(cells);
    const seed = cellCenter(0, 0);
    const terrain = flatTerrain(cells);
    const derived = flatDerived(cells);
    const anchors = dummyAnchors(cells, cellCenter(40, 40), [seed]);
    const result = social({ grid, terrain, derived, anchors }, unusedStream);
    // (29, 29) is 290*sqrt(2) ≈ 410 m from the seed at (5, 5) — past the 260 m radius.
    expect(fieldAt(result.shadow, 29, 29)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Strip: adjacency to the constructed shore corridor.
// ---------------------------------------------------------------------------

describe("social: strip field", () => {
  const cells = 100;
  const grid = gridOfCells(cells);
  const origin = cellCenter(40, 40);
  const anchors: AnchorSet = {
    ...dummyAnchors(cells, cellCenter(0, 0)),
    stripAxis: { origin, dir: { x: 1, y: 0 } },
  };
  const terrain = flatTerrain(cells);
  const derived = flatDerived(cells);

  it("should score the strip field at full weight when a cell sits directly on the corridor axis", () => {
    const result = social({ grid, terrain, derived, anchors }, unusedStream);
    // (45, 40): 50 m along the axis, zero lateral offset.
    expect(fieldAt(result.strip, 45, 40)).toBe(1);
  });

  it("should score the strip field at zero when a cell is off the corridor's lateral width", () => {
    const result = social({ grid, terrain, derived, anchors }, unusedStream);
    // (40, 70): zero along the axis, 300 m lateral offset (past the 60 m width).
    expect(fieldAt(result.strip, 40, 70)).toBe(0);
  });

  it("should score the strip field at zero when a cell is past the corridor's longitudinal taper", () => {
    const result = social({ grid, terrain, derived, anchors }, unusedStream);
    // (92, 40): 520 m along the axis, past the 450 + 60 m taper.
    expect(fieldAt(result.strip, 92, 40)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prestige and decay: exact-value regression against the design's weights.
// ---------------------------------------------------------------------------

describe("social: prestige and decay weighting", () => {
  const cells = 5;
  const grid = gridOfCells(cells);
  const cbd = cellCenter(0, 0);
  const testIndex = 4 * cells + 4;
  const terrain = flatTerrain(cells);
  // slope = 0.35 (the steepness upper threshold exactly), floodRisk = 0.6,
  // both at the single test cell (4, 4); localEminence/distWater stay at
  // the flat baseline (0), so eminence and water-band contribute nothing.
  const derived: DerivedFields = {
    ...flatDerived(cells),
    slope: overriddenField(cells, 0, new Map([[testIndex, 0.35]])),
    floodRisk: overriddenField(cells, 0, new Map([[testIndex, 0.6]])),
  };
  const anchors = dummyAnchors(cells, cbd);
  const result = social({ grid, terrain, derived, anchors }, unusedStream);

  it("should clamp prestige to zero when flood risk outweighs every positive term", () => {
    // prestige = clamp01(0.4*0 + 0.25*0 + 0.2*(1 - 1) - 0.35*0.6 - 0.3*0) = clamp01(-0.21) = 0.
    expect(fieldAt(result.prestige, 4, 4)).toBe(0);
  });

  it("should combine remoteness, flood risk, and steepness when computing decay at a test cell", () => {
    // Manhattan geodesic distance from CBD (0,0) to (4,4) is 7 flat steps at
    // cost 1 (edge cost 1*10 m) plus the final step into (4,4), whose own
    // slope (0.35, the field's only nonzero value) normalizes to slopeN=1
    // and so costs avg(1, 1+8*1)*10 = 50 m: total 7*10 + 50 = 120 m.
    //
    // The expectation is derived from SOCIAL rather than hard-coded: this test
    // asserts the decay *formula*, and a literal made it fail whenever the
    // centrality half-distance was retuned — a tuning change, not a regression
    // in what this test is about.
    const geodesicM = 120;
    const ratio = geodesicM / SOCIAL.centralityHalfDistanceM;
    const centrality = 1 / (1 + ratio * ratio);
    const expected =
      SOCIAL.decay.remoteness * (1 - centrality) +
      SOCIAL.decay.flood * 0.6 +
      SOCIAL.decay.steepness * 1;
    expect(fieldAt(result.decay, 4, 4)).toBeCloseTo(expected, 4);
  });
});
