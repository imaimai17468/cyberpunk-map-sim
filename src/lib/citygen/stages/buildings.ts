import type {
  Block,
  Building,
  BuildingArchetype,
  BuildingTier,
  DistrictKind,
  Field2D,
  Obb,
  PolygonPool,
  RoadGraph,
  TerrainLayer,
  Vec2,
} from "@/entities/city";
import { BUILDINGS, ROAD_WIDTH_M } from "../constants";
import { bilinearSample } from "../field/field2d";
import { minimumAreaObb } from "../geometry/hull";
import { containsPoint } from "../geometry/polygon";
import { centroid, samplePolygonInteriorPoints } from "../geometry/polygon";
import { segmentIntersection } from "../geometry/intersect";
import {
  add,
  dot,
  length,
  lengthSq,
  normalize,
  perp,
  randomUnitVector,
  scale,
  sub,
} from "../geometry/vec";
import type { RngStream } from "../rng/types";
import { polylineSegments } from "./roadGeometry";
import type { BuildingLayer, Grid, LotLayer, PipelineContext } from "./types";

/**
 * Stage 10 — the district -> archetype decision table and per-archetype
 * massing (design doc §3 stage 10, §6). Terrain acts twice: zoning already
 * picked the district (upstream), and this stage reads the same field stack
 * again to shape the actual building — corporate height goes as
 * `centrality^2`, luxury setback grows with `prestige`, and slum shacks jitter
 * with `decay` and terrace with local relief — so a slum on a slope and a
 * slum in a floodplain come out visibly different from the same code path.
 */

/** Input the shared contracts file does not declare: this stage's own shape. */
export interface BuildingsInput {
  readonly context: PipelineContext;
  readonly blocks: readonly Block[];
  readonly lotLayer: LotLayer;
  readonly roads: RoadGraph;
}

const ringFromPool = (
  pool: PolygonPool,
  ringIndex: number
): readonly Vec2[] => {
  const start = pool.starts[ringIndex];
  const end = pool.starts[ringIndex + 1];
  return Array.from({ length: end - start }, (_value, i) => ({
    x: pool.coords[(start + i) * 2],
    y: pool.coords[(start + i) * 2 + 1],
  }));
};

const NEAR_ZERO = 1e-9;

/** The widest half-carriageway, used to bound the corridor search radius. */
const MAX_ROAD_HALF_WIDTH_M = Math.max(...Object.values(ROAD_WIDTH_M)) / 2;

/** The four corners of an OBB, in ring order. */
const obbCorners = (o: Obb): readonly Vec2[] => {
  const along = scale(o.facing, o.w / 2);
  const across = scale(perp(o.facing), o.d / 2);
  return [
    add(add({ x: o.cx, y: o.cy }, along), across),
    add(sub({ x: o.cx, y: o.cy }, along), across),
    sub(sub({ x: o.cx, y: o.cy }, along), across),
    sub(add({ x: o.cx, y: o.cy }, along), across),
  ];
};

/**
 * The tightest box around `points` whose long axis is `axis`.
 *
 * Unlike `minimumAreaObb` the angle is given rather than searched for, which is
 * what lets a building square up to the street it fronts instead of to whatever
 * angle its lot's subdivision happened to leave behind.
 */
export const obbAlignedTo = (points: readonly Vec2[], axis: Vec2): Obb => {
  const across = perp(axis);
  const us = points.map((p) => dot(p, axis));
  const vs = points.map((p) => dot(p, across));
  const uMid = (Math.min(...us) + Math.max(...us)) / 2;
  const vMid = (Math.min(...vs) + Math.max(...vs)) / 2;
  const centre = add(scale(axis, uMid), scale(across, vMid));
  return {
    cx: centre.x,
    cy: centre.y,
    facing: axis,
    w: Math.max(...us) - Math.min(...us),
    d: Math.max(...vs) - Math.min(...vs),
  };
};

/** True when every corner and every edge of `obb` lies within `ring`. */
const obbWithin = (obb: Obb, ring: readonly Vec2[]): boolean => {
  const corners = obbCorners(obb);
  if (!corners.every((c) => containsPoint(ring, c))) return false;
  // Corners alone would pass a box that bridges a concave notch, so the edges
  // are checked against the ring's as well.
  const n = ring.length;
  return corners.every((c, i) => {
    const next = corners[(i + 1) % corners.length];
    return ring.every((p, j) => {
      const q = ring[(j + 1) % n];
      return segmentIntersection(c, next, p, q).kind === "none";
    });
  });
};

/** Shrinks `obb` about its own centre by `factor`, keeping its angle. */
const scaleObb = (obb: Obb, factor: number): Obb => ({
  ...obb,
  w: obb.w * factor,
  d: obb.d * factor,
});

/** Squared distance from `p` to segment `a..b`. */
const distanceSqToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  const t =
    lenSq < NEAR_ZERO
      ? 0
      : Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
  return lengthSq(sub(p, add(a, scale(ab, t))));
};

/** A road centreline segment with the clearance its class demands. */
interface RoadCorridor {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly halfWidthSq: number;
}

/** Squared distance between two segments. Zero when they cross. */
const segmentDistanceSq = (a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number =>
  segmentIntersection(a1, a2, b1, b2).kind === "none"
    ? Math.min(
        distanceSqToSegment(a1, b1, b2),
        distanceSqToSegment(a2, b1, b2),
        distanceSqToSegment(b1, a1, a2),
        distanceSqToSegment(b2, a1, a2)
      )
    : 0;

/**
 * True when `obb` keeps every corridor's full clearance.
 *
 * The block inset already keeps a building off the roads that bound its own
 * block, but not off one that merely passes nearby: an arterial that dead-ends
 * inside a face is never a boundary of it, so no inset is taken for it and the
 * lots run straight over the road.
 *
 * Measuring the corners alone is not enough, and the way it fails is not
 * marginal. A corridor running lengthwise through the middle of a footprint,
 * parallel to one of its own axes, is at its *furthest* from all four corners —
 * an alley down the centre of a 59 m box leaves every corner ~29 m away, so a
 * corner test passes on the first try and the shrink is never even entered
 * while the road runs through the building end to end. So the box is compared
 * to the corridor as two segments, and the endpoints are checked for
 * containment as well, because a corridor lying wholly inside the footprint
 * crosses none of its edges.
 */
const clearOfRoads = (
  obb: Obb,
  corridors: readonly RoadCorridor[]
): boolean => {
  const corners = obbCorners(obb);
  const centre = { x: obb.cx, y: obb.cy };
  // Nothing outside this radius can touch the box, whatever its angle.
  const halfDiagonal = length({ x: obb.w, y: obb.d }) / 2;
  return corridors.every((r) => {
    // One point-to-segment distance rejects most corridors in the bucket
    // before the twenty-odd segment operations below. Without it a 4 km map
    // spends nine seconds here, over the per-test budget.
    const reach = halfDiagonal + Math.sqrt(r.halfWidthSq);
    if (distanceSqToSegment(centre, r.a, r.b) > reach * reach) return true;
    if (containsPoint(corners, r.a) || containsPoint(corners, r.b))
      return false;
    return corners.every((c, i) => {
      const next = corners[(i + 1) % corners.length];
      return segmentDistanceSq(c, next, r.a, r.b) >= r.halfWidthSq;
    });
  });
};

/** Side of one corridor-index bucket, in metres. */
const CORRIDOR_CELL_M = 64;

interface CorridorIndex {
  readonly buckets: ReadonlyMap<string, readonly RoadCorridor[]>;
}

const bucketKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * Road corridors bucketed on a fixed grid.
 *
 * Once the subdivision cuts became streets the graph went from a couple of
 * hundred arterials to several thousand edges, and testing every footprint
 * against every one of them made a single generation take longer than the whole
 * test suite used to. Each corridor is filed under every cell its extent
 * touches, so a lookup reads a handful of cells instead of the whole network.
 */
const buildCorridorIndex = (roads: RoadGraph): CorridorIndex => {
  const buckets = new Map<string, RoadCorridor[]>();
  roads.edges.forEach((edge) => {
    const halfWidth = ROAD_WIDTH_M[edge.cls] / 2;
    polylineSegments(roads, edge.polylineIndex).forEach(([a, b]) => {
      const corridor = { a, b, halfWidthSq: halfWidth * halfWidth };
      const x0 = Math.floor((Math.min(a.x, b.x) - halfWidth) / CORRIDOR_CELL_M);
      const x1 = Math.floor((Math.max(a.x, b.x) + halfWidth) / CORRIDOR_CELL_M);
      const y0 = Math.floor((Math.min(a.y, b.y) - halfWidth) / CORRIDOR_CELL_M);
      const y1 = Math.floor((Math.max(a.y, b.y) + halfWidth) / CORRIDOR_CELL_M);
      Array.from({ length: x1 - x0 + 1 }).forEach((_unusedX, i) =>
        Array.from({ length: y1 - y0 + 1 }).forEach((_unusedY, j) => {
          const key = bucketKey(x0 + i, y0 + j);
          const existing = buckets.get(key);
          if (existing === undefined) buckets.set(key, [corridor]);
          else existing.push(corridor);
        })
      );
    });
  });
  return { buckets };
};

/**
 * Corridors that could come within `reach` of `centre`.
 *
 * A superset, not an exact answer: everything filed in the covered cells is
 * returned, and the caller's own distance test rejects the rest. The result may
 * repeat a corridor filed under two cells, which costs a duplicated comparison
 * and changes no outcome.
 */
const lookupCorridors = (
  index: CorridorIndex,
  centre: Vec2,
  reach: number
): readonly RoadCorridor[] => {
  const x0 = Math.floor((centre.x - reach) / CORRIDOR_CELL_M);
  const x1 = Math.floor((centre.x + reach) / CORRIDOR_CELL_M);
  const y0 = Math.floor((centre.y - reach) / CORRIDOR_CELL_M);
  const y1 = Math.floor((centre.y + reach) / CORRIDOR_CELL_M);
  return Array.from({ length: x1 - x0 + 1 }).flatMap((_unusedX, i) =>
    Array.from({ length: y1 - y0 + 1 }).flatMap(
      (_unusedY, j) => index.buckets.get(bucketKey(x0 + i, y0 + j)) ?? []
    )
  );
};

/** Whether a fitted footprint still has enough area to be worth building. */
const hasBuildableFootprint = (entry: {
  readonly massing: { readonly footprint: Obb };
}): boolean =>
  entry.massing.footprint.w * entry.massing.footprint.d >=
  BUILDINGS.minFootprintM2;

const FIT_STEPS = 10;

/**
 * The largest concentric shrink of `obb` that fits inside `ring`.
 *
 * A lot's box is a *bounding* box, so on any lot that is not a rectangle it
 * sticks out past the plot — and since lots tile their block, what it sticks
 * out into is the neighbour. Thousands of pairs of buildings on different lots
 * interpenetrated before this, corporate towers among them. Keeping each
 * footprint inside its own lot is what makes that impossible rather than
 * unlikely, because the lots themselves do not overlap.
 *
 * Bisection rather than an exact inscribed-rectangle solve: ten steps land
 * within a thousandth of the largest fitting scale, and the common case (a
 * rectangular lot, already inside) exits on the first test.
 *
 * Every candidate shares the original box's centre, so if that centre is not
 * itself valid then no scale is, and the search correctly bottoms out at zero.
 * That is what makes returning the untested `lo = 0` safe rather than lucky —
 * and the caller has to notice it, because a lot that collapses this way is a
 * lot with no building on it.
 */
const fitWithin = (
  obb: Obb,
  ring: readonly Vec2[],
  corridors: readonly RoadCorridor[]
): Obb => {
  const fits = (candidate: Obb): boolean =>
    obbWithin(candidate, ring) && clearOfRoads(candidate, corridors);
  if (fits(obb)) return obb;
  const search = (lo: number, hi: number, steps: number): number => {
    if (steps === 0) return lo;
    const mid = (lo + hi) / 2;
    return fits(scaleObb(obb, mid))
      ? search(mid, hi, steps - 1)
      : search(lo, mid, steps - 1);
  };
  return scaleObb(obb, search(0, 1, FIT_STEPS));
};

const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  if (lenSq < NEAR_ZERO) return length(sub(p, a));
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
  const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return length(sub(p, closest));
};

interface NearestStrip {
  readonly distance: number;
  readonly direction: Vec2;
}

const nearestStripSegment = (
  point: Vec2,
  segments: readonly (readonly [Vec2, Vec2])[]
): NearestStrip | null =>
  segments.length === 0
    ? null
    : segments.reduce<NearestStrip>(
        (best, [a, b]) => {
          const d = distanceToSegment(point, a, b);
          return d < best.distance
            ? { distance: d, direction: normalize(sub(b, a), { x: 1, y: 0 }) }
            : best;
        },
        { distance: Number.POSITIVE_INFINITY, direction: { x: 1, y: 0 } }
      );

const sampleAt = (field: Field2D, grid: Grid, point: Vec2): number =>
  bilinearSample(field, point.x / grid.cellSizeM, point.y / grid.cellSizeM);

const RELIEF_SAMPLE_SATELLITES = 4;

/**
 * Interior samples for the water veto. The same value as the relief count
 * today, but its own knob: sharpening the slope veto has no reason to also
 * change how finely the shoreline is probed.
 */
const WATER_SAMPLE_SATELLITES = 4;

const requireDistrict = (
  map: ReadonlyMap<number, DistrictKind>,
  blockId: number
): DistrictKind => {
  const district = map.get(blockId);
  if (district === undefined) {
    throw new Error(`buildings: unknown block id ${blockId}`);
  }
  return district;
};

/** A district's chosen archetype is fixed (design doc §6) — never itself random. */
export const DISTRICT_ARCHETYPE: Readonly<
  Record<DistrictKind, BuildingArchetype>
> = {
  corporate: "corpoTower",
  megablock: "megabuilding",
  casino: "casino",
  luxury: "luxuryResidence",
  suburb: "detachedHouse",
  slum: "slumShack",
};

export interface MassingContext {
  readonly lotObb: Obb;
  readonly centrality: number;
  readonly prestige: number;
  readonly decay: number;
  readonly minElevation: number;
  readonly maxElevation: number;
  readonly relief: number;
  readonly stripDistance: number;
  readonly stripDirection: Vec2 | null;
  readonly stream: RngStream;
}

export interface MassingResult {
  readonly footprint: Obb;
  readonly heightM: number;
  readonly baseZM: number;
  readonly tiers: readonly BuildingTier[];
}

const insetObb = (obb: Obb, insetM: number): Obb => ({
  ...obb,
  w: Math.max(0, obb.w - 2 * insetM),
  d: Math.max(0, obb.d - 2 * insetM),
});

const coverageObb = (obb: Obb, coverage: number): Obb => {
  const factor = Math.sqrt(Math.max(0, coverage));
  return { ...obb, w: obb.w * factor, d: obb.d * factor };
};

const SINGLE_TIER: readonly BuildingTier[] = [{ heightFrac: 1, insetFrac: 0 }];

export const corpoMassing = (ctx: MassingContext): MassingResult => {
  const footprint = insetObb(ctx.lotObb, BUILDINGS.corpo.insetM);
  const u = ctx.stream.next();
  const centralitySquared = ctx.centrality * ctx.centrality;
  const raw =
    (BUILDINGS.corpo.baseM +
      BUILDINGS.corpo.centralityGainM * centralitySquared) *
    (BUILDINGS.corpo.jitterLo + BUILDINGS.corpo.jitterSpan * u);
  const spiked =
    u > BUILDINGS.corpo.spikeThreshold
      ? raw *
        (BUILDINGS.corpo.spikeBase +
          (BUILDINGS.corpo.spikeGain * (u - BUILDINGS.corpo.spikeThreshold)) /
            (1 - BUILDINGS.corpo.spikeThreshold))
      : raw;
  const heightM = Math.min(
    BUILDINGS.corpo.maxM,
    Math.max(BUILDINGS.corpo.minM, spiked)
  );
  return { footprint, heightM, baseZM: ctx.maxElevation, tiers: SINGLE_TIER };
};

/**
 * A fixed (non-random) per-tier profile derived purely from `tierCount`:
 * equal height fractions, insets growing linearly toward the top tier —
 * `constants.ts` does not carry a literal numeric table, so this is the
 * "fixed {heightFrac, insetFrac} profile table" the design calls for,
 * expressed as a pure function of tier count rather than a static array.
 */
const megabuildingTierProfile = (tierCount: number): readonly BuildingTier[] =>
  Array.from({ length: tierCount }, (_value, i) => ({
    heightFrac: 1 / tierCount,
    insetFrac: i / tierCount,
  }));

export const megabuildingMassing = (ctx: MassingContext): MassingResult => {
  const footprint = insetObb(ctx.lotObb, BUILDINGS.megabuilding.insetM);
  const u = ctx.stream.next();
  const u2 = ctx.stream.next();
  const heightM =
    BUILDINGS.megabuilding.baseM + BUILDINGS.megabuilding.spanM * u;
  const tierCount =
    BUILDINGS.megabuilding.minTiers +
    Math.floor(BUILDINGS.megabuilding.maxExtraTiers * u2);
  return {
    footprint,
    heightM,
    baseZM: ctx.maxElevation,
    tiers: megabuildingTierProfile(tierCount),
  };
};

export const casinoMassing = (ctx: MassingContext): MassingResult => {
  const coverage = coverageObb(ctx.lotObb, BUILDINGS.casino.coverage);
  const footprint =
    ctx.stripDirection !== null &&
    ctx.stripDistance <= BUILDINGS.casino.facingSnapM
      ? { ...coverage, facing: perp(ctx.stripDirection) }
      : coverage;
  const u = ctx.stream.next();
  const heightM = BUILDINGS.casino.baseM + BUILDINGS.casino.spanM * u;
  return { footprint, heightM, baseZM: ctx.maxElevation, tiers: SINGLE_TIER };
};

/**
 * Design doc §6 requires luxury setbacks to grow with `prestige`, but
 * `constants.ts`'s `BUILDINGS.luxury` carries no coupling constant for it —
 * a genuinely new tuning number, called out in the implementation report.
 * At `prestige = 1` coverage is halved relative to the base 0.25.
 */
const LUXURY_PRESTIGE_SETBACK_SCALE = 0.5;

export const luxuryMassing = (ctx: MassingContext): MassingResult => {
  const effectiveCoverage = Math.max(
    0,
    BUILDINGS.luxury.coverage *
      (1 - LUXURY_PRESTIGE_SETBACK_SCALE * ctx.prestige)
  );
  const footprint = coverageObb(ctx.lotObb, effectiveCoverage);
  const u = ctx.stream.next();
  const heightM = BUILDINGS.luxury.baseM + BUILDINGS.luxury.spanM * u;
  return { footprint, heightM, baseZM: ctx.maxElevation, tiers: SINGLE_TIER };
};

/**
 * The lot's own directional data ends at the coarse `Frontage` enum (design
 * doc §4 has no per-edge street-normal on `Lot`), so "the frontage-side
 * third" is approximated here as flush against one edge of the OBB's long
 * axis rather than a literal street-facing offset — documented in the
 * implementation report.
 */
export const suburbMassing = (ctx: MassingContext): MassingResult => {
  const coverage = coverageObb(ctx.lotObb, BUILDINGS.suburb.coverage);
  const shift = -(ctx.lotObb.w - coverage.w) / 2;
  const footprint: Obb = {
    ...coverage,
    cx: coverage.cx + ctx.lotObb.facing.x * shift,
    cy: coverage.cy + ctx.lotObb.facing.y * shift,
  };
  const u = ctx.stream.next();
  const heightM = BUILDINGS.suburb.baseM + BUILDINGS.suburb.spanM * u;
  return { footprint, heightM, baseZM: ctx.maxElevation, tiers: SINGLE_TIER };
};

/**
 * How far a shack's footprint jitters off-centre, as a fraction of its own
 * footprint's smaller dimension at `decay = 1`. Not in `constants.ts` —
 * see the implementation report.
 */
const SLUM_JITTER_FRACTION = 0.35;

/** The secondary lean-to box's coverage, relative to the primary shack's. Not in `constants.ts`. */
const SLUM_SECOND_BOX_COVERAGE_FRACTION = 0.4;

export const slumFloorHeight = (u: number): number =>
  BUILDINGS.shackTerraceStepM * (1 + Math.floor(BUILDINGS.slum.maxFloors * u));

/**
 * Shacks are immune to the relief veto: instead of a plaza, the base
 * terraces up-slope in fixed `shackTerraceStepM` increments, quantised so it
 * never exceeds the footprint's own highest sampled point.
 */
export const slumBaseZ = (ctx: MassingContext): number => {
  const steps = Math.floor(ctx.relief / BUILDINGS.shackTerraceStepM);
  return ctx.minElevation + steps * BUILDINGS.shackTerraceStepM;
};

const jitteredObb = (
  obb: Obb,
  decay: number,
  jitterDraw: number,
  flipBit: boolean
): Obb => {
  const magnitude = SLUM_JITTER_FRACTION * decay * Math.min(obb.w, obb.d);
  const dir = randomUnitVector(jitterDraw, flipBit);
  return {
    ...obb,
    cx: obb.cx + dir.x * magnitude,
    cy: obb.cy + dir.y * magnitude,
  };
};

const slumBox = (
  lotObb: Obb,
  coverage: number,
  decay: number,
  stream: RngStream
): Obb =>
  jitteredObb(
    coverageObb(lotObb, coverage),
    decay,
    stream.next(),
    stream.nextInt(2) === 1
  );

export const slumMassing = (ctx: MassingContext): readonly MassingResult[] => {
  const primary = slumBox(
    ctx.lotObb,
    BUILDINGS.slum.coverage,
    ctx.decay,
    ctx.stream
  );
  const heightM = slumFloorHeight(ctx.stream.next());
  const baseZM = slumBaseZ(ctx);
  const primaryResult: MassingResult = {
    footprint: primary,
    heightM,
    baseZM,
    tiers: SINGLE_TIER,
  };
  const secondDraw = ctx.stream.next();
  if (secondDraw >= BUILDINGS.slum.secondBoxChance) return [primaryResult];
  const secondary = slumBox(
    ctx.lotObb,
    BUILDINGS.slum.coverage * SLUM_SECOND_BOX_COVERAGE_FRACTION,
    ctx.decay,
    ctx.stream
  );
  const secondaryResult: MassingResult = {
    footprint: secondary,
    heightM: slumFloorHeight(ctx.stream.next()),
    baseZM,
    tiers: SINGLE_TIER,
  };
  return [primaryResult, secondaryResult];
};

/** Universal gate: no tower may exceed 9x its own smallest plan dimension. */
export const applySlenderness = (result: MassingResult): MassingResult => ({
  ...result,
  heightM: Math.min(
    result.heightM,
    BUILDINGS.maxSlenderness * Math.min(result.footprint.w, result.footprint.d)
  ),
});

const MASSING_BY_ARCHETYPE: Readonly<
  Record<BuildingArchetype, (ctx: MassingContext) => readonly MassingResult[]>
> = {
  corpoTower: (ctx) => [applySlenderness(corpoMassing(ctx))],
  megabuilding: (ctx) => [applySlenderness(megabuildingMassing(ctx))],
  casino: (ctx) => [applySlenderness(casinoMassing(ctx))],
  luxuryResidence: (ctx) => [applySlenderness(luxuryMassing(ctx))],
  detachedHouse: (ctx) => [applySlenderness(suburbMassing(ctx))],
  slumShack: (ctx) => slumMassing(ctx).map(applySlenderness),
};

interface PlazaResult {
  readonly kind: "plaza";
  readonly lotId: number;
}

interface BuildingsResult {
  readonly kind: "buildings";
  readonly lotId: number;
  readonly blockId: number;
  readonly archetype: BuildingArchetype;
  readonly massing: readonly MassingResult[];
}

type LotResult = PlazaResult | BuildingsResult;

const isPlazaResult = (result: LotResult): result is PlazaResult =>
  result.kind === "plaza";

const isBuildingsResult = (result: LotResult): result is BuildingsResult =>
  result.kind === "buildings";

/** Nearest-cell water class at a world point. 0 is dry. */
const waterAt = (terrain: TerrainLayer, grid: Grid, p: Vec2): number => {
  const cells = terrain.elevation.cells;
  const cx = Math.min(cells - 1, Math.max(0, Math.floor(p.x / grid.cellSizeM)));
  const cy = Math.min(cells - 1, Math.max(0, Math.floor(p.y / grid.cellSizeM)));
  return terrain.waterMask[cy * cells + cx];
};

/**
 * Whether any part of the lot is under water.
 *
 * The block-level test upstream is a majority vote over five interior samples,
 * so a block that is forty percent sea counts as land — correctly, because the
 * dry sixty percent is real city. What it cannot do is stop the lots cut from
 * that block running out past the shoreline, and nothing downstream looked at
 * water at all: hundreds of buildings per seed stood in the sea, and every one
 * of them was a slum, because slums are the archetype the design puts on the
 * floodplain. `scripts/measure-water-occupancy.ts` prints the count and its
 * archetype breakdown; stash this change to see the figures before the fix.
 *
 * Sampled rather than clipped. Clipping the lot to the coast is the better
 * answer and a much larger change — the shoreline is a raster boundary, not a
 * polygon — so this vetoes the whole lot instead, which errs toward a slightly
 * thinner waterfront rather than buildings standing offshore. The corners are
 * included because a footprint reaches them and the interior samples do not.
 */
const touchesWater = (
  ring: readonly Vec2[],
  terrain: TerrainLayer,
  grid: Grid
): boolean =>
  [
    ...ring,
    // Edge midpoints are not decoration: `samplePolygonInteriorPoints` walks
    // centroid-to-vertex rays and never lands on an edge, so a long lot
    // bulging into the sea halfway along one side reads as dry at every other
    // sample. Every building left standing in water after the first pass was
    // exactly that shape.
    ...ring.map((p, i) => {
      const next = ring[(i + 1) % ring.length];
      return { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
    }),
    ...samplePolygonInteriorPoints(ring, WATER_SAMPLE_SATELLITES),
  ].some((p) => waterAt(terrain, grid, p) !== 0);

/**
 * Stage 10: for every lot, vetoes to a plaza on a too-small footprint or
 * (for every archetype except `slumShack`) excessive relief under the
 * footprint; otherwise dispatches to the district's fixed archetype and
 * massing function. `plazaLotIds` names every vetoed lot — never a hole.
 */
export const buildingsStage = (
  input: BuildingsInput,
  stream: RngStream
): BuildingLayer => {
  const { context, blocks, lotLayer, roads } = input;
  const { fields, terrain, grid } = context;
  const districtOf = new Map(
    blocks.map((block) => [block.id, block.district] as const)
  );
  const stripSegments = roads.edges
    .filter((edge) => edge.strip)
    .flatMap((edge) => polylineSegments(roads, edge.polylineIndex));

  const results: readonly LotResult[] = lotLayer.lots.map((lot) => {
    const ring = ringFromPool(lotLayer.polygons, lot.ringIndex);
    // Square to the street where the lot fronts one. `minimumAreaObb` takes
    // whatever angle the subdivision happened to leave, which is *usually*
    // near the street because both the block and the lot were cut along their
    // own boxes — but not for a slum, whose cut directions are deliberately
    // jittered, and not for a lot whose ring came out concave.
    const lotObb =
      lot.frontageDir === null
        ? minimumAreaObb(ring)
        : obbAlignedTo(ring, lot.frontageDir);
    if (lotObb.w * lotObb.d < BUILDINGS.minFootprintM2) {
      return { kind: "plaza", lotId: lot.id };
    }
    if (touchesWater(ring, terrain, grid)) {
      return { kind: "plaza", lotId: lot.id };
    }
    const district = requireDistrict(districtOf, lot.blockId);
    const archetype = DISTRICT_ARCHETYPE[district];
    const samplePoints = samplePolygonInteriorPoints(
      ring,
      RELIEF_SAMPLE_SATELLITES
    );
    const elevations = samplePoints.map((p) =>
      sampleAt(terrain.elevation, grid, p)
    );
    const minElevation = elevations.reduce((a, b) => Math.min(a, b));
    const maxElevation = elevations.reduce((a, b) => Math.max(a, b));
    const relief = maxElevation - minElevation;
    if (relief > BUILDINGS.reliefVetoM && archetype !== "slumShack") {
      return { kind: "plaza", lotId: lot.id };
    }
    const center = centroid(ring);
    const nearestStrip = nearestStripSegment(center, stripSegments);
    const ctx: MassingContext = {
      lotObb,
      centrality: sampleAt(fields.centrality, grid, center),
      prestige: sampleAt(fields.prestige, grid, center),
      decay: sampleAt(fields.decay, grid, center),
      minElevation,
      maxElevation,
      relief,
      stripDistance: nearestStrip?.distance ?? Number.POSITIVE_INFINITY,
      stripDirection: nearestStrip?.direction ?? null,
      stream: stream.fork("bld", lot.blockId, lot.id),
    };
    return {
      kind: "buildings",
      lotId: lot.id,
      blockId: lot.blockId,
      archetype,
      massing: MASSING_BY_ARCHETYPE[archetype](ctx),
    };
  });

  const plazaLotIds = results
    .filter(isPlazaResult)
    .map((result) => result.lotId);
  // Every footprint is confined to its own lot here rather than inside each
  // archetype's massing. The massing rules are about proportion — coverage,
  // setback, tiering — and each would otherwise have to re-derive containment
  // for itself; doing it once at the boundary means no archetype can forget.
  // Lots tile their block without overlapping, so this is also what makes two
  // buildings on different lots unable to intersect. Two on the *same* lot
  // still can, which is how a slum shack keeps its lean-to.
  const lotRingOf = (lotId: number): readonly Vec2[] =>
    ringFromPool(lotLayer.polygons, lotLayer.lots[lotId].ringIndex);

  const corridorIndex = buildCorridorIndex(roads);
  const corridorsNear = (
    centre: Vec2,
    reach: number
  ): readonly RoadCorridor[] => lookupCorridors(corridorIndex, centre, reach);
  const flatBuildings = results.filter(isBuildingsResult).flatMap((result) =>
    result.massing.map((massing) => ({
      archetype: result.archetype,
      lotId: result.lotId,
      blockId: result.blockId,
      massing: {
        ...massing,
        footprint: fitWithin(
          massing.footprint,
          lotRingOf(result.lotId),
          // Reach covers the footprint's own half-diagonal plus the widest
          // carriageway, so no corridor that could touch it is filtered out.
          corridorsNear(
            { x: massing.footprint.cx, y: massing.footprint.cy },
            length({ x: massing.footprint.w, y: massing.footprint.d }) / 2 +
              MAX_ROAD_HALF_WIDTH_M
          )
        ),
      },
    }))
  );
  // A footprint whose own centre lies in a carriageway, or outside its own
  // ring, cannot be shrunk into a valid position at any scale — every smaller
  // box shares that centre — so the fit collapses it to nothing. Dropping the
  // zero-sized box is right, but dropping it *silently* was not: the lot then
  // appeared in neither `buildings` nor `plazaLotIds`, and this stage's own
  // contract is that `plazaLotIds` names every vetoed lot and never leaves a
  // hole. A concave lot large enough to build on hit exactly that.
  const builtBuildings = flatBuildings.filter(hasBuildableFootprint);
  const builtLotIds = new Set(builtBuildings.map((entry) => entry.lotId));
  const collapsedLotIds = [
    ...new Set(
      flatBuildings
        .filter((entry) => !builtLotIds.has(entry.lotId))
        .map((entry) => entry.lotId)
    ),
  ];
  const buildings: readonly Building[] = builtBuildings.map((entry, i) => ({
    id: i,
    archetype: entry.archetype,
    obb: entry.massing.footprint,
    heightM: entry.massing.heightM,
    baseZM: entry.massing.baseZM,
    tiers: entry.massing.tiers,
    lotId: entry.lotId,
    blockId: entry.blockId,
  }));

  return {
    buildings,
    plazaLotIds: [...plazaLotIds, ...collapsedLotIds],
  };
};
