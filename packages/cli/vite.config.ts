import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    dts: false,
  },
  // Resolve workspace packages (@envkit/core) to their TypeScript source in
  // tests, so `vp test` doesn't depend on a prior build. Vite's server defaults
  // conditions come after `source`.
  ssr: {
    resolve: {
      conditions: ["source", "module", "node", "development|production"],
    },
  },
});
