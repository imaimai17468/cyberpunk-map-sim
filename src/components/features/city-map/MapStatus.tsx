import { STAGE_NAMES } from "@/entities/city";
import type { CityModelState } from "./cityModelMachine";

/**
 * The one line that says what the machine is doing, parked in the corner.
 *
 * Split out of the page rather than inlined because the phase-to-sentence
 * mapping is a chain of cases and the page is already a layout; keeping it here
 * means the layout reads as a layout, and this reads as the list of things the
 * lifecycle can be.
 *
 * The box is width-bounded and the sentence truncates. Nothing here is
 * length-limited at the source — a seed is any string the user types, and it is
 * echoed back on the `ready` phase — and the wrapper sits inside an
 * `overflow-hidden` main, so an unbounded box would not wrap, it would grow
 * leftward until the page silently cut it off.
 */

const describe = (state: CityModelState): string => {
  if (state.phase === "generating" || state.phase === "regenerating") {
    const stage = STAGE_NAMES[state.stageIndex] ?? "";
    return `Stage ${state.stageIndex + 1} of ${STAGE_NAMES.length}: ${stage}`;
  }
  if (state.phase === "error") return state.lastError ?? "Generation failed.";
  if (state.phase === "ready") return `Seed ${state.modelParams?.seed ?? ""}`;
  return state.phase;
};

interface MapStatusProps {
  readonly state: CityModelState;
}

export function MapStatus({ state }: MapStatusProps) {
  return (
    <div className="map-surface flex max-w-xs items-center gap-3 rounded-lg px-3 py-2 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">
        {describe(state)}
      </span>
      {state.model !== null ? (
        // The content hash identifies the city exactly; it is data, so it is
        // set in mono, and it is the one place in the UI that mono is used for
        // something other than a number.
        <span className="shrink-0 font-mono text-muted-foreground">
          {state.model.contentHash}
        </span>
      ) : null}
    </div>
  );
}
