import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GenerationParams } from "@/entities/city";

/**
 * What to build: the seed and the two size parameters, plus the control that
 * commits them.
 *
 * The generate button is a single control that both starts and supersedes a
 * run, which is why it stays enabled while generating: the machine decides
 * which of the two it means. Cancel is offered separately rather than turning
 * generate into a toggle, so a user who wants the previous city back has a
 * control that says so.
 *
 * The view switch used to live here and no longer does — see `ViewModeToggle`
 * for why a control that changes the camera does not belong in a form about
 * the model.
 */

interface SeedControlsProps {
  readonly params: GenerationParams;
  readonly busy: boolean;
  readonly canGenerate: boolean;
  readonly stale: boolean;
  readonly onParamsChange: (patch: Partial<GenerationParams>) => void;
  readonly onGenerate: () => void;
  readonly onCancel: () => void;
}

const SIZE_CHOICES = [1024, 2048, 4096] as const;
const CELL_CHOICES = [128, 256, 512] as const;

/** Equal-width segments, so the row reads as one control rather than three. */
const segmentClass = "flex-1 px-0";

export function SeedControls({
  params,
  busy,
  canGenerate,
  stale,
  onParamsChange,
  onGenerate,
  onCancel,
}: SeedControlsProps) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onGenerate();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="seed" className="text-muted-foreground text-xs">
          Seed
        </Label>
        <Input
          id="seed"
          value={params.seed}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => onParamsChange({ seed: event.target.value })}
        />
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground text-xs">Extent</legend>
        <div className="flex gap-1.5">
          {SIZE_CHOICES.map((size) => (
            <Button
              key={size}
              type="button"
              size="sm"
              className={segmentClass}
              variant={params.sizeM === size ? "default" : "secondary"}
              aria-pressed={params.sizeM === size}
              onClick={() => onParamsChange({ sizeM: size })}
            >
              {size} m
            </Button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground text-xs">
          Field resolution
        </legend>
        <div className="flex gap-1.5">
          {CELL_CHOICES.map((cells) => (
            <Button
              key={cells}
              type="button"
              size="sm"
              className={segmentClass}
              variant={params.cells === cells ? "default" : "secondary"}
              aria-pressed={params.cells === cells}
              onClick={() => onParamsChange({ cells })}
            >
              {cells}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={!canGenerate}>
          {busy ? "Generating…" : "Generate"}
        </Button>
        {busy ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {stale ? (
        <p className="text-muted-foreground text-xs">
          The city on screen was built from different settings.
        </p>
      ) : null}
    </form>
  );
}
