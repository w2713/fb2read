import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "fb2read-server": "src/main.ts" },
  format: ["esm"],
  target: "node20",
  outExtension: () => ({ js: ".mjs" }),
  noExternal: [/.*/],
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
