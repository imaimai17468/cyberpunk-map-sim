declare module "*.css";

/**
 * A `.glb` import resolves to the emitted asset's URL.
 *
 * Declared here rather than pulled in with `vite/client`, because `tsconfig.json`
 * pins `types` to `["node"]` and widening that would bring in every ambient Vite
 * global for the sake of one file extension. `vite.config.ts` carries the
 * matching `assetsInclude` — Vite 8's own `KNOWN_ASSET_TYPES` covers images,
 * audio, video, fonts, pdf and txt, and no 3D format.
 */
declare module "*.glb" {
  const url: string;
  export default url;
}
