import preset from "@sanity/semantic-release-preset";

// The preset's exec step also formats CHANGELOG.md with `npx -y prettier`, which fails on
// the pnpm runner. Keep exec (it runs publishCmd below) and drop only that prepareCmd.
const plugins = preset.plugins.map((plugin) =>
  Array.isArray(plugin) && plugin[0] === "@semantic-release/exec"
    ? [plugin[0], { ...plugin[1], prepareCmd: undefined }]
    : plugin,
);

/**
 * @type {import('semantic-release').Options}
 */
export default {
  plugins,
  branches: ["main"],

  npmPublish: false,
  publishCmd: "pnpm publish --no-git-checks --provenance",
};
