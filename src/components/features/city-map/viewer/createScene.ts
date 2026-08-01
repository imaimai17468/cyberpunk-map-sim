import * as THREE from "three/webgpu";
import { mix, screenUV, vec3 } from "three/tsl";
import type { CityModel } from "@/entities/city";
import type { CityViewMode } from "../cityModelMachine";
import { createBuildingInstances } from "./buildingInstances";
import { FOG, LACQUER, SKY_HORIZON, SKY_ZENITH, linearRgb } from "./palette";
import { createRoadLines } from "./roadLines";
import { createTerrainMesh } from "./terrainMesh";

/**
 * Builds the whole scene for one `CityModel`.
 *
 * The scene is a dumb consumer: nothing here recomputes generator maths. It is
 * rebuilt wholesale per model and disposed as a unit, which is what lets the
 * lifecycle machine treat "swap the model" as one atomic step with an explicit
 * release of the previous GPU resources.
 */

export interface CityScene {
  readonly scene: THREE.Scene;
  /** Identity for cache keys that must invalidate when the model is swapped. */
  readonly id: number;
  /**
   * The two views are two renderings of one model, not one rendering seen from
   * two angles: the plan swaps in flat district fills, a topographic ground
   * ramp, and no fog.
   *
   * Fog is the clearest case. It conveys distance, and an orthographic map has
   * none to convey — every roof is the same distance away in any sense the
   * viewer cares about. Left on, the ortho camera's ~4 km height put the map
   * behind 95% haze.
   *
   * Idempotent: the render loop calls it every frame rather than on the
   * transition, so the caller has no "which mode is the scene in" bookkeeping
   * of its own to get wrong.
   */
  readonly setViewMode: (mode: CityViewMode) => void;
  readonly dispose: () => void;
}

const linearVec3 = (hex: number) => {
  const [r, g, b] = linearRgb(hex);
  return vec3(r, g, b);
};

/**
 * A vertical gradient standing in for sky, with dither.
 *
 * A flat fill behind the city leaves it floating in a void; this gives the
 * horizon somewhere to be. The dither matters as much as the gradient: an
 * 8-bit ramp across this little contrast bands into visible stripes, and a
 * banded gradient reads worse than no gradient at all. A hash of screen
 * position, scaled to well under one code value, breaks the steps up.
 *
 * It is screen-space, so it does not swing with the orbit camera. A real
 * skybox would; this is the cheap version and it is honest about being one.
 */
const skyBackground = () => {
  const t = screenUV.y.oneMinus();
  const ramp = mix(linearVec3(SKY_ZENITH), linearVec3(SKY_HORIZON), t.pow(2.2));
  const dither = screenUV
    .mul(vec3(443.8975, 397.2973, 491.1871).xy)
    .sin()
    .dot(vec3(12.9898, 78.233, 0).xy)
    .sin()
    .mul(43758.5453)
    .fract()
    .sub(0.5)
    .mul(1 / 255);
  return ramp.add(dither);
};

/**
 * Night lighting.
 *
 * Deliberately weak: at this hour the city is lit by its own windows, not by a
 * key light, and the emissive facades carry almost all of the visible energy.
 * The ambient exists only so unlit geometry is not pure black, and the single
 * directional is a low sodium bounce off the haze rather than a sun.
 */
const addLighting = (scene: THREE.Scene, sizeM: number): void => {
  const ambient = new THREE.AmbientLight(0x2a2118, 0.55);
  const bounce = new THREE.DirectionalLight(0xffb877, 0.35);
  bounce.position.set(sizeM * 0.3, sizeM * 0.18, sizeM * 0.45);
  scene.add(ambient, bounce);
};

/**
 * Two backgrounds, for the same reason there are two of everything else here.
 *
 * The gradient is a horizon, and an orthographic plan looking straight down has
 * no horizon to place — it read as an unexplained warm haze bleeding in from
 * the sides of the drawing. The plan gets flat lacquer, so the map plate has
 * one edge and the eye stays on it.
 */
const BACKGROUNDS = {
  "2d": () => linearVec3(LACQUER),
  "3d": skyBackground,
} as const;

export const createScene = (model: CityModel): CityScene => {
  const scene = new THREE.Scene();

  const terrain = createTerrainMesh(model);
  const roads = createRoadLines(model);
  const buildings = createBuildingInstances(model);

  /**
   * The generator works in world metres over `[0, sizeM]` with the origin at a
   * corner. Both cameras orbit and frame the origin, so the whole city is
   * re-centred exactly once here rather than by offsetting every coordinate at
   * every producer — one transform to get wrong instead of many.
   */
  const half = model.params.sizeM / 2;
  const root = new THREE.Group();
  root.name = "city";
  root.position.set(-half, 0, -half);
  root.add(terrain.mesh, roads.group, buildings.group);

  scene.add(root);
  addLighting(scene, model.params.sizeM);

  const fog = new THREE.FogExp2(FOG.color, FOG.density);

  const dress = (mode: CityViewMode): void => {
    scene.fog = mode === "3d" ? fog : null;
    scene.backgroundNode = BACKGROUNDS[mode]();
    terrain.setViewMode(mode);
    buildings.setViewMode(mode);
  };

  /**
   * The mode the scene is currently dressed for.
   *
   * The render loop calls `setViewMode` every frame, and rebuilding the
   * background node each time would allocate a TSL graph per frame. Tracking
   * the last mode makes the repeat calls free while keeping the entry point
   * idempotent for the caller.
   *
   * Dressed once here so a scene is never half-built between construction and
   * the first frame — the same reason `terrainMesh` binds a colour attribute up
   * front. `3d` because that is what the sub-builders already default to.
   */
  let current: CityViewMode = "3d";
  dress(current);

  return {
    scene,
    id: scene.id,
    setViewMode: (mode: CityViewMode) => {
      if (mode !== current) {
        current = mode;
        dress(mode);
      }
    },
    dispose: () => {
      terrain.dispose();
      roads.dispose();
      buildings.dispose();
      scene.clear();
    },
  };
};
