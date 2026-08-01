/**
 * The scene's colour decisions, in one place.
 *
 * The reflexive cyberpunk palette is teal-and-magenta, which is the
 * blue-to-purple default wearing a genre costume, and the reflexive dark base
 * is a cool blue-charcoal. Both were in the first pass here and both are the
 * look every generated night city has.
 *
 * This is the other reading: a city lit by **sodium vapour**. Warm amber window
 * light and street lamps against 漆黒 (shikkoku, lacquer black), the way an
 * actual dense Japanese city looks from above at night — overwhelmingly warm,
 * not blue. The saturated colour appears exactly once, on the casino strip, so
 * it reads as an intrusion rather than as the ambient grade.
 *
 * Kept as linear-ish sRGB hex for three's colour management.
 */

import type { BuildingArchetype } from "@/entities/city";

/** 漆黒 — the ink everything sits on. Warm-biased, never a blue charcoal. */
export const LACQUER = 0x0b0906;

/** The sky directly overhead: still lacquer, barely lifted. */
export const SKY_ZENITH = 0x120e0a;

/** The horizon haze: sodium bounce off low cloud. This is the atmosphere. */
export const SKY_HORIZON = 0x3a2413;

/** Ground that no light reaches. */
export const TERRAIN_SHADOW = 0x14100c;

/** Ground under street lighting. */
export const TERRAIN_LIT = 0x3d3327;

/** Water reads as an absence: it reflects nothing back at this exposure. */
export const WATER_DEEP = 0x06070a;
export const WATER_RIVER = 0x0a0c10;

/** Window light. Sodium, with a slight green cast from fluorescent interiors. */
export const WINDOW_SODIUM = 0xffb454;
export const WINDOW_FLUORESCENT = 0xd8e0b0;

/** Road light: cooler than windows so the network reads as separate from mass. */
export const ROAD_LAMP = 0xffd9a0;
export const ROAD_BRIDGE = 0x7fd4e8;

/**
 * The plan view's ink set — a separate palette, not a brightened night one.
 *
 * The top-down view is a *drawing*, and it has a different job: say which
 * district is where. The night palette cannot do that from above, because a
 * roof has no windows — every archetype's roof is the same near-black, so the
 * whole map reduced to one dark smear.
 *
 * So the plan gets hues. Six of them, spread far enough apart to be told apart
 * at a glance but held to earth pigment rather than a spectrum: the set is warm
 * and mineral, with one cool note for the corpos and one magenta for the
 * casino. The magenta is the only role both palettes share — the night view
 * gives the strip its own lighter window tint rather than this exact hex, so
 * what carries across is the intrusion, not the value.
 *
 * Chroma runs *inversely* to how common the thing is. On akiba-01 the slums are
 * 4539 of 5798 buildings and the megabuildings are 4, so a slum that shouts
 * makes a map of nothing but slums, while a landmark that whispers cannot be
 * found at all. The two bulk categories are therefore the quietest — barely
 * lifted off the ground they sit on — and the rare, load-bearing ones carry the
 * saturation. Reading order falls out of it: you find the four megabuildings
 * first, then the strip, then the corporate core, and the periphery is texture.
 *
 * The names are the traditional pigments the hues are taken *after*; these are
 * not the canonical 和色 hex values, which sit too light to hold on lacquer.
 */
export const PLAN_ARCHETYPE = {
  /** 胡粉 — shell white. Four of them on the whole map; the brightest thing on it. */
  megabuilding: 0xe4d9c4,
  /** 錆浅葱 — the one cool note, for the one cold institution. */
  corpoTower: 0x4e8288,
  /** 躑躅 — the loudest thing in the set, and the only saturated one. */
  casino: 0xff2d6f,
  /** 金茶 — gold on the ridges. Rare enough to be allowed to glint. */
  luxuryResidence: 0xcf9a34,
  /** 利休茶 — 962 of them. The quiet middle, and it stays quiet. */
  detachedHouse: 0x6e6647,
  /** 弁柄 — iron oxide, the cheapest pigment there is, on the commonest thing. */
  slumShack: 0x6d4030,
} as const satisfies Record<BuildingArchetype, number>;

/**
 * Plan terrain: a topographic ramp, and a much wider one than the night view's.
 *
 * Unlit on purpose. Under the night rig — deliberately weak, because the
 * windows are meant to carry the image — a lit ground plane crushes to black
 * from above, and the fix would have to be brighter lights, which would wreck
 * the view the rig exists for. Unlit means an elevation maps to exactly the
 * colour chosen for it, which is what a topographic ramp is supposed to
 * promise. Relief reads from the ramp instead of from shading.
 */
export const PLAN_LAND_LOW = 0x14110e;
export const PLAN_LAND_HIGH = 0x4a4238;
export const PLAN_OCEAN = 0x0c141d;
export const PLAN_RIVER = 0x1b3348;

/**
 * Fog: exponential-squared on distance.
 *
 * Height-based haze pooling in the low ground would be the better effect here —
 * the design puts the slums in the floodplain, so fog that settles by altitude
 * would put the social geography into the atmosphere. That needs a custom
 * `fogNode`; this is the distance version, which is what is actually built.
 */
export const FOG = {
  color: 0x2a1a10,
  density: 0.00042,
} as const;

/**
 * sRGB hex to a linear RGB triple.
 *
 * Needed wherever a colour is built as a raw vector instead of through three's
 * `Color`/`color()` path, which would do this conversion itself. Skipping it
 * makes every light in the scene read washed out and too bright.
 */
const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

export const linearRgb = (hex: number): readonly [number, number, number] => [
  toLinear(((hex >> 16) & 0xff) / 255),
  toLinear(((hex >> 8) & 0xff) / 255),
  toLinear((hex & 0xff) / 255),
];
