import type { BuildingArchetype } from "@/entities/city";
import corpoTowerUrl from "./assets/corpoTower.glb";

/**
 * Which archetypes are drawn from a kit of parts, and what the parts are called.
 *
 * Asset vocabulary, deliberately not in `entities/city` (ADR-0029): a part name
 * is a fact about a mesh someone authored, not about the city, and it has
 * component affinity — it exists to feed this viewer's instanced meshes.
 */

/** @public the const array is the single source of the union below; a new part is added here and every `Record` over it fails to compile until handled */
export const KIT_PARTS = ["base", "floor", "crown"] as const;
export type KitPart = (typeof KIT_PARTS)[number];

/**
 * The asset each archetype is dressed from, or null where it keeps its box.
 *
 * A total `Record` rather than a `Partial`, so adding a `BuildingArchetype` is a
 * compile error here rather than a building that silently keeps the box. Null is
 * the honest entry for the five archetypes whose proportions a single stretched
 * mesh already survives — ADR-0029 records the measurement.
 */
export const KIT_ASSET: Readonly<Record<BuildingArchetype, string | null>> = {
  corpoTower: corpoTowerUrl,
  megabuilding: null,
  casino: null,
  luxuryResidence: null,
  detachedHouse: null,
  slumShack: null,
};
