import { Button } from "@/components/ui/button";
import type { CityViewMode } from "./cityModelMachine";

/**
 * The plan/perspective switch, floating on the map rather than sitting in the
 * parameter panel.
 *
 * It does not belong with the seed and the extent: those describe the city to
 * be built and only take effect on the next generation, while this changes what
 * you are looking at right now and never touches the model. Keeping them apart
 * means the panel can be read as "what to build" from top to bottom, with no
 * control in it that behaves differently from the rest.
 */

const MODES: readonly {
  readonly mode: CityViewMode;
  readonly label: string;
}[] = [
  { mode: "2d", label: "Plan" },
  { mode: "3d", label: "Night" },
];

interface ViewModeToggleProps {
  readonly viewMode: CityViewMode;
  /**
   * There is no canvas to switch when the renderer is dead, and the reducer
   * ignores `SWITCH_VIEW` in those phases anyway — so without this the buttons
   * accept a click and nothing whatsoever happens.
   */
  readonly disabled?: boolean;
  readonly onViewModeChange: (viewMode: CityViewMode) => void;
}

export function ViewModeToggle({
  viewMode,
  disabled = false,
  onViewModeChange,
}: ViewModeToggleProps) {
  return (
    <div className="map-surface flex gap-1 rounded-lg p-1">
      {MODES.map(({ mode, label }) => (
        <Button
          key={mode}
          type="button"
          size="sm"
          variant={viewMode === mode ? "default" : "ghost"}
          aria-pressed={viewMode === mode}
          disabled={disabled}
          onClick={() => onViewModeChange(mode)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
