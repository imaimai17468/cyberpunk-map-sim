import { Button } from "@/components/ui/button";
import { STAGE_NAMES } from "@/entities/city";
import { SeedControls } from "./SeedControls";
import { isModelStale } from "./cityModelMachine";
import { useCityModel } from "./useCityModel";
import { SceneCanvas } from "./viewer/SceneCanvas";

/**
 * The map simulator screen.
 *
 * Every content state the design system requires is represented as a distinct
 * phase of the verified lifecycle machine rather than as ad-hoc booleans, so
 * "loading", "empty", "error" and "populated" cannot drift out of sync with
 * what the worker is actually doing.
 */

const DEFAULT_PARAMS = { seed: "akiba-01", sizeM: 2048, cells: 512 } as const;

const BUSY_PHASES = new Set(["generating", "regenerating"]);

export function CityMapPage() {
  const city = useCityModel({ ...DEFAULT_PARAMS });
  const { state } = city;
  const busy = BUSY_PHASES.has(state.phase);
  const rendererDead =
    state.phase === "unsupported" || state.phase === "initFailed";

  return (
    <div className="flex flex-col gap-6 pb-16 lg:flex-row lg:gap-10">
      <aside className="flex w-full flex-col gap-6 lg:max-w-xs">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight">
            City generator
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Terrain first, then districts. Corporate towers cluster where the
            road network makes travel cheap, luxury takes the ridges, and the
            slums get the floodplain and the megabuilding shadow.
          </p>
        </div>

        <SeedControls
          params={state.formParams}
          viewMode={state.viewMode}
          busy={busy}
          canGenerate={!rendererDead && state.phase !== "booting"}
          stale={isModelStale(state)}
          onParamsChange={city.setParams}
          onGenerate={city.generate}
          onCancel={city.cancel}
          onViewModeChange={city.setViewMode}
        />

        {state.model !== null ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Buildings</dt>
            <dd className="font-mono">{state.model.buildings.length}</dd>
            <dt className="text-muted-foreground">Blocks</dt>
            <dd className="font-mono">{state.model.blocks.length}</dd>
            <dt className="text-muted-foreground">Roads</dt>
            <dd className="font-mono">{state.model.roads.edges.length}</dd>
            <dt className="text-muted-foreground">Content hash</dt>
            <dd className="truncate font-mono">{state.model.contentHash}</dd>
          </dl>
        ) : null}
      </aside>

      <section className="flex flex-1 flex-col gap-3">
        <div className="relative min-h-96 flex-1 overflow-hidden rounded-lg border border-border bg-card">
          {rendererDead ? (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-prose text-sm text-foreground">
                {state.lastError ?? "The renderer is unavailable."}
              </p>
              {state.phase === "initFailed" ? (
                <Button type="button" onClick={city.retryInit}>
                  Retry
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This browser exposes neither WebGPU nor WebGL2, so the map
                  cannot be drawn.
                </p>
              )}
            </div>
          ) : (
            <SceneCanvas
              model={state.model}
              viewMode={state.viewMode}
              onRendererReady={city.onRendererReady}
              onNoBackend={city.onNoBackend}
              onInitFailed={city.onInitFailed}
            />
          )}

          {state.model === null && !rendererDead ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">
                {state.phase === "booting"
                  ? "Starting the renderer…"
                  : busy
                    ? `Generating ${STAGE_NAMES[state.stageIndex] ?? "the city"}`
                    : "Press Generate to build a city."}
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex min-h-6 items-center justify-between gap-4 text-xs">
          <p className="text-muted-foreground">
            {busy
              ? `Stage ${state.stageIndex + 1} of ${STAGE_NAMES.length}: ${STAGE_NAMES[state.stageIndex] ?? ""}`
              : state.phase === "error"
                ? state.lastError
                : state.phase === "ready"
                  ? `Seed ${state.modelParams?.seed ?? ""}`
                  : ""}
          </p>
          <p className="font-mono text-muted-foreground">{state.phase}</p>
        </div>
      </section>
    </div>
  );
}
