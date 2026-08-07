import { defineConfig } from "@sanity/pkg-utils";

export default defineConfig({
  external: ["groq-js", "tar-stream"],
  runtime: "node",
  strictOptions: {
    noImplicitBrowsersList: "off",
  },
  tsconfig: "tsconfig.dist.json",
});
