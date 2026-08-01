import type { DistrictKind } from "@/entities/city";

/**
 * Every tuned number in the generator, in one place.
 *
 * Design §3 requires this: a threshold buried in a stage is a threshold nobody
 * can retune, and the epsilons in particular have to be findable because they
 * decide determinism. Values are grouped by the stage that consumes them.
 */

/** Stage 1 — terrain. */
export const TERRAIN = {
  octaves: 6,
  /** Metres^-1. One dominant landform across a 2 km map. */
  baseFrequency: 1 / 1400,
  lacunarity: 2,
  gain: 0.5,
  warpOctaves: 2,
  warpAmplitudeM: 180,
  /** Blend weight of the ridged multifractal, guaranteeing one ridge line. */
  ridgedBlend: 0.25,
  maxElevationM: 220,
} as const;

/** Stage 2 — hydrology. */
export const HYDROLOGY = {
  /** Percentile of elevation taken as sea level, so every seed has a coast. */
  seaLevelPercentile: 0.18,
  /** Fraction of land cells draining through a cell before it becomes river. */
  riverAccumulationFraction: 0.015,
  riverCarveM: 2,
  riverDilatePasses: 2,
} as const;

/** Stage 3 — derived fields. */
export const DERIVED = {
  eminenceBlurRadiusCells: 64,
  /** Height above nearest water, in metres, at which flood risk reaches zero. */
  floodHeightM: 8,
  /** Distance from water, in metres, at which flood risk reaches zero. */
  floodDistanceM: 120,
} as const;

/** Stage 4 — anchors. */
export const ANCHORS = {
  /** The argmax runs on an 8x downsampled grid. */
  downsample: 8,
  cbdSlopeWeight: 0.4,
  cbdWaterBandWeight: 0.3,
  cbdCenterWeight: 0.3,
  megaSeedCount: 4,
  /** Flat-and-dry score a cell must beat to host a megablock seed. */
  megaSeedThreshold: 0.6,
  /** The waterfront band, in metres: near the water but not in it. */
  waterBandNearM: 60,
  waterBandFarM: 400,
  /** Half-length of the constructed casino strip, in metres. */
  stripHalfLengthM: 450,
} as const;

/** Stage 5 — social fields. */
export const SOCIAL = {
  slopeCostWeight: 8,
  /** Effectively impassable, so geodesic distance goes around water. */
  waterCost: 1000,
  /**
   * Cost-weighted metres at which centrality has fallen to one half.
   *
   * Measured, not guessed: the cost surface multiplies raw distance by up to
   * `1 + slopeCostWeight`, so a half-distance expressed in *plain* metres
   * collapses centrality to a p50 of 0.16 across the map. That starved the
   * corporate affinity (weighted on centrality) and inflated decay
   * (`0.45 * (1 - centrality)`), which handed 77% of blocks to the slums.
   */
  centralityHalfDistanceM: 1500,
  /** Metres over which a megablock's shadow fades. */
  shadowRadiusM: 260,
  prestige: {
    eminence: 0.4,
    waterBand: 0.25,
    flatness: 0.2,
    flood: -0.35,
    shadow: -0.3,
  },
  decay: {
    remoteness: 0.45,
    flood: 0.25,
    steepness: 0.2,
    shadow: 0.3,
    prestige: -0.3,
  },
  flatnessSlopeLo: 0.1,
  flatnessSlopeHi: 0.3,
  steepSlopeLo: 0.15,
  steepSlopeHi: 0.35,
} as const;

/** Stage 6 — arterials. */
export const ARTERIALS = {
  slopeCostWeight: 8,
  /** Cost of crossing water; finite only within bridgeSpanM of land. */
  waterCrossCost: 60,
  /** Maximum half-span of a bridge, in metres. Beyond this water is excluded. */
  bridgeSpanM: 120,
  /** Douglas-Peucker epsilon, in metres. */
  simplifyEpsilonM: 6,
  spatialHashCellM: 64,
  /** Nodes closer than this are merged during planarization. */
  nodeSnapM: 12,
  /** Coordinates are rounded to this lattice before snapping, for determinism. */
  snapLatticeM: 0.25,
  /** Discount applied along the waterfront so the strip hugs the shore. */
  stripWaterBandDiscount: 0.6,
} as const;

/** Stage 7 — blocks. */
export const BLOCKS = {
  minBlockAreaM2: 1400,
  maxBlockAreaM2: 9000,
  urbanIntensity: { centrality: 0.6, prestige: 0.4, decay: 0.3 },
  /** Cut offset from the OBB centre, as a fraction of the long axis. */
  cutOffsetLo: 0.42,
  cutOffsetHi: 0.58,
  /** Below this blended tensor magnitude the orientation field is meaningless. */
  degenerateTensorMagnitude: 0.05,
  /** A cut too parallel to the long axis would not reduce area; flip it. */
  maxCutLongAxisDot: 0.8,
  /** Decay above which cut directions are jittered into a slum tangle. */
  slumTangleDecay: 0.6,
  slumTangleBlend: 0.35,
  /** Fraction of sample points in water above which a block is a water block. */
  waterBlockFraction: 0.5,
  /**
   * Hard recursion backstop, independent of the geometric shrink argument.
   *
   * `splitPolygon` only guarantees a vertex on each side of the cut, not a
   * bounded area split, so a concave face can in principle shave slivers and
   * recurse far deeper than the ~14 the area ratio predicts. Every other
   * unbounded recursion here carries a bound that does not depend on its own
   * correctness proof (`boundedDrain`'s maxOps); this is that bound. Well above
   * any realistic depth, far below the measured ~9,765-frame stack limit.
   */
  maxSubdivideDepth: 64,
} as const;

/** Stage 8 — zoning affinity weights, per district. */
export const ZONING = {
  corporate: { centrality: 2.2, prestige: 0.5, decay: -1.5 },
  casino: { stripAdjacency: 3, waterBand: 1.2, centrality: 0.8 },
  luxury: { prestige: 2, eminence: 1, centrality: -1.2, decay: -2 },
  suburb: {
    base: 1,
    centrality: -0.8,
    decay: -1,
    slope: -0.6,
    prestige: 0.3,
  },
  slum: { decay: 2, shadow: 1.2, flood: 0.8 },
  /** Mode filter: synchronous double-buffered, so order cannot matter. */
  modeFilterPasses: 2,
  modeFilterMinAgreeing: 4,
  /** Only blocks this unsure about their label adopt the neighbourhood mode. */
  modeFilterMaxMargin: 0.08,
  /** Corporate blocks at least this large on a slum border become arcologies. */
  megalotMinAreaM2: 12000,
} as const;

/** Stage 9 — lots. Target areas in square metres, before the count scale. */
export const LOT_TARGET_AREA_M2: Readonly<Record<DistrictKind, number>> = {
  corporate: 2600,
  megablock: 12000,
  casino: 2200,
  luxury: 1700,
  suburb: 650,
  slum: 180,
};

export const LOTS = {
  cutOffsetLo: 0.42,
  cutOffsetHi: 0.58,
  /** Closed-form count control aims the whole map at this many buildings. */
  targetBuildingCount: 5500,
  areaScaleMin: 0.6,
  areaScaleMax: 1.8,
  /** Shared boundary length, in metres, that counts as street frontage. */
  minFrontageM: 6,
  /** Slum cut-angle jitter, as a unit-vector blend rather than an angle. */
  slumAngleJitter: 0.16,
} as const;

/** Stage 10 — buildings. */
export const BUILDINGS = {
  /** Relief under the footprint, in metres, above which most archetypes are vetoed. */
  reliefVetoM: 6,
  /** Shacks terrace instead of being vetoed; this is their step height. */
  shackTerraceStepM: 2.8,
  /** A tower may not exceed this multiple of its smallest plan dimension. */
  maxSlenderness: 9,
  /** Lots smaller than this become plazas rather than buildings. */
  minFootprintM2: 24,
  corpo: {
    baseM: 90,
    centralityGainM: 240,
    jitterLo: 0.72,
    jitterSpan: 0.28,
    minM: 60,
    maxM: 330,
    /** Above this draw a tower spikes, giving the skyline a heavy tail. */
    spikeThreshold: 0.96,
    spikeBase: 1.5,
    spikeGain: 2.5,
    insetM: 4,
  },
  megabuilding: {
    baseM: 140,
    spanM: 120,
    insetM: 6,
    minTiers: 2,
    maxExtraTiers: 3,
  },
  casino: { baseM: 18, spanM: 30, coverage: 0.85, facingSnapM: 40 },
  luxury: { baseM: 8, spanM: 10, coverage: 0.25 },
  suburb: { baseM: 5, spanM: 4, coverage: 0.35 },
  slum: { coverage: 0.9, maxFloors: 3, secondBoxChance: 0.3 },
} as const;
