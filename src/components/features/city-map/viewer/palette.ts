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

import type { BuildingArchetype, RoadClass } from "@/entities/city";

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

/**
 * Bridges stay the one cool note in the night view: they are the terrain
 * showing through where the city had to span it.
 *
 * A `ROAD_LAMP` amber used to live here for the road lines. It went when the
 * roads became surfaces — a lamp colour on a hairline reads as a lit street,
 * the same colour on a whole carriageway reads as a glowing floor.
 */
export const ROAD_BRIDGE = 0x7fd4e8;

/**
 * The same idea in the plan, at the plan's volume.
 *
 * `ROAD_BRIDGE` used to serve both views, and the argument against that is
 * about the road family rather than about the map as a whole. A bridge is a
 * road. The four road tones below sit at CIE chroma 3.4 to 7.6 — nearly
 * neutral, deliberately — and dropping a chroma-27 cyan among them does not
 * read as "the road that crosses the water", it reads as something that is not
 * a road at all. (The map does hold louder colours than the cyan: the casino
 * pink is chroma 80 and luxury residence 59. Those are buildings, and they are
 * meant to shout. A road is not.)
 *
 * This halves the excursion, to chroma 17.6, while still clearing every colour
 * on the map by at least 24.8 CIE76 — nearest is the corpo towers' teal, which
 * no bridge is ever adjacent to. Cool, because a bridge is where the ground
 * stopped, but blue rather than violet: an a* push is what turns a cool grey
 * lavender, and purple is the one hue the design rules name outright.
 */
export const PLAN_ROAD_BRIDGE = 0x94b0cc;

/**
 * The road surface in the plan, one tone per class.
 *
 * Ordered by lightness, because that is the ordering the classes actually have:
 * a highway carries more than an avenue carries more than a street. Before
 * this, highway and avenue were the same hex separated only by opacity, so the
 * two loudest roads on the map were indistinguishable — and `alley`, which the
 * generator does not yet emit, had a colour waiting for it.
 *
 * Warm greys, not the sodium of the night lamps: in the plan a road is a
 * surface you read the city's structure from, not a light source.
 */
export const PLAN_ROAD: Readonly<Record<RoadClass, number>> = {
  // Greyer than the buildings they run between, but not grey. Two constraints
  // pull against each other and these values are where both are satisfied.
  //
  // Separation: `street` must stay clear of `detachedHouse`, which is the pair
  // that occurs most — streets cover about half the ground and detached houses
  // are the second most common archetype. Warmer road tones collide with it.
  //
  // Hue: the design system allows no pure achromatic grey, and greying the
  // roads far enough to clear the archetypes runs straight into that. Warm
  // means R >= G >= B, not merely R > B — the weaker reading admits a mauve.
  //
  // What the shipped values measure, all recomputable from the hexes below:
  // each is 8 or more warm (R - B), the classes step evenly apart at 13.6 /
  // 14.2 / 11.7 CIE76, and the closest any road comes to any archetype is 17.3
  // — highway against megabuilding.
  highway: 0xb2ab9e,
  avenue: 0x8d8880,
  street: 0x6d6565,
  alley: 0x514949,
};

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
