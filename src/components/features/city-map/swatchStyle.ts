/**
 * The inline style that shows one of the viewer's palette colours in the DOM.
 *
 * The legends are the one place a scene colour has to leave the canvas, and
 * they cannot use a design token to do it: these numbers are the map's own
 * palette, so the swatch has to be the literal colour being explained or it
 * explains nothing. Inline rather than a class for the same reason — the value
 * comes from a `Record` keyed at runtime, and there is no stylesheet that could
 * enumerate it.
 *
 * Shared because both legends need exactly this and nothing more; it stays in
 * the feature directory rather than `src/lib/` because "a swatch for a map
 * palette colour" is not a generic idea.
 */
export const swatchStyle = (hex: number) => ({
  backgroundColor: `#${hex.toString(16).padStart(6, "0")}`,
});
