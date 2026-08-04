import {
  DISTRICT_KINDS,
  type Block,
  type DistrictKind,
  type Field2D,
  type FieldStack,
  type PolygonPool,
  type RoadGraph,
  type Vec2,
} from "@/entities/city";
import { ANCHORS, ZONING } from "../constants";
import { bilinearSample } from "../field/field2d";
import {
  area as polygonArea,
  containsPoint,
  centroid as ringCentroid,
  samplePolygonInteriorPoints,
} from "../geometry/polygon";
import { dot, length, lengthSq, sub } from "../geometry/vec";
import type { RngStream } from "../rng/types";
import { polylineSegments } from "./roadGeometry";
import type { BlockLayer, Grid, PipelineContext } from "./types";

/**
 * Stage 8 — per-block argmax zoning, mode filter, and the megalot rim pass
 * (design doc §3 stage 8, §6). Deterministic and RNG-free: every decision is
 * an argmax over sampled fields, so the stage's `RngStream` parameter is
 * accepted only to satisfy the shared `Stage` contract and is never read.
 */

/** Input the shared contracts file does not declare: this stage's own shape. */
export interface ZoningInput {
  readonly context: PipelineContext;
  readonly blockLayer: BlockLayer;
}

/**
 * The five districts zoning can actually *win* via argmax, in the fixed
 * evaluation order that resolves exact ties (design doc §3 stage 8: "fixed
 * evaluation order for exact-tie break"). `megablock` is never an argmax
 * outcome — it is forced (mega-seed blocks) or promoted (the megalot rim
 * pass), both handled outside this list.
 */
const ZONEABLE_DISTRICTS = [
  "corporate",
  "casino",
  "luxury",
  "suburb",
  "slum",
] as const;

/**
 * A forced/promoted block's margin is pinned above `modeFilterMaxMargin` so
 * the mode filter's "own margin < threshold" guard never lets it be
 * overwritten, while remaining a plain finite number for the retained
 * `scoreMargin` tuning field.
 */
const FORCED_DISTRICT_MARGIN = 1;

/**
 * Design doc §6 scores casino affinity partly on adjacency to the
 * constructed shore strip avenue, but no constant in `constants.ts` names the
 * catchment width of that adjacency (the strip's own geometry constants
 * describe its along-shore length, not a cross-strip falloff distance). This
 * is a genuinely new tuning number the shared constants file does not carry;
 * ~2 block-widths is a reasonable catchment for "adjacent to the strip" and
 * is called out in the implementation report as a design choice.
 */
const STRIP_ADJACENCY_BAND_M = 200;

const NEAR_ZERO = 1e-9;

/** Classic polynomial smoothstep: 0 below `edge0`, 1 above `edge1`, eased between. */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const span = edge1 - edge0;
  const t = Math.min(1, Math.max(0, (x - edge0) / span));
  return t * t * (3 - 2 * t);
};

/**
 * A plateau over `[near, far]`: rises from 0 to 1 across `[0, near]`, holds
 * at 1 across `[near, far]`, falls back to 0 across a symmetric falloff band
 * `[far, far + (far - near)]`. Used for "near water but not too near" style
 * affinities (design doc §6's `band(distWater, 60-400)`).
 */
export const band = (value: number, near: number, far: number): number =>
  smoothstep(0, near, value) * (1 - smoothstep(far, far + (far - near), value));

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

const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  if (lenSq < NEAR_ZERO) return length(sub(p, a));
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
  const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return length(sub(p, closest));
};

const distanceToNearestStripSegment = (
  point: Vec2,
  roads: RoadGraph
): number => {
  const segments = roads.edges
    .filter((edge) => edge.strip)
    .flatMap((edge) => polylineSegments(roads, edge.polylineIndex));
  return segments.reduce(
    (min, [a, b]) => Math.min(min, distanceToSegment(point, a, b)),
    Number.POSITIVE_INFINITY
  );
};

const stripAdjacencyAt = (point: Vec2, roads: RoadGraph): number =>
  1 -
  smoothstep(
    0,
    STRIP_ADJACENCY_BAND_M,
    distanceToNearestStripSegment(point, roads)
  );

/** The field values zoning's affinity formulas need, sampled per block. */
// similarity-ignore: mirrors the shape of zoning.test.ts's FieldValues fixture because both name the same scalar field inputs; they are deliberately separate so a change to this stage output cannot silently rewrite what the fixtures claim to set up.
interface BlockFieldSample {
  readonly centrality: number;
  readonly prestige: number;
  readonly decay: number;
  readonly distWater: number;
  readonly shadow: number;
  readonly floodRisk: number;
  readonly slope: number;
  readonly localEminence: number;
}

const SAMPLE_SATELLITE_COUNT = 4;

/**
 * `localEminence` is in metres and `slope` is an unbounded rise/run ratio,
 * while every affinity weight in design §6 is written against the normalised
 * `eminenceN` / `slopeN`. Comparing a raw metre value against a [0,1] field
 * makes one affinity dominate the argmax outright — that is exactly what
 * happened before this was introduced: luxury took 57% of blocks and corporate
 * never won a single one.
 */
interface FieldScales {
  readonly eminence: number;
  readonly slope: number;
}

const maxAbs = (field: Field2D): number =>
  Math.max(
    1e-6,
    field.data.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  );

const fieldScalesOf = (fields: FieldStack): FieldScales => ({
  eminence: maxAbs(fields.localEminence),
  slope: maxAbs(fields.slope),
});

const sampleBlockFields = (
  fields: FieldStack,
  grid: Grid,
  ring: readonly Vec2[],
  scales: FieldScales
): BlockFieldSample => {
  const points = samplePolygonInteriorPoints(ring, SAMPLE_SATELLITE_COUNT);
  const meanOf = (field: Field2D): number =>
    points.reduce(
      (sum, p) =>
        sum + bilinearSample(field, p.x / grid.cellSizeM, p.y / grid.cellSizeM),
      0
    ) / points.length;
  return {
    centrality: meanOf(fields.centrality),
    prestige: meanOf(fields.prestige),
    decay: meanOf(fields.decay),
    distWater: meanOf(fields.distWater),
    shadow: meanOf(fields.shadow),
    floodRisk: meanOf(fields.floodRisk),
    slope: meanOf(fields.slope) / scales.slope,
    localEminence: meanOf(fields.localEminence) / scales.eminence,
  };
};

interface Affinity {
  readonly district: (typeof ZONEABLE_DISTRICTS)[number];
  readonly score: number;
}

/**
 * The five affinity formulas of design doc §6, in the fixed order that
 * resolves exact ties (earliest entry wins — see `argmaxAffinity`).
 */
const computeAffinities = (
  sample: BlockFieldSample,
  stripAdjacency: number
): readonly Affinity[] => [
  {
    district: "corporate",
    score:
      ZONING.corporate.centrality * sample.centrality +
      ZONING.corporate.prestige * sample.prestige +
      ZONING.corporate.decay * sample.decay,
  },
  {
    district: "casino",
    score:
      ZONING.casino.stripAdjacency * stripAdjacency +
      // The waterfront band and centrality are *modifiers on the strip*, not
      // independent reasons to build a casino. Left additive they form an
      // unconditional floor — `band` is ~1 across most of the map, which made
      // casino win 68% of blocks and squeezed out luxury and suburb entirely.
      stripAdjacency *
        (ZONING.casino.waterBand *
          band(
            sample.distWater,
            ANCHORS.waterBandNearM,
            ANCHORS.waterBandFarM
          ) +
          ZONING.casino.centrality * sample.centrality),
  },
  {
    district: "luxury",
    score:
      ZONING.luxury.prestige * sample.prestige +
      ZONING.luxury.eminence * sample.localEminence +
      ZONING.luxury.centrality * sample.centrality +
      ZONING.luxury.decay * sample.decay,
  },
  {
    district: "suburb",
    score:
      ZONING.suburb.base +
      ZONING.suburb.centrality * sample.centrality +
      ZONING.suburb.decay * sample.decay +
      ZONING.suburb.slope * sample.slope +
      ZONING.suburb.prestige * sample.prestige,
  },
  {
    district: "slum",
    score:
      ZONING.slum.decay * sample.decay +
      ZONING.slum.shadow * sample.shadow +
      ZONING.slum.flood * sample.floodRisk,
  },
];

/**
 * A district settled on, with how clear the call was.
 *
 * The margin travels with the district because the mode filter downstream reads
 * it to decide what it may overturn. Named rather than written inline at both
 * producers below: they decide differently — one scores, one applies the forced
 * megablock rule — but `initialAssignment` returns `argmaxAffinity`'s value on
 * one of its branches, so it is the same value, not a coincidence of shape.
 */
interface DistrictChoice {
  readonly district: DistrictKind;
  readonly margin: number;
}

/**
 * Highest-scoring district and its margin over the runner-up.
 * `toSorted` is a stable sort, so among exactly-tied scores the entry that
 * appeared first in `affinities` (the fixed evaluation order above) is the
 * one that ends up at index 0 — ties resolve identically every run.
 */
const argmaxAffinity = (affinities: readonly Affinity[]): DistrictChoice => {
  const sorted = affinities.toSorted((a, b) => b.score - a.score);
  return {
    district: sorted[0].district,
    margin: sorted[0].score - sorted[1].score,
  };
};

const isMegaSeedBlock = (
  ring: readonly Vec2[],
  megaSeeds: readonly Vec2[]
): boolean => megaSeeds.some((seed) => containsPoint(ring, seed));

const initialAssignment = (
  ring: readonly Vec2[],
  megaSeeds: readonly Vec2[],
  sample: BlockFieldSample,
  stripAdjacency: number
): DistrictChoice =>
  isMegaSeedBlock(ring, megaSeeds)
    ? { district: "megablock", margin: FORCED_DISTRICT_MARGIN }
    : argmaxAffinity(computeAffinities(sample, stripAdjacency));

/**
 * One synchronous mode-filter generation for block `index`: every read is
 * `labels[*]` from the *previous* generation, so evaluating every block this
 * way and collecting the results into a new array (never mutating `labels`
 * in place) gives the double-buffered semantics design doc §3 stage 8
 * requires — in-place updates would let an early block's new label leak into
 * a later block's neighbour count within the same pass.
 */
export const modeFilterStep = (
  index: number,
  labels: readonly DistrictKind[],
  margins: readonly number[],
  neighbourIndexLists: readonly (readonly number[])[]
): DistrictKind => {
  if (!(margins[index] < ZONING.modeFilterMaxMargin)) return labels[index];
  const neighbourLabels = neighbourIndexLists[index].map((ni) => labels[ni]);
  const counts = DISTRICT_KINDS.map((district) => ({
    district,
    count: neighbourLabels.filter((label) => label === district).length,
  }));
  const majority = counts.reduce((best, c) =>
    c.count > best.count ? c : best
  );
  return majority.count >= ZONING.modeFilterMinAgreeing
    ? majority.district
    : labels[index];
};

export const applyModeFilterPasses = (
  labels: readonly DistrictKind[],
  margins: readonly number[],
  neighbourIndexLists: readonly (readonly number[])[]
): readonly DistrictKind[] =>
  Array.from({ length: ZONING.modeFilterPasses }).reduce<
    readonly DistrictKind[]
  >(
    (generation) =>
      generation.map((_label, i) =>
        modeFilterStep(i, generation, margins, neighbourIndexLists)
      ),
    labels
  );

/**
 * Megalot rim pass (P2 graft): corporate blocks at least `megalotMinAreaM2`
 * large, adjacent to a slum block in the *post-filter* label snapshot,
 * become arcologies. `promote` is computed once from that frozen snapshot
 * and then applied in a second pass, so a block promoted by this pass can
 * never itself count as the "slum neighbour" for another — "applied
 * simultaneously" per design doc §3 stage 8.
 */
export const applyMegalotRim = (
  labels: readonly DistrictKind[],
  areas: readonly number[],
  neighbourIndexLists: readonly (readonly number[])[]
): readonly DistrictKind[] => {
  const promote = labels.map((label, i) => {
    if (label !== "corporate") return false;
    if (areas[i] < ZONING.megalotMinAreaM2) return false;
    return neighbourIndexLists[i].some((ni) => labels[ni] === "slum");
  });
  return labels.map((label, i) => (promote[i] ? "megablock" : label));
};

/**
 * Stage 8: assigns every block a `district` via per-block argmax, smooths
 * the result with a synchronous double-buffered mode filter, then runs the
 * megalot rim pass. Purely deterministic — see the module doc comment for
 * why the `RngStream` parameter goes unused.
 */
export const zoningStage = (
  input: ZoningInput,
  _stream: RngStream
): readonly Block[] => {
  const { context, blockLayer } = input;
  const { fields, anchors, grid } = context;
  const rings = blockLayer.blocks.map((block) =>
    ringFromPool(blockLayer.polygons, block.ringIndex)
  );
  const centroids = rings.map((ring) => ringCentroid(ring));
  const scales = fieldScalesOf(fields);
  const samples = rings.map((ring) =>
    sampleBlockFields(fields, grid, ring, scales)
  );
  const stripAdjacencies = centroids.map((point) =>
    stripAdjacencyAt(point, blockLayer.roads)
  );
  const areas = rings.map((ring) => polygonArea(ring));

  const indexById = new Map(
    blockLayer.blocks.map((block, index) => [block.id, index] as const)
  );
  const indexOfBlock = (blockId: number): number => {
    const idx = indexById.get(blockId);
    if (idx === undefined) {
      throw new Error(`zoning: unknown neighbour block id ${blockId}`);
    }
    return idx;
  };
  const neighbourIndexLists = blockLayer.blocks.map((block) =>
    block.neighbourIds.map(indexOfBlock)
  );

  const initial = blockLayer.blocks.map((_block, i) =>
    initialAssignment(
      rings[i],
      anchors.megaSeeds,
      samples[i],
      stripAdjacencies[i]
    )
  );
  const labels = initial.map((a) => a.district);
  const margins = initial.map((a) => a.margin);

  const filtered = applyModeFilterPasses(labels, margins, neighbourIndexLists);
  const finalLabels = applyMegalotRim(filtered, areas, neighbourIndexLists);

  return blockLayer.blocks.map((block, i) => ({
    id: block.id,
    ringIndex: block.ringIndex,
    boundary: block.boundary,
    neighbourIds: block.neighbourIds,
    district: finalLabels[i],
    water: block.water,
    scoreMargin: margins[i],
  }));
};
