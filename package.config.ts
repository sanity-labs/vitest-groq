import { defineConfig } from "@sanity/pkg-utils";

export default defineConfig({
  external: ["groq-js", "tar-stream"],
  runtime: "node",
  strictOptions: {
    noImplicitBrowsersList: "off",
  },
  extract: {
    rules: {
      "ae-missing-release-tag": "off",
    },
  },
  tsconfig: "tsconfig.dist.json",
});
