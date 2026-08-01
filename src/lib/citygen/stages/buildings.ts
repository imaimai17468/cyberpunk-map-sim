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
  Vec2,
} from "@/entities/city";
import { BUILDINGS } from "../constants";
import { bilinearSample } from "../field/field2d";
import { minimumAreaObb } from "../geometry/hull";
import { centroid, samplePolygonInteriorPoints } from "../geometry/polygon";
import {
  dot,
  length,
  lengthSq,
  normalize,
  perp,
  randomUnitVector,
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
    const lotObb = minimumAreaObb(ring);
    if (lotObb.w * lotObb.d < BUILDINGS.minFootprintM2) {
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
  const flatBuildings = results.filter(isBuildingsResult).flatMap((result) =>
    result.massing.map((massing) => ({
      archetype: result.archetype,
      lotId: result.lotId,
      blockId: result.blockId,
      massing,
    }))
  );
  const buildings: readonly Building[] = flatBuildings.map((entry, i) => ({
    id: i,
    archetype: entry.archetype,
    obb: entry.massing.footprint,
    heightM: entry.massing.heightM,
    baseZM: entry.massing.baseZM,
    tiers: entry.massing.tiers,
    lotId: entry.lotId,
    blockId: entry.blockId,
  }));

  return { buildings, plazaLotIds };
};
