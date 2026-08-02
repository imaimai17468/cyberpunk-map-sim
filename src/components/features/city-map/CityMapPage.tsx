import { Button } from "@/components/ui/button";
import { STAGE_NAMES } from "@/entities/city";
import { DistrictLegend } from "./DistrictLegend";
import { MapStatus } from "./MapStatus";
import { RoadLegend } from "./RoadLegend";
import { SeedControls } from "./SeedControls";
import { ViewModeToggle } from "./ViewModeToggle";
import { isModelStale } from "./cityModelMachine";
import { useCityModel } from "./useCityModel";
import { SceneCanvas } from "./viewer/SceneCanvas";

/**
 * The map simulator screen, and the whole application.
 *
 * The city fills the viewport and everything else floats on it. That is the
 * arrangement the content asks for: the generated city is the only thing worth
 * looking at, so it gets the frame, and the controls become small objects
 * resting on top rather than a column competing with it for width.
 *
 * The panel is pinned to the full height with a deliberate margin on every
 * side, and its contents are sized to fit rather than to scroll — the slack
 * lives in one spacer between the form and the readouts, which absorbs
 * whatever height is left over. The panel can still scroll if a viewport is
 * short enough to leave no slack at all; that is a last resort against
 * clipping content, not the intended reading.
 *
 * Every content state the design system requires is a distinct phase of the
 * verified lifecycle machine rather than an ad-hoc boolean, so "loading",
 * "empty", "error" and "populated" cannot drift out of sync with what the
 * worker is actually doing.
 */

const DEFAULT_PARAMS = { seed: "akiba-01", sizeM: 2048, cells: 512 } as const;

const BUSY_PHASES = new Set(["generating", "regenerating"]);

export function CityMapPage() {
  const city = useCityModel({ ...DEFAULT_PARAMS });
  const { state } = city;
  const busy = BUSY_PHASES.has(state.phase);
  const rendererDead =
    state.phase === "unsupported" || state.phase === "initFailed";
  const model = state.model;

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {rendererDead ? (
        <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-prose text-foreground text-sm">
            {state.lastError ?? "The renderer is unavailable."}
          </p>
          {state.phase === "initFailed" ? (
            <Button type="button" onClick={city.retryInit}>
              Retry
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              This browser exposes neither WebGPU nor WebGL2, so the city cannot
              be drawn.
            </p>
          )}
        </div>
      ) : (
        <div className="absolute inset-0">
          <SceneCanvas
            model={model}
            viewMode={state.viewMode}
            onRendererReady={city.onRendererReady}
            onNoBackend={city.onNoBackend}
            onInitFailed={city.onInitFailed}
          />
        </div>
      )}

      {/* Centred in the space the reader can actually see, which is a different
          space on each side of the panel's own breakpoint: a column to the
          right of it on desktop, and the strip below it on mobile, whose height
          is the `bottom-72` the panel stops short by. Offsetting only from the
          left was wrong twice over — it left 38px of a 390px screen, and once
          widened it put the message underneath the panel instead. */}
      {model === null && !rendererDead ? (
        <div className="pointer-events-none absolute right-0 bottom-0 left-0 flex h-72 items-center justify-center p-6 sm:inset-y-0 sm:left-88 sm:h-auto">
          <p className="text-muted-foreground text-sm">
            {state.phase === "booting"
              ? "Starting the renderer…"
              : busy
                ? `Generating ${STAGE_NAMES[state.stageIndex] ?? "the city"}`
                : "Press Generate to build a city."}
          </p>
        </div>
      ) : null}

      {/*
        Narrow viewports get the panel across the top with the map below it,
        rather than a 320px column over a 390px screen. It stops short of the
        bottom on purpose: the status readout is pinned down there, and at that
        width the two would otherwise overlap and the readout would sit on top
        of the last legend row, hiding a number.
      */}
      <aside className="map-surface absolute top-4 right-4 bottom-72 left-4 flex flex-col gap-4 overflow-y-auto rounded-lg p-4 sm:inset-y-4 sm:right-auto sm:w-80">
        <div className="flex flex-col gap-1">
          <h1 className="font-medium text-base tracking-tight">
            Cyberpunk city generator
          </h1>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Terrain decides everything: towers where travel is cheap, slums in
            the floodplain.
          </p>
        </div>

        <SeedControls
          params={state.formParams}
          busy={busy}
          canGenerate={!rendererDead && state.phase !== "booting"}
          stale={isModelStale(state)}
          onParamsChange={city.setParams}
          onGenerate={city.generate}
          onCancel={city.cancel}
        />

        {/* The slack. Everything below sits against the bottom of the panel
            until the viewport runs out of room to give. */}
        <div className="min-h-0 flex-1" />

        {model !== null ? (
          <div className="flex flex-col gap-3">
            <dl className="flex flex-col gap-1 text-xs">
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Buildings</dt>
                <dd className="ml-auto font-mono tabular-nums">
                  {model.buildings.length}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Blocks</dt>
                <dd className="ml-auto font-mono tabular-nums">
                  {model.blocks.length}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Roads</dt>
                <dd className="ml-auto font-mono tabular-nums">
                  {model.roads.edges.length}
                </dd>
              </div>
            </dl>

            {/* The key belongs to the plan; the night view encodes district as
                silhouette and window pattern, not as flat colour. */}
            {state.viewMode === "2d" ? (
              <>
                <DistrictLegend model={model} />
                <RoadLegend model={model} />
              </>
            ) : null}
          </div>
        ) : null}
      </aside>

      {/* Bottom-left on narrow screens, where the panel owns the top of the
          viewport and this would otherwise sit on it, one translucent surface
          stacked on another. */}
      <div className="absolute bottom-4 left-4 sm:top-4 sm:right-4 sm:bottom-auto sm:left-auto">
        <ViewModeToggle
          viewMode={state.viewMode}
          disabled={rendererDead}
          onViewModeChange={city.setViewMode}
        />
      </div>

      <div className="absolute right-4 bottom-4">
        <MapStatus state={state} />
      </div>
    </main>
  );
}
