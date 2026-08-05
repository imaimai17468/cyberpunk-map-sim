import type {
  DistrictKind,
  Field2D,
  GradingLayer,
  PolygonPool,
  RoadGraph,
  Vec2,
} from "@/entities/city";
import { GRADING } from "../constants";
import { bilinearSample } from "../field/field2d";
import { cutToGrade } from "./profile";
import { polylinePoints } from "./roadGeometry";
import type { Grid, LotLayer } from "./types";

/**
 * Stage 10 — earthworks (ADR-0028).
 *
 * The city was built on the ground as found: the median street ran at 13.5% to
 * 15.7% against a legal ceiling near 12%, and a building's base sat at the highest
 * point sampled in its lot so its downhill side hung a median 2.2 m to 3.1 m in the
 * air, up to 24 m. This is the stage that levels the ground first.
 *
 * It writes nothing into the elevation field, and that is the decision ADR-0028
 * records rather than an implementation detail. The field is 4 m per cell while a
 * lot is 10 m to 30 m across, and the viewer subsamples it to roughly 16 m before
 * drawing, so a pad rasterised into it is a jagged blob smaller than its own lot and
 * invisible besides. A uniform grid cannot hold the edge of a parcel at any
 * resolution. So the output is the earthwork itself — a level per lot, a profile per
 * road — and the ground is composed from those downstream.
 *
 * Nothing upstream is re-derived either. Slope, water distance and centrality are
 * what chose where the roads and the districts went, and they were right to look at
 * the ground as found; grading is what happens after that decision.
 */

export interface GradingInput {
  readonly grid: Grid;
  readonly elevation: Field2D;
  readonly roads: RoadGraph;
  readonly lotLayer: LotLayer;
  /** District per block id — what decides the earthwork each lot is worth. */
  readonly districtOf: ReadonlyMap<number, DistrictKind>;
}

const sampleAt = (field: Field2D, grid: Grid, p: Vec2): number =>
  bilinearSample(field, p.x / grid.cellSizeM, p.y / grid.cellSizeM);

const ringOf = (pool: PolygonPool, index: number): readonly Vec2[] => {
  const start = pool.starts[index];
  const end = pool.starts[index + 1];
  return Array.from({ length: end - start }, (_value, i) => ({
    x: pool.coords[(start + i) * 2],
    y: pool.coords[(start + i) * 2 + 1],
  }));
};

/**
 * The level a lot is cut and filled to, or null when the budget cannot reach it.
 *
 * The mean of the ring's own corners is the balanced-earthwork answer: it is the
 * level that moves the least material, which is the one a developer pays least for.
 * Corners rather than interior samples, because the interior misses exactly the
 * extremes the budget has to cover — `buildings.ts` used to read a ring shrunk to
 * half size for its relief veto and so under-read the slopes it existed to catch.
 *
 * The budget then decides whether the lot can be graded at all, and it is a
 * question about the interval rather than about the mean. Every corner must end up
 * within `maxCutM` below its natural height and `maxFillM` above it, so any level in
 * `[highest - maxCutM, lowest + maxFillM]` will do — and that interval is non-empty
 * exactly when the lot's relief is at most `maxCutM + maxFillM`. Testing the mean
 * against both budgets instead, as the first version did, refused a lot whenever its
 * balanced level happened to fall outside them even though a workable level existed
 * a metre away: it graded 20.8% to 28.8% of lots where this grades 35.9% to 47.0%.
 *
 * So the balanced level is the preference and the interval is the constraint: take
 * the mean, then slide it to the nearest end of the interval if it falls outside.
 *
 * The interval is `maxCutM + maxFillM` wide, so a lot is levellable exactly when its
 * relief fits inside its district's budget — and that single fact is the whole
 * buildability test downstream. `buildings.ts` vetoes on `padded` rather than on a
 * relief threshold of its own, so there is no second constant to drift.
 *
 * The budget is the district's because a tower and a shack do not command the same
 * earthwork. `GRADING.budget` carries the reasoning and the measurement that forced
 * it.
 */
const padLevel = (
  corners: readonly number[],
  maxCutM: number,
  maxFillM: number
): number | null => {
  const highest = corners.reduce((m, z) => Math.max(m, z), corners[0]);
  const lowest = corners.reduce((m, z) => Math.min(m, z), corners[0]);
  const floor = highest - maxCutM;
  const ceiling = lowest + maxFillM;
  if (floor > ceiling) return null;
  const balanced = corners.reduce((sum, z) => sum + z, 0) / corners.length;
  return Math.min(ceiling, Math.max(floor, balanced));
};

/**
 * One height per road polyline vertex: the class gradient limit, then the budget.
 *
 * `cutToGrade` is free to spend an unbounded excavation to meet its cap, and left
 * unbounded it does — the version of this stage that ADR-0028 replaced dug 80 m
 * trenches on hillsides. The budget is handed to it as a floor so it can plan around
 * it, rather than applied to its answer afterwards; `profile.ts` records what the
 * post-hoc version cost.
 *
 * The budget makes the cap a target, and it is worth being plain about how much of a
 * target, because "median at the cap" is a flattering way to say "half of it is
 * over". Four metres of cutting cannot flatten this terrain. Measured at
 * `GOLDEN_PARAMS` over the three golden seeds — nearest-cell elevation, runs under a
 * micrometre skipped — the share of road segments steeper than their own class
 * allows goes from 51.3%, 58.9% and 54.9% on natural ground to 40.9%, 46.3% and
 * 43.1% after grading. The worst segments do not move at all: the sharpest is two
 * stations 5.5 m apart on what is effectively a cliff, where both are cut the full
 * four metres and the step between them is the terrain's own, so it stands at 92.3%,
 * 116.1% and 108.5%. Grading improves the distribution and does not deliver
 * compliance; nothing that cuts a bounded depth per station could.
 *
 * Fill is not offered to roads. A road may only be cut into the ground, so it can
 * never be left standing on an embankment the model does not draw, and a junction
 * between two edges cut from the same natural ground can disagree by at most the
 * cut budget.
 */
const roadProfile = (
  points: readonly Vec2[],
  natural: readonly number[],
  maxGrade: number
): readonly number[] => {
  const spacing = points.slice(0, -1).map((a, i) => {
    const dx = points[i + 1].x - a.x;
    const dy = points[i + 1].y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  });
  return cutToGrade(
    natural,
    spacing,
    maxGrade,
    natural.map((z) => z - GRADING.roadCutM)
  );
};

/**
 * Stage 10: the levels the city is built to.
 *
 * Deterministic and RNG-free — every height is a function of the natural field, the
 * road graph and the lot rings — so this stage never draws from `stream`.
 */
export const gradingStage = (input: GradingInput): GradingLayer => {
  const { elevation, grid, lotLayer, roads } = input;

  const levels = lotLayer.lots.map((lot) => {
    const ring = ringOf(lotLayer.polygons, lot.ringIndex);
    if (ring.length < 3) return null;
    const district = input.districtOf.get(lot.blockId);
    if (district === undefined) return null;
    const budget = GRADING.budget[district];
    return padLevel(
      ring.map((p) => sampleAt(elevation, grid, p)),
      budget.maxCutM,
      budget.maxFillM
    );
  });

  const roadZ = new Float32Array(roads.polylines.coords.length / 2);
  roads.edges.forEach((edge) => {
    const points = polylinePoints(roads, edge.polylineIndex);
    if (points.length < 2) return;
    const start = roads.polylines.starts[edge.polylineIndex];
    const profile = roadProfile(
      points,
      points.map((p) => sampleAt(elevation, grid, p)),
      GRADING.maxGrade[edge.cls]
    );
    profile.forEach((z, i) => {
      roadZ[start + i] = z;
    });
  });

  return {
    padZ: Float32Array.from(levels, (level) => level ?? 0),
    padded: Uint8Array.from(levels, (level) => (level === null ? 0 : 1)),
    roadZ,
  };
};
