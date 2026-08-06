import type {
  Anchor,
  Block,
  Building,
  DiscardObserver,
  Field2D,
  FieldStack,
  GenerationParams,
  Lot,
  PolygonPool,
  RoadGraph,
  TerrainLayer,
  Vec2,
} from "@/entities/city";
import type { RngStream } from "../rng/types";

/**
 * The contract between pipeline stages.
 *
 * Each stage is a pure total function of its declared inputs plus its own RNG
 * stream. Types are declared here rather than inside each stage so that a stage
 * can be written, reviewed and tested without reading its neighbours, and so
 * that inserting a stage is an additive change.
 */

/** Geometry shared by the whole run: extent, resolution, cell size. */
export interface Grid {
  readonly cells: number;
  readonly sizeM: number;
  readonly cellSizeM: number;
}

export const gridOf = (params: GenerationParams): Grid => ({
  cells: params.cells,
  sizeM: params.sizeM,
  cellSizeM: params.sizeM / params.cells,
});

/** Stage 3 output: everything derivable from terrain alone. */
export interface DerivedFields {
  readonly slope: Field2D;
  readonly distWater: Field2D;
  readonly distLand: Field2D;
  readonly localEminence: Field2D;
  readonly floodRisk: Field2D;
}

/**
 * Stage 4 output. The strip axis is constructed rather than hoped for: without
 * it the casino district depends on a waterfront happening to align, which the
 * design's judges flagged as a weak-seed failure.
 */
export interface AnchorSet {
  readonly anchors: readonly Anchor[];
  readonly cbd: Vec2;
  readonly megaSeeds: readonly Vec2[];
  readonly casino: Vec2;
  readonly stripAxis: { readonly origin: Vec2; readonly dir: Vec2 };
}

/** Stage 5 output: the social fields layered on top of the derived ones. */
export interface SocialFields {
  readonly centrality: Field2D;
  readonly shadow: Field2D;
  readonly strip: Field2D;
  readonly prestige: Field2D;
  readonly decay: Field2D;
}

/**
 * A block before zoning has assigned it a district.
 *
 * @public the inter-stage contract between subdivision and zoning; it is a
 * published boundary type even though `BlockLayer` is what stages import.
 */
export interface RawBlock {
  readonly id: number;
  readonly ringIndex: number;
  readonly boundary: Block["boundary"];
  readonly neighbourIds: readonly number[];
  readonly water: boolean;
}

/** Stage 7 output. Cut segments are appended to the arterial graph. */
export interface BlockLayer {
  readonly blocks: readonly RawBlock[];
  readonly polygons: PolygonPool;
  readonly roads: RoadGraph;
}

/** Stage 9 output. Alley segments are appended to the street graph. */
export interface LotLayer {
  readonly lots: readonly Lot[];
  readonly polygons: PolygonPool;
  /**
   * The whole network, not this stage's own contribution to it: the alleys plus
   * everything `BlockLayer.roads` carried. Downstream stages take the road graph
   * from the last stage that changed it, so there is never a moment where
   * grading or massing has to know the network arrives in pieces.
   */
  readonly roads: RoadGraph;
}

/** Stage 10 output. Vetoed parcels become plazas, never holes. */
export interface BuildingLayer {
  readonly buildings: readonly Building[];
  readonly plazaLotIds: readonly number[];
}

/** The accumulated result threaded through the pipeline. */
export interface PipelineContext {
  readonly params: GenerationParams;
  readonly grid: Grid;
  readonly terrain: TerrainLayer;
  readonly derived: DerivedFields;
  readonly anchors: AnchorSet;
  readonly fields: FieldStack;
}

/**
 * Every stage has this shape: declared inputs, its own stream, pure output.
 *
 * `observe` is how a stage says what it threw away. It returns `void` and the
 * stage never reads it back, so a stage's output cannot depend on whether
 * anyone is listening — see `DiscardObserver`. Optional at both ends: a stage
 * that discards nothing omits the parameter, and a caller that is not watching
 * omits the argument.
 */
export type Stage<TInput, TOutput> = (
  input: TInput,
  stream: RngStream,
  observe?: DiscardObserver
) => TOutput;
