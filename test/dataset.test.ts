import { describe, expect, it } from "vitest";

import { loadDataset } from "../src/dataset";
import { groq } from "../src/groq";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

describe("loadDataset — NDJSON", () => {
  it("loads an ndjson file", async () => {
    const result = await loadDataset(fixture("posts.ndjson"));
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ _id: "post.1", title: "First" });
  });

  it("returns empty array for empty file", async () => {
    const result = await loadDataset(fixture("empty.ndjson"));
    expect(result).toEqual([]);
  });

  it("throws on malformed JSON with line number", async () => {
    await expect(loadDataset(fixture("malformed.ndjson"))).rejects.toThrow(
      /malformed JSON at.*:2/,
    );
  });
});

describe("loadDataset — tarball", () => {
  it("extracts ndjson from a .tar.gz", async () => {
    const result = await loadDataset(fixture("posts.tar.gz"));
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ _id: "post.1", title: "First" });
  });
});

describe("loadDataset — path resolution", () => {
  it("accepts a relative string path (resolved from cwd)", async () => {
    const result = await loadDataset("test/fixtures/posts.ndjson");
    expect(result).toHaveLength(3);
  });
});

describe("loadDataset — error handling", () => {
  it("throws on file not found", async () => {
    await expect(loadDataset("nonexistent.ndjson")).rejects.toThrow();
  });
});

describe("loadDataset — integration with groq()", () => {
  it("loaded dataset works with groq()", async () => {
    const posts = await loadDataset(fixture("posts.ndjson"));
    const result = await groq(posts, `*[_type == "post"]{ title }`);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ title: "First" });
  });
});
