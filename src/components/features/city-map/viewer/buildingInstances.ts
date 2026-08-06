import * as THREE from "three/webgpu";
import {
  BUILDING_ARCHETYPES,
  type BuildingArchetype,
  type CityModel,
} from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import { KIT_ASSET } from "./kit/manifest";
import { createKitMeshes, type KitMeshes } from "./kit/kitMeshes";
import { PLAN_ARCHETYPE } from "./palette";
import { createWindowMaterial } from "./windowMaterial";

/**
 * One `InstancedMesh` per archetype, fed straight from the worker's packed
 * matrices — plus, for the archetypes that have one, a kit of authored parts
 * drawn over the top in the 3D view (ADR-0029).
 *
 * The matrices are composed in the worker (trig-free, from `facing` unit
 * vectors) so that nothing here does generator maths on the massing: this
 * uploads that buffer and nothing else. The kit is the exception the ADR
 * carves, and it is a different job — it dresses a massing already decided,
 * from part sizes measured off the asset, and it composes its own matrices in
 * `kit/expandKit.ts`. Megabuilding tiers arrive as additional instances in the
 * same box buffer rather than as a separate mesh.
 *
 * Grouping by archetype is what makes the plan view cheap: the district colour
 * is a property of the mesh, so switching views swaps six materials rather than
 * touching any per-instance data. The plan keeps the boxes whatever the kit is
 * doing — a plan drawing states the category, not the architecture.
 */

export interface BuildingInstancesResult {
  readonly group: THREE.Group;
  readonly setViewMode: (mode: CityViewMode) => void;
  readonly dispose: () => void;
}

/**
 * Flat, unlit district fill. A plan drawing states the category and nothing
 * else — no shading to read a roof's height off, because height is the 3D
 * view's job and guessing it from a top-down tone is not.
 */
const createPlanMaterial = (archetype: BuildingArchetype) =>
  new THREE.MeshBasicNodeMaterial({ color: PLAN_ARCHETYPE[archetype] });

interface ArchetypeEntry {
  readonly materials: Readonly<Record<CityViewMode, THREE.Material>>;
  readonly mesh: THREE.InstancedMesh | null;
  readonly kit: KitMeshes | null;
  /** Mutable: the kit lands after this function has returned, or never. */
  readonly loaded: { value: boolean };
}

export const createBuildingInstances = (
  model: CityModel
): BuildingInstancesResult => {
  const group = new THREE.Group();
  group.name = "buildings";

  // A unit box centred on its own base, so an instance matrix only has to
  // scale and place it — no half-height correction at upload time.
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);

  // The mode the scene is in, so a kit that lands mid-session is shown or
  // hidden according to where the camera already is rather than to a default.
  const state = { mode: "3d" as CityViewMode };

  const built: readonly ArchetypeEntry[] = BUILDING_ARCHETYPES.map(
    (archetype) => {
      // Widened to `Material` so the mesh's material slot accepts either reading;
      // narrowing to the night type would pin the slot to it.
      const materials: Readonly<Record<CityViewMode, THREE.Material>> = {
        "2d": createPlanMaterial(archetype),
        "3d": createWindowMaterial(archetype),
      };
      const buffer = model.instances[archetype];
      const loaded = { value: false };
      if (buffer.count === 0) {
        return { materials, mesh: null, kit: null, loaded };
      }

      const mesh = new THREE.InstancedMesh(
        geometry,
        materials["3d"],
        buffer.count
      );
      mesh.name = archetype;
      mesh.instanceMatrix.array.set(
        buffer.matrices.subarray(0, buffer.count * 16)
      );
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);

      const assetUrl = KIT_ASSET[archetype];
      if (assetUrl === null) {
        return { materials, mesh, kit: null, loaded };
      }
      const kit = createKitMeshes(
        model.buildings.filter((building) => building.archetype === archetype),
        assetUrl,
        materials["3d"],
        () => {
          loaded.value = true;
          applyMode(state.mode);
        }
      );
      kit.group.visible = false;
      group.add(kit.group);
      return { materials, mesh, kit, loaded };
    }
  );

  /**
   * Idempotent, because the render loop calls it every frame rather than on the
   * transition — the caller keeps no "which mode is this in" bookkeeping of its
   * own, and neither does the kit's arrival.
   */
  function applyMode(mode: CityViewMode): void {
    built.forEach(({ materials, mesh, kit, loaded }) => {
      const kitDrawn = kit !== null && loaded.value && mode === "3d";
      if (mesh !== null) {
        mesh.material = materials[mode];
        // The box is what the plan draws, and what the 3D view draws until the
        // kit lands — so a slow asset is a plain city, never a missing one.
        mesh.visible = !kitDrawn;
      }
      if (kit !== null) {
        kit.group.visible = kitDrawn;
        kit.setMaterial(materials[mode]);
      }
    });
  }

  return {
    group,
    setViewMode: (mode: CityViewMode) => {
      state.mode = mode;
      applyMode(mode);
    },
    dispose: () => {
      geometry.dispose();
      built.forEach(({ materials, kit }) => {
        kit?.dispose();
        materials["2d"].dispose();
        materials["3d"].dispose();
      });
    },
  };
};
