import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GenerationParams } from "@/entities/city";
import type { CityViewMode } from "./cityModelMachine";

/**
 * Seed and parameter form plus the view switch.
 *
 * The generate button is a single control that both starts and supersedes a
 * run, which is why it stays enabled while generating: the machine decides
 * which of the two it means. Cancel is offered separately rather than turning
 * generate into a toggle, so a user who wants the previous city back has a
 * control that says so.
 */

interface SeedControlsProps {
  readonly params: GenerationParams;
  readonly viewMode: CityViewMode;
  readonly busy: boolean;
  readonly canGenerate: boolean;
  readonly stale: boolean;
  readonly onParamsChange: (patch: Partial<GenerationParams>) => void;
  readonly onGenerate: () => void;
  readonly onCancel: () => void;
  readonly onViewModeChange: (viewMode: CityViewMode) => void;
}

const SIZE_CHOICES = [1024, 2048, 4096] as const;
const CELL_CHOICES = [128, 256, 512] as const;

export function SeedControls({
  params,
  viewMode,
  busy,
  canGenerate,
  stale,
  onParamsChange,
  onGenerate,
  onCancel,
  onViewModeChange,
}: SeedControlsProps) {
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onGenerate();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="seed">Seed</Label>
        <Input
          id="seed"
          value={params.seed}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onParamsChange({ seed: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          The same seed always produces the same city.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Extent</legend>
        <div className="flex flex-wrap gap-2">
          {SIZE_CHOICES.map((size) => (
            <Button
              key={size}
              type="button"
              variant={params.sizeM === size ? "default" : "secondary"}
              onClick={() => onParamsChange({ sizeM: size })}
            >
              {size} m
            </Button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Field resolution</legend>
        <div className="flex flex-wrap gap-2">
          {CELL_CHOICES.map((cells) => (
            <Button
              key={cells}
              type="button"
              variant={params.cells === cells ? "default" : "secondary"}
              onClick={() => onParamsChange({ cells })}
            >
              {cells}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Higher resolution sharpens terrain but slows generation.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">View</legend>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={viewMode === "2d" ? "default" : "secondary"}
            onClick={() => onViewModeChange("2d")}
          >
            2D map
          </Button>
          <Button
            type="button"
            variant={viewMode === "3d" ? "default" : "secondary"}
            onClick={() => onViewModeChange("3d")}
          >
            3D
          </Button>
        </div>
      </fieldset>

      {stale ? (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          The map on screen was generated from different settings.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={!canGenerate}>
          {busy ? "Generating…" : "Generate"}
        </Button>
        {busy ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
