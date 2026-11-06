import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    dts: false,
    // envkit ships as one package: core is bundled in, its own dependencies stay external.
    deps: { alwaysBundle: ["@envkit/core"] },
    // Bundle core from its TypeScript source, so a stale core build can't leak in.
    inputOptions: { resolve: { conditionNames: ["source", "import", "default"] } },
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
