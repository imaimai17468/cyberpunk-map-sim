import { ROAD_CLASSES, type RoadClass, type CityModel } from "@/entities/city";
import { ROAD_WIDTH_M } from "@/lib/citygen/constants";
import { PLAN_ROAD, PLAN_ROAD_BRIDGE } from "./viewer/palette";
import { swatchStyle } from "./swatchStyle";

/**
 * The key to the plan view's road tones.
 *
 * Four greys separated only by lightness need a key more than the district
 * hues do, and the design system forbids colour as the sole carrier of meaning.
 * Carrying the carriageway width alongside says what the tone *means* — the
 * roads are drawn at those widths, so the number is the legend for the
 * thickness as much as the swatch is for the colour.
 *
 * Classes the seed did not produce are shown greyed rather than dropped: an
 * absent alley is information about this city, and a legend that silently
 * omits a row makes two seeds look like two different products.
 */

const LABELS: Readonly<Record<RoadClass, string>> = {
  highway: "Highway",
  avenue: "Avenue",
  street: "Street",
  alley: "Alley",
};

/**
 * Identical in shape to `DistrictLegendProps` and deliberately not shared. The
 * two legends answer different questions — one about what was built, one about
 * what connects it — so a common `LegendProps` would make either one's prop
 * list the other's business. They agree only because both happen to need the
 * whole model today.
 */
// similarity-ignore: same shape as DistrictLegendProps, kept separate on purpose — see above
interface RoadLegendProps {
  readonly model: CityModel;
}

export function RoadLegend({ model }: RoadLegendProps) {
  const counts = model.roads.edges.reduce<Partial<Record<RoadClass, number>>>(
    (acc, edge) => {
      acc[edge.cls] = (acc[edge.cls] ?? 0) + 1;
      return acc;
    },
    {}
  );
  const bridges = model.roads.edges.filter(
    (edge) => edge.crossing === "bridge"
  ).length;

  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="font-medium text-xs">Roads</h2>
      <dl className="flex flex-col gap-1 text-xs">
        {ROAD_CLASSES.map((cls) => {
          const count = counts[cls] ?? 0;
          return (
            <div
              key={cls}
              className={`flex items-center gap-2 ${count === 0 ? "opacity-40" : ""}`}
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-xs"
                style={swatchStyle(PLAN_ROAD[cls])}
              />
              <dt className="text-muted-foreground">{LABELS[cls]}</dt>
              <dd className="ml-auto font-mono tabular-nums">
                {ROAD_WIDTH_M[cls]} m
              </dd>
            </div>
          );
        })}
        {/*
          Bridges are the one row that is not a class. They keep whichever width
          their class gives them, so the column carries a count instead — and
          says "crossings", because a bare number in the column every other row
          fills with metres is read as a width.
        */}
        <div
          className={`flex items-center gap-2 ${bridges === 0 ? "opacity-40" : ""}`}
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-xs"
            style={swatchStyle(PLAN_ROAD_BRIDGE)}
          />
          <dt className="text-muted-foreground">Bridge</dt>
          <dd className="ml-auto font-mono tabular-nums">
            {bridges} crossing{bridges === 1 ? "" : "s"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
