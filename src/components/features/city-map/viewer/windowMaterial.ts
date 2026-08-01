import * as THREE from "three/webgpu";
import {
  float,
  fract,
  mix,
  positionWorld,
  sin,
  smoothstep,
  step,
  vec3,
} from "three/tsl";
import type { BuildingArchetype } from "@/entities/city";
import { WINDOW_FLUORESCENT, WINDOW_SODIUM, linearRgb } from "./palette";

/**
 * Procedural window light for the building instances.
 *
 * The grid is derived from **world** position, not UV. A UV grid gives every
 * box the same number of windows, so a 300 m tower and a 3 m shack would each
 * get, say, twelve floors — the tower's windows enormous, the shack's
 * microscopic. Pitching in metres instead means a floor is a floor everywhere,
 * which is what makes the height difference between districts legible.
 *
 * Occupancy is hashed from the floor and column indices, so the same building
 * always has the same lights on: the city does not shimmer when the camera
 * moves, and a screenshot of a seed is reproducible.
 */

/** Metres. A storey, and a window bay. */
const FLOOR_PITCH_M = 3.6;
const BAY_PITCH_M = 4.2;

interface WindowStyle {
  /** Fraction of bays that are dark. Higher reads as emptier, later at night. */
  readonly vacancy: number;
  /** Tint of the lit bays. */
  readonly warm: number;
  readonly cool: number;
  /** How much of the lit set takes the cool tint. */
  readonly coolMix: number;
  readonly intensity: number;
  readonly base: number;
  readonly roughness: number;
}

/**
 * Per-archetype occupancy is the point, not decoration: a corporate tower burns
 * most of its floors at 2am, a suburban house shows one or two rooms, and a
 * shack is a single bulb. That contrast is what makes the districts read from
 * the air without any labelling.
 */
const STYLES: Readonly<Record<BuildingArchetype, WindowStyle>> = {
  megabuilding: {
    vacancy: 0.42,
    warm: WINDOW_SODIUM,
    cool: WINDOW_FLUORESCENT,
    coolMix: 0.55,
    intensity: 1.5,
    base: 0x14131a,
    roughness: 0.82,
  },
  corpoTower: {
    vacancy: 0.28,
    warm: WINDOW_SODIUM,
    cool: WINDOW_FLUORESCENT,
    coolMix: 0.7,
    intensity: 2.1,
    base: 0x0f1116,
    roughness: 0.32,
  },
  casino: {
    vacancy: 0.05,
    warm: 0xff5c92,
    cool: 0xffc46b,
    coolMix: 0.35,
    intensity: 3.4,
    base: 0x1d0d16,
    roughness: 0.38,
  },
  luxuryResidence: {
    vacancy: 0.55,
    warm: WINDOW_SODIUM,
    cool: 0xffe0b0,
    coolMix: 0.15,
    intensity: 1.15,
    base: 0x1a1712,
    roughness: 0.6,
  },
  detachedHouse: {
    vacancy: 0.68,
    warm: WINDOW_SODIUM,
    cool: 0xffd9a0,
    coolMix: 0.1,
    intensity: 0.9,
    base: 0x17150f,
    roughness: 0.88,
  },
  slumShack: {
    vacancy: 0.5,
    warm: 0xff9b3d,
    cool: 0xbfe0d0,
    coolMix: 0.12,
    intensity: 0.75,
    base: 0x120e09,
    roughness: 1,
  },
};

/**
 * A float-valued TSL node. Derived from a real one rather than written out:
 * `float()` returns a VarNode, which is narrower than what `.floor()` yields,
 * so naming either concrete type here would reject the other.
 */
type FloatNode = typeof positionWorld.x;

/** Deterministic 0..1 from two integers. Trig is fine here — viewer, not engine. */
const hash2 = (a: FloatNode, b: FloatNode): FloatNode =>
  fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453));

export const createWindowMaterial = (
  archetype: BuildingArchetype
): THREE.MeshStandardNodeMaterial => {
  const style = STYLES[archetype];

  // Bay index runs on x+z so both visible facades get columns without needing
  // per-face UVs; the diagonal banding this produces reads as facade variation
  // rather than as an artefact at city scale.
  const bay = positionWorld.x.add(positionWorld.z).div(BAY_PITCH_M);
  const storey = positionWorld.y.div(FLOOR_PITCH_M);

  const withinBay = fract(bay);
  const withinStorey = fract(storey);

  // The pane is the middle of each cell; the gap is the mullion and the floor
  // slab. Slabs are thicker than mullions, as they are in a real facade.
  const paneX = smoothstep(float(0.16), float(0.26), withinBay).mul(
    smoothstep(float(0.84), float(0.74), withinBay)
  );
  const paneY = smoothstep(float(0.26), float(0.36), withinStorey).mul(
    smoothstep(float(0.8), float(0.7), withinStorey)
  );
  const pane = paneX.mul(paneY);

  const occupancy = hash2(bay.floor(), storey.floor());
  const lit = step(float(style.vacancy), occupancy);

  // A second hash decides tint, so warm and cool bays interleave irregularly
  // instead of alternating.
  const tintPick = hash2(storey.floor(), bay.floor().add(17));
  const warm = linearRgb(style.warm);
  const cool = linearRgb(style.cool);
  const tint = mix(
    vec3(warm[0], warm[1], warm[2]),
    vec3(cool[0], cool[1], cool[2]),
    step(float(1 - style.coolMix), tintPick)
  );

  const material = new THREE.MeshStandardNodeMaterial({
    color: style.base,
    roughness: style.roughness,
    metalness: 0.1,
  });
  material.emissiveNode = tint.mul(pane).mul(lit).mul(float(style.intensity));
  return material;
};
