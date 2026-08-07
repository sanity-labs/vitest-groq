# Testing GROQ queries in-memory with groq-js

If you're already writing unit tests for your frontend, you can test your GROQ queries the same way: in-memory, no network, no Sanity project credentials required.

The `groq()` utility wraps [groq-js](https://github.com/sanity-io/groq-js), the reference JavaScript implementation of the GROQ spec. You give it a dataset and a query string, and it returns the result. It runs wherever your test suite runs.

```bash
npm install -D vitest-groq
```

## Example

Take a query that fetches featured articles with their author names, skipping articles whose authors have been deactivated:

```ts
export const featuredArticlesQuery = defineQuery(`
  *[_type == "article" && featured == true && author->active != false] {
    _id,
    title,
    "authorName": author->name
  }
`);
```

Each test builds its own minimal dataset:

```ts
import { describe, expect, it } from "vitest";
import { groq } from "vitest-groq/groq";

describe("featuredArticlesQuery", () => {
  const dataset = [
    { _type: "author", _id: "author-alice", name: "Alice", active: true },
    { _type: "author", _id: "author-bob", name: "Bob", active: false },
    {
      _type: "article",
      _id: "article-1",
      title: "Hello",
      featured: true,
      author: { _type: "reference", _ref: "author-alice" },
    },
    {
      _type: "article",
      _id: "article-2",
      title: "Draft",
      featured: false,
      author: { _type: "reference", _ref: "author-alice" },
    },
    {
      _type: "article",
      _id: "article-3",
      title: "Gone",
      featured: true,
      author: { _type: "reference", _ref: "author-bob" },
    },
  ];

  it("returns featured articles with active authors", async () => {
    const result = await groq(dataset, featuredArticlesQuery);
    expect(result).toHaveLength(1);
    expect(result[0].authorName).toBe("Alice");
  });

  it("excludes non-featured articles", async () => {
    expect(await groq(dataset, featuredArticlesQuery)).not.toContainEqual(
      expect.objectContaining({ _id: "article-2" }),
    );
  });

  it("excludes articles whose author is inactive", async () => {
    expect(await groq(dataset, featuredArticlesQuery)).not.toContainEqual(
      expect.objectContaining({ _id: "article-3" }),
    );
  });
});
```

The join via `author->` works the same way it does against a real dataset. groq-js resolves references by scanning the in-memory array.

For edge cases and empty states, inline the dataset:

```ts
it("returns an empty array when no articles are featured", async () => {
  const result = await groq(
    [
      { _type: "author", _id: "author-1", name: "Alice", active: true },
      {
        _type: "article",
        _id: "article-1",
        title: "Draft",
        featured: false,
        author: { _type: "reference", _ref: "author-1" },
      },
    ],
    featuredArticlesQuery,
  );
  expect(result).toHaveLength(0);
});
```

## Two call forms

TypeScript distinguishes the two forms by the second argument's type: `string` means direct call, otherwise partial application. Dataset is always the first argument.

```ts
// Direct call: dataset, query, options
const result = await groq(dataset, myQuery);
const result = await groq(dataset, query, { params: { id: "doc.1" } });
const result = await groq(dataset, query, { timestamp: new Date("2025-01-15") });

// Partial application: dataset + defaults, returns a bound query function
const run = groq(sharedDataset, { timestamp: new Date("2025-01-15") });
const result = await run(myQuery);
const result = await run(otherQuery, { params: { limit: 5 } });
```

**Type inference** works in both paths. `ClientReturn<G, R>` maps `defineQuery()` strings to TypeGen result types:

```ts
const result = await groq(dataset, featuredArticlesQuery);
//    ^? FeaturedArticlesQueryResult  ← inferred from sanity.types.ts
```

**Full options surface.** `GroqOptions` exposes everything groq-js supports (`params`, `timestamp`, `identity`, `before`, `after`, `sanity`, `root`, `dereference`) plus `mode` from the parser (for delta queries).

## Testing time-dependent queries

The `timestamp` option controls what `now()` returns inside the query. Without it, time-sensitive tests are non-deterministic:

```ts
export const recentPostsQuery = defineQuery(`
  *[_type == "post" && dateTime(publishedAt) > dateTime(now()) - 60*60*24*7] {
    _id, title, publishedAt
  }
`);

it("includes posts published within the last 7 days", async () => {
  const dataset = [
    { _type: "post", _id: "post-1", title: "Fresh", publishedAt: "2025-03-14" },
    { _type: "post", _id: "post-2", title: "Old", publishedAt: "2025-02-01" },
  ];

  const result = await groq(dataset, recentPostsQuery, {
    timestamp: new Date("2025-03-17T00:00:00Z"),
  });

  expect(result).toHaveLength(1);
  expect(result[0].title).toBe("Fresh");
});
```

## Shared datasets and default options

When many tests in a `describe` block share the same dataset and options, use partial application to bind them once:

```ts
describe("recentPostsQuery", () => {
  const dataset = [
    { _type: "post", _id: "post-1", title: "Fresh", publishedAt: "2025-03-14" },
    { _type: "post", _id: "post-2", title: "Old", publishedAt: "2025-02-01" },
  ];

  // Bind dataset + timestamp once
  const run = groq(dataset, { timestamp: new Date("2025-03-17T00:00:00Z") });

  it("includes recent posts", async () => {
    const result = await run(recentPostsQuery);
    expect(result).toHaveLength(1);
  });

  it("accepts per-call option overrides", async () => {
    // Per-call options merge with (and override) defaults
    const result = await run(recentPostsQuery, {
      timestamp: new Date("2025-02-15T00:00:00Z"),
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Fresh");
  });
});
```

## Testing delta/webhook queries

GROQ filters used in webhooks or event subscriptions can be tested with `mode: 'delta'` and the `before`/`after` options:

```ts
const webhookFilter = defineQuery(
  `delta::operation() == "update" && after.status != before.status`,
);

it("matches when status changes", async () => {
  const result = await groq([], webhookFilter, {
    mode: "delta",
    before: { _id: "doc.1", _type: "task", status: "open" },
    after: { _id: "doc.1", _type: "task", status: "closed" },
  });
  expect(result).toBe(true);
});
```

The dataset is typically empty for delta filters. The query operates on `before` and `after` documents.

## Testing identity-dependent queries

Queries that use `identity()` for access control:

```ts
const myDocumentsQuery = defineQuery(`
  *[_type == "document" && owner == identity()] { _id, title }
`);

it("returns only documents owned by the current user", async () => {
  const dataset = [
    { _type: "document", _id: "doc.1", title: "Mine", owner: "user-abc" },
    { _type: "document", _id: "doc.2", title: "Theirs", owner: "user-xyz" },
  ];

  const result = await groq(dataset, myDocumentsQuery, { identity: "user-abc" });
  expect(result).toHaveLength(1);
  expect(result[0].title).toBe("Mine");
});
```

## Testing sanity namespace functions

Queries using `sanity::dataset()` or `sanity::projectId()`:

```ts
const envQuery = defineQuery(`{
  "dataset": sanity::dataset(),
  "projectId": sanity::projectId()
}`);

it("resolves sanity namespace functions", async () => {
  const result = await groq([], envQuery, {
    sanity: { projectId: "abc123", dataset: "production" },
  });
  expect(result.dataset).toBe("production");
  expect(result.projectId).toBe("abc123");
});
```

## What to test

This approach works well for:

- **Filter conditions** — does this predicate include and exclude the right documents?
- **Projections** — does the output shape match what the component expects?
- **Cross-document joins** via `->` and their edge cases (missing references, inactive records)
- **Aggregations** — sums, counts, and groupings
- **Date comparisons** involving `now()`
- **Delta filters** for webhooks and event subscriptions
- **Access control** filters using `identity()`

Datasets can stay small. Three to five documents is usually enough to cover a query's meaningful paths.

## Fidelity notes: groq-js vs Content Lake

groq-js is a faithful JS implementation of the GROQ spec. Content Lake extends this with additional runtime capabilities. Here's where they differ:

| Area                          | groq-js behavior                                 | Content Lake behavior                                                                    |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Index usage / performance     | Invisible — all queries scan the in-memory array | Indexes, full scans, `FilterStep` vs `Fetch` in explain plans                            |
| Draft documents               | Only what you put in the dataset                 | `drafts.*` documents exist; queries without `!(_id in path("drafts.**"))` return doubles |
| Dataset size effects          | 5 documents execute instantly                    | Structurally-incorrect queries may time out at 10k+ docs                                 |
| Reference resolution          | Finds `_ref` → `_id` in the flat array           | Also handles deleted docs (null), access control (null), draft/published distinction     |
| `score()` / relevance ranking | Basic implementation                             | Production-optimized, results may differ                                                 |
| Full-text search              | Works but ranking differs                        | Content Lake uses search indexes                                                         |

### Unimplemented functions

A handful of GROQ functions throw `not implemented` in groq-js:

- `text::query()` and `text::embedding()` — require a search index
- `anywhere()` — full-text search
- `geo::latLng()`, `geo::contains()`, `geo::intersects()`, `geo::distance()`
- `user::attributes()`
- `media::aspect()`

If your queries use any of these, groq-js throws immediately, a clear signal to test those queries against a real Sanity dataset instead.

### Performance testing requires real Content Lake

Index usage and execution strategy are Content Lake concerns. To verify those, use `explain()` from the core `vitest-groq` entrypoint. See [Optimization patterns](./optimization.md).
