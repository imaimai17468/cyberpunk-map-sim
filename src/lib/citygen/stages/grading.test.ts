import type { DistrictKind, PolygonPool, RoadGraph } from "@/entities/city";
import { describe, expect, it } from "vitest";
import { createField2D } from "../field/field2d";
import { gradingStage } from "./grading";
import type { Grid, LotLayer } from "./types";

/**
 * The three guards no generated city reaches.
 *
 * `gradingStage` is a pure total function, so AGENTS.md wants every branch covered,
 * and the golden seeds cannot supply these: `lots.ts` never emits a ring with fewer
 * than three corners, both road sources emit at least two points per polyline, and
 * `pipeline.ts` builds the district map from the very blocks the lots belong to. They
 * are guarded anyway because the stage's inputs are plain pooled arrays and a plain
 * `Map` with no shape the type system enforces, and because the failure without them
 * is never an empty pad — it is a `NaN` height written into the model, or a
 * `TypeError` from reading `.maxCutM` off an absent budget.
 *
 * The stage returns a safe total in all three rather than throwing, which is where it
 * differs from `buildings.ts`'s `requireDistrict` on the same missing-block-id case.
 * That is deliberate: this stage is the one that decides whether a lot can be built
 * on at all, and a lot it cannot classify is a lot it cannot level.
 */

const GRID: Grid = { cells: 8, cellSizeM: 10, sizeM: 80 };

const flatElevation = () => createField2D(GRID.cells, GRID.cellSizeM, () => 5);

const poolOf = (rings: readonly (readonly number[])[]): PolygonPool => {
  const starts = rings.reduce<number[]>(
    (acc, ring) => {
      acc.push(acc[acc.length - 1] + ring.length / 2);
      return acc;
    },
    [0]
  );
  return {
    coords: Float32Array.from(rings.flat()),
    starts: Uint32Array.from(starts),
  };
};

/** Every block is suburb, the middling budget: 4 m of cut, 2 m of fill. */
const SUBURB = new Map<number, DistrictKind>([[0, "suburb"]]);

const EMPTY_ROADS: RoadGraph = {
  nodes: [],
  edges: [],
  polylines: { coords: new Float32Array(0), starts: Uint32Array.from([0]) },
};

const lotLayerOf = (polygons: PolygonPool, count: number): LotLayer => ({
  lots: Array.from({ length: count }, (_value, i) => ({
    id: i,
    blockId: 0,
    ringIndex: i,
    frontage: "street" as const,
    frontageDir: null,
  })),
  polygons,
  // Unread here: this stage takes the road graph as its own declared input.
  roads: EMPTY_ROADS,
});

describe("gradingStage", () => {
  it("should grade a lot when its ring is a real polygon", () => {
    const layer = lotLayerOf(poolOf([[10, 10, 30, 10, 30, 30, 10, 30]]), 1);
    const result = gradingStage({
      grid: GRID,
      elevation: flatElevation(),
      roads: EMPTY_ROADS,
      lotLayer: layer,
      districtOf: SUBURB,
    });
    // Flat ground, so the pad is that ground and the budget is untouched.
    expect([result.padded[0], result.padZ[0]]).toEqual([1, 5]);
  });

  it("should offer no pad when a lot ring has fewer than three corners", () => {
    const layer = lotLayerOf(poolOf([[10, 10, 30, 10]]), 1);
    const result = gradingStage({
      grid: GRID,
      elevation: flatElevation(),
      roads: EMPTY_ROADS,
      lotLayer: layer,
      districtOf: SUBURB,
    });
    expect([result.padded[0], result.padZ[0]]).toEqual([0, 0]);
  });

  it("should offer no pad when the lot's block has no district", () => {
    const layer = lotLayerOf(poolOf([[10, 10, 30, 10, 30, 30, 10, 30]]), 1);
    const result = gradingStage({
      grid: GRID,
      elevation: flatElevation(),
      roads: EMPTY_ROADS,
      lotLayer: layer,
      // Keyed to a block the lot does not belong to, so the lookup misses.
      districtOf: new Map([[99, "suburb"]]),
    });
    expect([result.padded[0], result.padZ[0]]).toEqual([0, 0]);
  });

  it("should leave the profile alone when a road polyline has fewer than two points", () => {
    const roads: RoadGraph = {
      nodes: [],
      edges: [
        {
          id: 0,
          a: -1,
          b: -1,
          cls: "street",
          crossing: "none",
          polylineIndex: 0,
          strip: false,
        },
      ],
      // One vertex, so `polylinePoints` hands back nothing to profile.
      polylines: {
        coords: Float32Array.from([10, 10]),
        starts: Uint32Array.from([0, 1]),
      },
    };
    const result = gradingStage({
      grid: GRID,
      elevation: flatElevation(),
      roads,
      lotLayer: lotLayerOf(poolOf([]), 0),
      districtOf: SUBURB,
    });
    expect([...result.roadZ]).toEqual([0]);
  });
});
