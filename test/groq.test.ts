import { describe, expect, it } from "vitest";

import { groq } from "../src/groq";

const posts = [
  { _type: "post", _id: "post.1", title: "First", _createdAt: "2025-01-01" },
  { _type: "post", _id: "post.2", title: "Second", _createdAt: "2025-02-01" },
  { _type: "post", _id: "post.3", title: "Third", _createdAt: "2025-03-01" },
  { _type: "author", _id: "author.1", name: "Alice" },
];

describe("groq — direct call", () => {
  it("filters by _type", async () => {
    const result = await groq(posts, `*[_type == "post"]`);
    expect(result).toHaveLength(3);
  });

  it("projects fields", async () => {
    const result = await groq(posts, `*[_type == "post"]{ title }`);
    expect(result).toEqual([{ title: "First" }, { title: "Second" }, { title: "Third" }]);
  });

  it("accepts params", async () => {
    const result = await groq(posts, `*[_id == $id][0]`, {
      params: { id: "post.2" },
    });
    expect(result).toMatchObject({ title: "Second" });
  });

  it("returns as many results as a param asks for", async () => {
    const result = await groq(posts, `*[_type == "post"] | order(_createdAt asc) [0...$size]._id`, {
      params: { size: 2 },
    });
    expect(result).toEqual(["post.1", "post.2"]);
  });

  it("returns count", async () => {
    const result = await groq(posts, `count(*[_type == "post"])`);
    expect(result).toBe(3);
  });

  it("returns null for empty match", async () => {
    const result = await groq(posts, `*[_type == "nonexistent"][0]`);
    expect(result).toBeNull();
  });
});

describe("groq — partial application", () => {
  it("binds dataset and returns query function", async () => {
    const run = groq(posts);
    const result = await run(`*[_type == "post"]{ title }`);
    expect(result).toHaveLength(3);
  });

  it("returns as many results as a default param asks for", async () => {
    const run = groq(posts, { params: { size: 1 } });
    expect(await run(`*[_type == "post"] | order(_createdAt asc) [0...$size]._id`)).toEqual([
      "post.1",
    ]);
  });

  it("inherits default options", async () => {
    const run = groq(posts, { params: { id: "post.1" } });
    const result = await run(`*[_id == $id][0].title`);
    expect(result).toBe("First");
  });

  it("per-query options override defaults", async () => {
    const run = groq(posts, { params: { id: "post.1" } });
    const result = await run(`*[_id == $id][0].title`, {
      params: { id: "post.3" },
    });
    expect(result).toBe("Third");
  });
});
