import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Vite's own `KNOWN_ASSET_TYPES` is images, audio, video, fonts, pdf and txt —
  // no 3D format — so a `.glb` import would be parsed as a module without this
  // (ADR-0029). `src/env.d.ts` carries the matching declaration.
  assetsInclude: ["**/*.glb"],
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tanstackStart(),
    react(),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
  ],
});
