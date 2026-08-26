import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  async onSuccess() {
    copyFileSync("src/template.html", "dist/template.html");
  },
});
