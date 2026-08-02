import {
  BUILDING_ARCHETYPES,
  type BuildingArchetype,
  type CityModel,
} from "@/entities/city";
import { PLAN_ARCHETYPE } from "./viewer/palette";
import { swatchStyle } from "./swatchStyle";

/**
 * The key to the plan view's district colours.
 *
 * Not decoration and not optional: the plan encodes six categories as six
 * hues, and the design system forbids colour as the sole carrier of meaning.
 * Without this the map is pretty and unreadable — you can see there are three
 * kinds of orange thing and not learn what any of them is.
 *
 * It carries the per-district counts as well, because that is the question the
 * simulator exists to answer — how much of each kind did this seed build —
 * and a key that also reports it earns its space twice.
 */

const LABELS: Readonly<Record<BuildingArchetype, string>> = {
  megabuilding: "Megabuilding",
  corpoTower: "Corpo tower",
  casino: "Casino",
  luxuryResidence: "Luxury residence",
  detachedHouse: "Detached house",
  slumShack: "Slum",
};

// similarity-ignore: same shape as RoadLegendProps, kept separate on purpose — see the note there
interface DistrictLegendProps {
  readonly model: CityModel;
}

export function DistrictLegend({ model }: DistrictLegendProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="font-medium text-xs">Districts</h2>
      {/*
        Each role is anchored rather than laid out by content width: the swatch
        is a fixed size, the count is pushed to the right edge. So a long name
        like "Luxury residence" cannot shunt its count out of line with the
        rest — every row's three parts land on the same two verticals.
      */}
      <dl className="flex flex-col gap-1 text-xs">
        {BUILDING_ARCHETYPES.map((archetype) => (
          <div key={archetype} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-xs"
              style={swatchStyle(PLAN_ARCHETYPE[archetype])}
            />
            <dt className="text-muted-foreground">{LABELS[archetype]}</dt>
            <dd className="ml-auto font-mono tabular-nums">
              {model.instances[archetype].count}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
