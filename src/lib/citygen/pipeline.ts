import {
  type CityModel,
  DISTRICT_KINDS,
  type DistrictKind,
  type FieldStack,
  type GenerationParams,
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
 */

export type ProgressCallback = (stageIndex: number) => void;

const noop: ProgressCallback = () => undefined;

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
  onProgress: ProgressCallback = noop
): CityModel => {
  // The schema is the boundary: a caller (or a postMessage) cannot smuggle an
  // out-of-range grid past this point.
  const params = generationParamsSchema.parse(rawParams);
  const grid = gridOf(params);
  const master = masterSeed(params.seed);
  const streamFor = (name: StageName) => stageStream(master, name);
  const report = (name: StageName): void => {
    onProgress(STAGE_NAMES.indexOf(name));
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
    streamFor("arterials")
  );

  report("blocks");
  const blockLayer = blocksStage(
    { grid, terrain, derived, social: socialFields, roads },
    streamFor("blocks")
  );

  report("zoning");
  const zonedBlocks = zoningStage({ context, blockLayer }, streamFor("zoning"));

  report("lots");
  const lotLayer = lotsStage(
    { blocks: zonedBlocks, blockPolygons: blockLayer.polygons },
    streamFor("lots")
  );

  report("buildings");
  const buildingLayer = buildingsStage(
    { context, blocks: zonedBlocks, lotLayer, roads: blockLayer.roads },
    streamFor("buildings")
  );

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
    blocks: byteWriter()
      .u32(blockLayer.blocks.length)
      .f32Array(blockLayer.polygons.coords)
      .finish(),
    zoning: zoningStageBytes(zonedBlocks),
    lots: byteWriter()
      .u32(lotLayer.lots.length)
      .f32Array(lotLayer.polygons.coords)
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
    buildings: hashBytes(stageBytes.buildings),
  };

  return {
    params,
    terrain,
    fields,
    anchors: anchorSet.anchors,
    roads: blockLayer.roads,
    blocks: zonedBlocks,
    blockPolygons: blockLayer.polygons,
    lots: lotLayer.lots,
    lotPolygons: lotLayer.polygons,
    buildings: buildingLayer.buildings,
    instances,
    stageHashes,
    contentHash: hashConcat(STAGE_NAMES.map((name) => stageBytes[name])),
  };
};
