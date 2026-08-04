import { z } from "zod";

/**
 * Domain vocabulary for the procedural city generator.
 *
 * Per ADR-0016 this module imports nothing from the layers above it. Every
 * closed set is declared as a `const` array plus a derived union so that adding
 * a member is additive: per-member configuration is written as
 * `Record<Union, T>`, which fails to compile until the new member is handled.
 */

export const generationParamsSchema = z.object({
  seed: z.string().min(1),
  /** Map extent in metres, square. */
  sizeM: z.number().int().min(1024).max(4096).default(2048),
  /** Field grid resolution per axis. */
  cells: z.number().int().min(128).max(1024).default(512),
});
export type GenerationParams = z.infer<typeof generationParamsSchema>;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Dense row-major scalar field over the generation grid. */
export interface Field2D {
  readonly cells: number;
  readonly cellSizeM: number;
  readonly data: Float32Array;
}

export const WATER_CLASSES = ["none", "ocean", "river"] as const;
/** @public published domain vocabulary: consumers narrow on this union even where the first slice does not, and it is the name a new member is added to */
export type WaterClass = (typeof WATER_CLASSES)[number];

export interface TerrainLayer {
  readonly elevation: Field2D;
  /** WaterClass ordinal per cell, indexed like Field2D.data. */
  readonly waterMask: Uint8Array;
  readonly waterDepth: Field2D;
  readonly seaLevelM: number;
}

export interface FieldStack {
  readonly slope: Field2D;
  readonly distWater: Field2D;
  readonly distLand: Field2D;
  readonly localEminence: Field2D;
  readonly floodRisk: Field2D;
  readonly centrality: Field2D;
  readonly shadow: Field2D;
  readonly prestige: Field2D;
  readonly decay: Field2D;
}

/** @public the const array is the single source of the union below; exported so a new member can be enumerated and every `Record` over it fails to compile until handled (ADR-0027 additive extension) */
export const ANCHOR_KINDS = ["cbd", "mega", "casino"] as const;
/** @public published domain vocabulary: consumers narrow on this union even where the first slice does not, and it is the name a new member is added to */
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export interface Anchor {
  readonly kind: AnchorKind;
  readonly pos: Vec2;
}

export const ROAD_CLASSES = ["highway", "avenue", "street", "alley"] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/**
 * An enum rather than a boolean: tunnels are one member away.
 *
 * @public the const array is the single source of the union below; exported so
 * a new member can be enumerated and every `Record` over it fails to compile
 * until handled (ADR-0027 additive extension).
 */
export const CROSSINGS = ["none", "bridge"] as const;
export type Crossing = (typeof CROSSINGS)[number];

/**
 * Flattened polyline geometry. Polyline `i` occupies the vertex range
 * `starts[i] .. starts[i + 1]`, so `starts.length === count + 1`.
 */
export interface PolylinePool {
  readonly coords: Float32Array;
  readonly starts: Uint32Array;
}

export interface RoadNode {
  readonly id: number;
  readonly pos: Vec2;
}

export interface RoadEdge {
  readonly id: number;
  /** Node ids for arterial edges; -1 for subdivision cut and alley edges. */
  readonly a: number;
  readonly b: number;
  readonly cls: RoadClass;
  readonly crossing: Crossing;
  readonly polylineIndex: number;
  readonly strip: boolean;
}

export interface RoadGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  readonly polylines: PolylinePool;
}

export const DISTRICT_KINDS = [
  "corporate",
  "megablock",
  "casino",
  "luxury",
  "suburb",
  "slum",
] as const;
export type DistrictKind = (typeof DISTRICT_KINDS)[number];

/** Polygon rings, pooled like PolylinePool. Rings are counter-clockwise. */
export interface PolygonPool {
  readonly coords: Float32Array;
  readonly starts: Uint32Array;
}

/** @public the const array is the single source of the union below; exported so a new member can be enumerated and every `Record` over it fails to compile until handled (ADR-0027 additive extension) */
export const BOUNDARY_PROVENANCES = [
  "cut",
  "arterial",
  "border",
  "water",
] as const;
/** @public published domain vocabulary: consumers narrow on this union even where the first slice does not, and it is the name a new member is added to */
export type BoundaryProvenance = (typeof BOUNDARY_PROVENANCES)[number];

/**
 * Why a block boundary segment exists. Adjacency is computed by shared
 * provenance id rather than by geometric proximity, so there is no epsilon.
 */
export interface BoundaryRef {
  readonly kind: BoundaryProvenance;
  readonly refId: number;
}

export interface Block {
  /** Deterministic subdivision-DFS order. */
  readonly id: number;
  readonly ringIndex: number;
  readonly boundary: readonly BoundaryRef[];
  readonly neighbourIds: readonly number[];
  readonly district: DistrictKind;
  readonly water: boolean;
  /** Argmax margin over the runner-up district; retained for tuning. */
  readonly scoreMargin: number;
}

/** @public the const array is the single source of the union below; exported so a new member can be enumerated and every `Record` over it fails to compile until handled (ADR-0027 additive extension) */
export const FRONTAGES = ["street", "landlocked", "landlocked-merged"] as const;
export type Frontage = (typeof FRONTAGES)[number];

export interface Lot {
  readonly id: number;
  readonly blockId: number;
  readonly ringIndex: number;
  readonly frontage: Frontage;
  /**
   * Unit direction of the street this lot fronts, or null when it fronts none.
   *
   * Carried on the lot rather than recomputed downstream because it is the
   * subdivision that knows which of the block's boundary edges were roads; by
   * the time a building is massed, that provenance is gone.
   */
  readonly frontageDir: Vec2 | null;
}

export const BUILDING_ARCHETYPES = [
  "megabuilding",
  "corpoTower",
  "casino",
  "luxuryResidence",
  "detachedHouse",
  "slumShack",
] as const;
export type BuildingArchetype = (typeof BUILDING_ARCHETYPES)[number];

/** Oriented bounding box. Orientation is a unit vector, never an angle. */
export interface Obb {
  readonly cx: number;
  readonly cy: number;
  readonly facing: Vec2;
  readonly w: number;
  readonly d: number;
}

export interface BuildingTier {
  readonly heightFrac: number;
  readonly insetFrac: number;
}

export interface Building {
  readonly id: number;
  readonly archetype: BuildingArchetype;
  readonly obb: Obb;
  readonly heightM: number;
  readonly baseZM: number;
  /** Length 1 for every archetype except megabuilding, which has 2-4. */
  readonly tiers: readonly BuildingTier[];
  readonly lotId: number;
  readonly blockId: number;
}

export interface InstanceBuffer {
  readonly count: number;
  /** 16 floats per instance, column-major, sorted by blockId. */
  readonly matrices: Float32Array;
  /** blockId -> [startInstance, endInstance); the hook for future LOD. */
  readonly blockRanges: ReadonlyMap<number, readonly [number, number]>;
}

export const STAGE_NAMES = [
  "terrain",
  "hydrology",
  "derived",
  "anchors",
  "social",
  "arterials",
  "blocks",
  "zoning",
  "lots",
  "buildings",
] as const;
/** @public published domain vocabulary: consumers narrow on this union even where the first slice does not, and it is the name a new member is added to */
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * What the caller is told about progress — eleven steps, not `STAGE_NAMES`' ten.
 *
 * Two vocabularies because they answer different questions. `STAGE_NAMES` is the
 * hash vocabulary: one entry per stage whose output is serialised and hashed, so
 * a golden failure can name the stage that diverged. This is the *reporting*
 * vocabulary, and it has one more member because the pipeline does one more piece
 * of work: `assemble` packs the instance buffers after `buildings`.
 *
 * Conflating them left that work structurally unobservable. `pipeline.ts` had
 * always described itself as composing eleven stages and `stages/types.ts` numbers
 * `assemble` as the eleventh, but progress was reported by looking a name up in the
 * ten-entry hash list — so the last thing the outside heard was "buildings
 * started", and instance packing plus ten hashes over the full field data ran with
 * the UI still showing the previous step. The first ten indices are unchanged, so
 * this is additive for anything already reading the number.
 */
export const PROGRESS_STEPS = [...STAGE_NAMES, "assemble"] as const;
/** @public published domain vocabulary: the name a new reported step is added to */
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

/**
 * The things the engine throws away, named.
 *
 * Every stage drops something — a polyline vertex that repeats its
 * predecessor, a road with no length, a block ring that crosses itself. Those
 * decisions used to leave no trace, so counting them meant reconstructing them
 * from the output, and a reconstruction that disagrees with the engine is just
 * a wrong number that looks like a measurement. Naming them here makes the
 * engine the one that answers.
 *
 * A union rather than a free string because a consumer should be able to
 * narrow on it exhaustively, and because a new reason has one place to be
 * added and every switch over it then fails to compile until it is handled.
 *
 * @public the const array is the single source of the union below; exported so
 * a diagnostics reader can enumerate every reason without hard-coding the list,
 * and so a new member fails every exhaustive `Record` over it until handled
 */
export const DISCARD_REASONS = [
  /** Two consecutive polyline points at the same position. */
  "duplicate-vertex",
  /** A road whose ends coincide, so it has no direction and bounds nothing. */
  "zero-length-edge",
  /** A second edge tracing a stretch of road another edge already traced. */
  "duplicate-route",
  /**
   * An edge whose two ends resolved to one node, so it leaves that node and
   * returns to it without bounding anything a face walk can follow.
   *
   * Distinct from `zero-length-edge`: the road has real length, and it is the
   * 12 m node snap that merged its ends. Reported rather than silently skipped
   * because its half-edges have no direction, and a directionless entry in a
   * rotation sorted by angle is what made that sort engine-dependent.
   */
  "self-loop-edge",
  /** A block ring that crosses itself, whose area and centroid mean nothing. */
  "folded-block",
  /**
   * A block ring wound clockwise, so it encloses the ground outside itself.
   * Simple, unlike a folded ring, so the fold test passes it.
   */
  "inside-out-block",
] as const;
/** @public published domain vocabulary: the name a new discard reason is added to */
export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** One stage's tally of one kind of discard. */
export interface Discard {
  readonly stage: StageName;
  readonly reason: DiscardReason;
  readonly count: number;
}

/**
 * How the engine reports what it discarded.
 *
 * Returns `void`, and the engine never reads anything back — that is the whole
 * contract. An observer cannot steer generation, so attaching one cannot change
 * a single byte of the output, which `pipeline.test.ts` asserts by generating
 * the same seed with and without one and comparing the content hash. ADR-0027's
 * determinism survives injection only because the arrow points one way.
 */
export type DiscardObserver = (discard: Discard) => void;

export interface CityModel {
  readonly params: GenerationParams;
  readonly terrain: TerrainLayer;
  readonly fields: FieldStack;
  readonly anchors: readonly Anchor[];
  readonly roads: RoadGraph;
  readonly blocks: readonly Block[];
  readonly blockPolygons: PolygonPool;
  readonly lots: readonly Lot[];
  readonly lotPolygons: PolygonPool;
  readonly buildings: readonly Building[];
  readonly instances: Readonly<Record<BuildingArchetype, InstanceBuffer>>;
  /** Per-stage content hash; a golden failure names each divergent stage. */
  readonly stageHashes: Readonly<Record<StageName, string>>;
  readonly contentHash: string;
  /**
   * Everything the run discarded, in the order the stages reported it.
   *
   * The same tallies `DiscardObserver` streams, kept on the model as well because
   * the streaming channel had no consumer outside the tests: `worker.ts` passed
   * only `onProgress`, so in the running app the engine's own account of what it
   * threw away went nowhere. A field on the result crosses `postMessage` with
   * everything else and needs no new lifecycle event to carry it.
   *
   * Deliberately outside `contentHash`. The hash answers "is this the same city",
   * and a change to what the engine chooses to report is not a change to the city
   * — mixing them in would make every reporting edit look like a regression in
   * `golden.ts`. `pipeline.test.ts` pins the discards separately for that reason.
   */
  readonly discards: readonly Discard[];
}
