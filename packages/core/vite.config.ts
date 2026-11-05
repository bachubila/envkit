import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    dts: {
      generator: "tsgo",
    },
  },
});
