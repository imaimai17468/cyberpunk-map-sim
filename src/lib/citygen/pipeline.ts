import {
  type CityModel,
  DISTRICT_KINDS,
  type Discard,
  type DiscardObserver,
  type DistrictKind,
  type FieldStack,
  type GenerationParams,
  PROGRESS_STEPS,
  type ProgressStep,
  STAGE_NAMES,
  type StageName,
  generationParamsSchema,
} from "@/entities/city";
import { masterSeed, stageStream } from "./rng/xoshiro";
import { byteWriter, hashBytes, hashConcat } from "./serialize";
import { anchors } from "./stages/anchors";
import { arterialsStage } from "./stages/arterials";
import { packInstances } from "./stages/assemble";
import { blocksStage } from "./stages/blocks";
import { buildingsStage } from "./stages/buildings";
import { derivedStage } from "./stages/derived";
import { gradingStage } from "./stages/grading";
import { hydrologyStage } from "./stages/hydrology";
import { lotsStage } from "./stages/lots";
import { social } from "./stages/social";
import { terrainStage } from "./stages/terrain";
import { type PipelineContext, gridOf } from "./stages/types";
import { zoningStage } from "./stages/zoning";

/**
 * Composes the eleven stages into a `CityModel`.
 *
 * Each stage gets its own RNG stream keyed by its label, so adding a draw in
 * one stage cannot shift another's sequence — that independence is what makes
 * a per-stage hash meaningful. A golden-hash failure therefore names the first
 * divergent stage rather than just reporting that the city changed.
 *
 * Ten of the eleven are hashed and all eleven are reported, which is why
 * `STAGE_NAMES` and `PROGRESS_STEPS` are separate lists: `assemble` produces the
 * instance buffers rather than a stage output of its own, and those are already
 * covered by the `buildings` hash.
 */

/** Internal: `GenerateOptions` is the surface a caller names. */
type ProgressCallback = (stageIndex: number) => void;

const noop: ProgressCallback = () => undefined;
const ignore: DiscardObserver = () => undefined;

/**
 * Everything the caller may watch, none of which it may steer.
 *
 * An object rather than more positional callbacks because a third thing to
 * observe is one field away, and because `generateCity(params, fn)` gave no
 * hint which callback `fn` was. Both default to doing nothing, so the engine
 * runs identically whether anyone is listening.
 */
export interface GenerateOptions {
  readonly onProgress?: ProgressCallback;
  /** See `DiscardObserver`: the engine calls this and never reads it back. */
  readonly onDiscard?: DiscardObserver;
}

/**
 * Canonical bytes for the zoning stage: one district *index* per block.
 *
 * Exported so the collision this replaced stays tested. Hashing the district
 * name's length instead made `casino`/`luxury`/`suburb` (all six characters)
 * and `corporate`/`megablock` (both nine) indistinguishable, so this stage's
 * hash could not localise exactly the reassignments it exists to localise.
 */
export const zoningStageBytes = (
  blocks: readonly { readonly district: DistrictKind }[]
): Uint8Array =>
  byteWriter()
    .u32Array(
      Uint32Array.from(blocks.map((b) => DISTRICT_KINDS.indexOf(b.district)))
    )
    .finish();

/** Canonical bytes for one field, length-prefixed. */
const fieldBytes = (data: Float32Array): Uint8Array =>
  byteWriter().f32Array(data).finish();

export const generateCity = (
  rawParams: GenerationParams,
  options: GenerateOptions = {}
): CityModel => {
  const onProgress = options.onProgress ?? noop;
  const forward = options.onDiscard ?? ignore;
  // Recorded on the way past, so the model carries the same account the observer
  // streams. Recorded first, so a caller observer that throws cannot leave the
  // model disagreeing with what the stages actually reported.
  const collected: Discard[] = [];
  const onDiscard: DiscardObserver = (discard) => {
    collected.push(discard);
    forward(discard);
  };
  // The schema is the boundary: a caller (or a postMessage) cannot smuggle an
  // out-of-range grid past this point.
  const params = generationParamsSchema.parse(rawParams);
  const grid = gridOf(params);
  const master = masterSeed(params.seed);
  const streamFor = (name: StageName) => stageStream(master, name);
  // Indexed into `PROGRESS_STEPS`, not `STAGE_NAMES`: the reported vocabulary has
  // an `assemble` step the hash vocabulary does not. The first ten indices agree.
  const report = (name: ProgressStep): void => {
    onProgress(PROGRESS_STEPS.indexOf(name));
  };

  report("terrain");
  const elevation = terrainStage(grid, streamFor("terrain"));

  report("hydrology");
  const terrain = hydrologyStage(elevation, streamFor("hydrology"));

  report("derived");
  const derived = derivedStage(terrain, streamFor("derived"));

  report("anchors");
  const anchorSet = anchors({ grid, derived }, streamFor("anchors"));

  report("social");
  const socialFields = social(
    { grid, terrain, derived, anchors: anchorSet },
    streamFor("social")
  );

  const fields: FieldStack = { ...derived, ...socialFields };
  const context: PipelineContext = {
    params,
    grid,
    terrain,
    derived,
    anchors: anchorSet,
    fields,
  };

  report("arterials");
  const roads = arterialsStage(
    { grid, terrain, derived, anchors: anchorSet },
    streamFor("arterials"),
    onDiscard
  );

  report("blocks");
  const blockLayer = blocksStage(
    { grid, terrain, derived, social: socialFields, roads },
    streamFor("blocks"),
    onDiscard
  );

  report("zoning");
  const zonedBlocks = zoningStage({ context, blockLayer }, streamFor("zoning"));

  report("lots");
  const lotLayer = lotsStage(
    {
      blocks: zonedBlocks,
      blockPolygons: blockLayer.polygons,
      grid,
      roads: blockLayer.roads,
    },
    streamFor("lots")
  );

  // Earthworks before anything is built on them. This produces levels, not a new
  // elevation field (ADR-0028), so nothing upstream is invalidated and `buildings`
  // is the only stage that has to know.
  report("grading");
  const grading = gradingStage({
    grid,
    elevation: terrain.elevation,
    roads: lotLayer.roads,
    lotLayer,
    districtOf: new Map(zonedBlocks.map((b) => [b.id, b.district])),
  });

  report("buildings");
  const buildingLayer = buildingsStage(
    {
      context,
      blocks: zonedBlocks,
      lotLayer,
      roads: lotLayer.roads,
      grading,
    },
    streamFor("buildings")
  );

  report("assemble");
  const instances = packInstances(buildingLayer.buildings);

  // Per-stage bytes, in the fixed stage order, so a divergence is localised.
  const stageBytes: Readonly<Record<StageName, Uint8Array>> = {
    terrain: fieldBytes(elevation.data),
    hydrology: byteWriter()
      .f32Array(terrain.elevation.data)
      .u8Array(terrain.waterMask)
      .f64(terrain.seaLevelM)
      .finish(),
    derived: byteWriter()
      .f32Array(derived.slope.data)
      .f32Array(derived.distWater.data)
      .f32Array(derived.floodRisk.data)
      .finish(),
    anchors: byteWriter()
      .f64(anchorSet.cbd.x)
      .f64(anchorSet.cbd.y)
      .f64(anchorSet.casino.x)
      .f64(anchorSet.casino.y)
      .finish(),
    social: byteWriter()
      .f32Array(socialFields.centrality.data)
      .f32Array(socialFields.prestige.data)
      .f32Array(socialFields.decay.data)
      .finish(),
    arterials: byteWriter()
      .u32(roads.edges.length)
      .f32Array(roads.polylines.coords)
      .finish(),
    // The road graph is part of this stage's output, not just the polygons:
    // blocks emits the subdivision cuts as street edges. Hashing only the
    // polygons left that half unwitnessed — the streets could have vanished
    // entirely and every golden would still have passed.
    blocks: byteWriter()
      .u32(blockLayer.blocks.length)
      .f32Array(blockLayer.polygons.coords)
      .u32(blockLayer.roads.edges.length)
      .f32Array(blockLayer.roads.polylines.coords)
      .finish(),
    zoning: zoningStageBytes(zonedBlocks),
    // `frontageDir` is this stage's output too, and it decides which axis a
    // building squares up to. Hashing only the rings left it unwitnessed, so an
    // orientation regression born here would surface as a `buildings` hash
    // change and be localised to the wrong stage. The presence flag is separate
    // from the components because a null direction and a genuine (0, 0) must
    // not hash alike.
    //
    // The road graph is this stage's output as well, for the reason `blocks`
    // gives above: the alleys could stop being emitted entirely and, without
    // this, every golden would still pass.
    lots: byteWriter()
      .u32(lotLayer.lots.length)
      .f32Array(lotLayer.polygons.coords)
      .u32(lotLayer.roads.edges.length)
      .f32Array(lotLayer.roads.polylines.coords)
      .u8Array(
        Uint8Array.from(
          lotLayer.lots.map((lot) => (lot.frontageDir === null ? 0 : 1))
        )
      )
      .f32Array(
        Float32Array.from(
          lotLayer.lots.flatMap((lot) =>
            lot.frontageDir === null
              ? [0, 0]
              : [lot.frontageDir.x, lot.frontageDir.y]
          )
        )
      )
      .finish(),
    grading: byteWriter()
      .f32Array(grading.padZ)
      .u8Array(grading.padded)
      .f32Array(grading.roadZ)
      .finish(),
    buildings: byteWriter()
      .u32(buildingLayer.buildings.length)
      .f32Array(instances.corpoTower.matrices)
      .f32Array(instances.slumShack.matrices)
      .finish(),
  };

  const stageHashes: Readonly<Record<StageName, string>> = {
    terrain: hashBytes(stageBytes.terrain),
    hydrology: hashBytes(stageBytes.hydrology),
    derived: hashBytes(stageBytes.derived),
    anchors: hashBytes(stageBytes.anchors),
    social: hashBytes(stageBytes.social),
    arterials: hashBytes(stageBytes.arterials),
    blocks: hashBytes(stageBytes.blocks),
    zoning: hashBytes(stageBytes.zoning),
    lots: hashBytes(stageBytes.lots),
    grading: hashBytes(stageBytes.grading),
    buildings: hashBytes(stageBytes.buildings),
  };

  return {
    params,
    terrain,
    fields,
    anchors: anchorSet.anchors,
    roads: lotLayer.roads,
    blocks: zonedBlocks,
    blockPolygons: blockLayer.polygons,
    lots: lotLayer.lots,
    lotPolygons: lotLayer.polygons,
    grading,
    buildings: buildingLayer.buildings,
    instances,
    stageHashes,
    contentHash: hashConcat(STAGE_NAMES.map((name) => stageBytes[name])),
    discards: collected,
  };
};
