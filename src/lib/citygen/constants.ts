import type { DistrictKind, RoadClass } from "@/entities/city";

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
    /**
     * Distance alone should not create a slum.
     *
     * At 0.45 this term alone put decay at ~0.36 map-wide, which handed 57-61%
     * of blocks to `slum` on every fixture seed and left luxury and suburb at
     * 0-3%. Design §6 says slums get the *residue* — shadow, flood risk, steep
     * leftovers — not merely the periphery, which is where suburbs belong.
     */
    remoteness: 0.18,
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
  /**
   * Corner rounding applied to each simplified run — a `SmoothOptions` for
   * `geometry/smooth.ts`, which is where the shape of the curve is explained.
   *
   * `maxDeviationM` is what decides how much of the terrain-following the road is
   * allowed to give up, because the path underneath it was chosen to avoid water
   * and slope and rounding a corner cuts inside it. 8 m is two grid cells at the
   * app's own extent and roughly half a carriageway, so the original route still
   * lies under the drawn road — a highway covers 15 m either side of its
   * centreline — and the water and slope the route was avoiding are still being
   * avoided. It is also rarely the binding cap: measured on the golden seeds, a
   * median 39-degree turn between 40 m segments is held to 20 m of tangent by the
   * segments themselves, which spends 3.3 m of the budget.
   *
   * `maxChordM` matches `simplifyEpsilonM` on purpose. Douglas-Peucker has already
   * declared detail finer than 6 m not worth keeping on these paths, so
   * reproducing the curve to better than that would add vertices the whole
   * downstream pipeline pays for — `blocks.ts` makes a face-graph node of each —
   * to represent precision the input never had.
   */
  smooth: {
    maxDeviationM: 8,
    maxChordM: 6,
  },
} as const;

/**
 * Stage 10 — earthworks (ADR-0028).
 *
 * `maxGrade` is a rise over run per road class, and the numbers are read off
 * 道路構造令 第20条 rather than chosen: that table caps the longitudinal gradient
 * at 2% standard and 5% exceptional for a 120 km/h expressway, 5% and 7% for a
 * 60 km/h urban road, 9% and 11% by the time design speed falls to 20 km/h, with
 * roughly 12% the most it will allow anywhere. The four classes are placed on that
 * scale by the speed each implies, and each takes the exceptional rather than the
 * standard value — the permissive end of legal, which is the honest reading for a
 * city that grew on this terrain.
 *
 * `roadCutM` is what makes the gradient a target rather than a demand. Without a
 * budget the cap is not a preference, it is a constraint that spends whatever it
 * takes: a 200 m street climbing a hillside has to drop its upper end some 80 m to
 * come inside 9%, and the raster version of this stage excavated exactly that before
 * ADR-0028 replaced it. It is one number for every class because a carriageway is
 * cut to the same standard wherever it runs; what varies by district is what gets
 * built beside it.
 *
 * `budget` is that variation, in metres of cut and of fill a lot may be levelled by.
 * One figure for the whole map was the first shape and it hollowed the city out: at
 * 4 m of cut and 2 m of fill only a lot with 6 m of relief or less can be levelled,
 * which fairly describes what someone building a house will pay for and badly
 * describes a tower. Measured on `akiba-01`, 45% of dry blocks were zoned corporate
 * and carried 82 towers between them, the rest of their lots being too steep to
 * level and so vetoed. Half the city was zoned for towers and mostly empty.
 *
 * A tower is exactly the case that justifies the earthwork — it arrives with piles, a
 * podium and retaining walls whatever the ground was doing, and its floor plate pays
 * for the excavation — while a shack arrives with none of that and sits on the slope
 * it found. Fill stays at half of cut throughout, because spoil is easier to remove
 * than to import and compact, and a filled platform leans on the retaining structure
 * that the skirt only draws.
 *
 * This is also the whole of the buildability test. `buildings.ts` vetoes a lot
 * exactly when the budget could not level it, rather than comparing relief against a
 * second constant that would be free to drift from these.
 */
export const GRADING = {
  maxGrade: {
    highway: 0.05,
    avenue: 0.07,
    street: 0.09,
    alley: 0.12,
  },
  roadCutM: 4,
  budget: {
    corporate: { maxCutM: 12, maxFillM: 6 },
    megablock: { maxCutM: 14, maxFillM: 7 },
    casino: { maxCutM: 10, maxFillM: 5 },
    luxury: { maxCutM: 6, maxFillM: 3 },
    suburb: { maxCutM: 4, maxFillM: 2 },
    slum: { maxCutM: 1, maxFillM: 0.5 },
  },
} as const;

/**
 * Carriageway width per road class, kerb to kerb, in metres.
 *
 * Until this existed a road was a centreline with no width at all, and because
 * a block is a face of the road graph, the block boundary *was* that centreline
 * — so a building set back 4 m from its lot stood 4 m from the middle of the
 * road. Measured on akiba-01 before this change: 526 of 5798 buildings (9.1%)
 * stood inside the carriageway of the road they fronted, the closest 0.03 m
 * from its centre.
 *
 * The figures are ordinary urban cross-sections: two 3.5 m lanes plus kerbs for
 * a street, four lanes plus a median for an avenue, four lanes plus shoulders
 * for a highway. Half of each is taken off the block on the edge that road
 * bounds, so the gap between two blocks is one full carriageway.
 *
 * The alley is the one that is not a carriageway at all, and it read 4 m — a
 * service lane wide enough for a vehicle — for as long as the generator never
 * produced one. What it produces now is the lane threaded between slum shacks
 * and the pole of a suburban flag lot, and 4 m is the wrong order of magnitude
 * for both: a slum parcel is about 10.5 m on a side, so 4 m taken off two of
 * them halves it.
 *
 * That was measured as a trial of 4 m against the state before alleys existed at
 * all — neither figure below describes the 2 m this ships. On akiba-01 at the
 * app's own 512 cells, the median slum parcel went 110.0 m² to 59.1 m² and the
 * slum lots with no building on them went 991 of 3,560 to 1,773. At the golden
 * 128 cells, where the density band is asserted, the map went 1,084 buildings
 * per km² to 963 — under the 1,000 floor `pipeline.test.ts` holds.
 *
 * 2 m is what the thing being drawn actually measures. Tokyo's safety ordinance
 * puts the minimum width of a 路地状敷地 at 2 m up to 20 m of length, and Edo
 * backstreet tenements ran 3 to 6 shaku — 0.9 to 1.8 m. It is deliberately under
 * the 4 m that Article 42 of the Building Standards Act requires of a legal
 * road: a slum warren does not satisfy the frontage rule, and that is what makes
 * it a slum rather than a suburb.
 */
export const ROAD_WIDTH_M: Readonly<Record<RoadClass, number>> = {
  highway: 30,
  avenue: 22,
  street: 11,
  alley: 2,
};

/**
 * Minimum buildable area left after the carriageway is taken off a block.
 *
 * A block narrower than the roads around it insets to nothing or turns inside
 * out. Below this it yields no lots at all, which is the honest outcome: the
 * space is roadway, not a plot.
 */
export const MIN_BUILDABLE_BLOCK_M2 = 120;

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
  /**
   * Corporate is a core, not a region. At 2.2 it beat suburb across most of
   * the map once decay came down (43-48% of blocks); the crossover with
   * suburb's flat base needs to sit at genuinely high centrality.
   */
  corporate: { centrality: 1.5, prestige: 0.5, decay: -1.5 },
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
  /**
   * Closed-form count control target, as a density rather than a total.
   *
   * It was an absolute 5,500, which is only meaningful at the design's stated
   * ~4 km² extent. `sizeM` is user-selectable from 1024 to 4096 — a 16x area
   * range — so an absolute target made the upper clamp saturate at the larger
   * sizes and the control stopped governing at all: 4096 m produced ~20,000
   * buildings whether or not the overshoot correction was applied.
   *
   * Expressing it per km² shrinks that problem but does not remove it. The
   * `areaScaleMin`/`areaScaleMax` clamp still saturates for some
   * (seed, extent, cells) combinations — measured unclamped scales against the
   * 1.8 ceiling: akiba-01 at 4096 m/256 cells = 1.8408, at 4096 m/128 = 1.9055,
   * and at 1024 m/128 = 1.8476. So saturation is not confined to large maps.
   * Where it saturates the closed-form control stops governing and the residual
   * is absorbed silently; measured density stays in band regardless
   * (~1220-1465/km² across 27 seed x extent x cells combinations), so the bound
   * is accepted rather than eliminated. The cause is that `expected` does not
   * grow linearly with area: akiba-01 from 2048 m to 4096 m is a 4x area
   * increase but a 5.14x increase in `expected`.
   *
   * 1311.3 is exactly the previous 5,500 over the default 2048 m extent
   * (4.194 km²) — that arithmetic alone leaves the density *target* unchanged.
   * The default map's building count does change, because `subdivisionOvershoot`
   * below lands in the same change: measured on akiba-01, 8,300 -> 5,706 (~31%).
   */
  targetBuildingDensityPerKm2: 1311.3,
  /**
   * How many more lots bisection actually yields than `area / targetArea`.
   *
   * The closed-form control divides block area by the target lot area, which
   * would be exact if every leaf landed *on* the target. Recursive bisection
   * instead stops once a leaf is at or under it, so leaves occupy roughly
   * (target/2, target] and the mean sits well below the target. Measured over
   * the three fixture seeds: 1.434, 1.330, 1.458 — mean 1.41. Without this the
   * control predicted ~5,500 lots and produced ~8,000.
   */
  subdivisionOvershoot: 1.41,
  areaScaleMin: 0.6,
  areaScaleMax: 1.8,
  /** Shared boundary length, in metres, that counts as street frontage. */
  minFrontageM: 6,
  /** Slum cut-angle jitter, as a unit-vector blend rather than an angle. */
  slumAngleJitter: 0.16,
} as const;

/** Stage 10 — buildings. */
export const BUILDINGS = {
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
