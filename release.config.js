/**
 * @type {import('semantic-release').Options}
 */
export default {
  extends: "@sanity/semantic-release-preset",
  branches: ["main"],

  npmPublish: false,
  publishCmd: "pnpm publish --no-git-checks --provenance",
};
