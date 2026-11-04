import { defineConfig } from "vite-plus";

export default defineConfig({
  // Resolve workspace packages to their TypeScript source (see packages/cli/vite.config.ts).
  ssr: {
    resolve: {
      conditions: ["source", "module", "node", "development|production"],
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Each test drives real `bw` processes, and KDF + RSA key generation is slow.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  run: {
    tasks: {
      // Needs Docker, so it is not part of `test` / `vp run ready`. Never cached:
      // the result depends on Docker and the network, not just the sources.
      integration: {
        command: "vp test",
        cache: false,
      },
    },
  },
});
