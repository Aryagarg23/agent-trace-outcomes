import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    schemas: "schemas.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  target: "node18",
  platform: "node",
  splitting: false,
  clean: true,
  sourcemap: false,
});
