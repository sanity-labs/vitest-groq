import { defineConfig } from "@sanity/pkg-utils";

export default defineConfig({
  deps: { neverBundle: ["groq-js", "tar-stream"] },
  runtime: "node",
  strictOptions: {
    noImplicitBrowsersList: "off",
    // `@sanity/client` is a type-only dependency, and `ClientReturn` resolves the
    // `SanityQueries` interface that `sanity typegen generate` augments. A peer
    // guarantees we read the consumer's copy; as a regular dependency npm can nest
    // a second one, and the augmentation silently stops reaching our types.
    noSanityClientPeerDependency: "off",
  },
  tsconfig: "tsconfig.dist.json",
});
