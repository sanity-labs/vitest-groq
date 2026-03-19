# vitest-groq

Test how your GROQ queries run, not just what they return.

When Sanity's Content Lake runs a GROQ query, it builds an **execution plan**: the strategy it uses to find your data. Some plans use an index (fast, even with millions of documents). Others scan every document in the dataset looking for matches (slow, and gets worse as your dataset grows).

The tricky part: both plans return the same results. Your query looks correct, your app works fine, and nothing breaks until the dataset grows and pages start taking seconds to load.

`vitest-groq` lets you write tests against the execution plan itself, so you catch slow query strategies in CI before they reach production.

**What that looks like.** Say you ship this query:

```groq
*[_type == "post" && author->slug.current == $slug] | order(publishedAt desc)[0..9]
```

It returns the right data, but the `author->` dereference inside the filter means Content Lake can't use an index. It has to check every document. You add a test:

```ts
expect(characteristics).toHaveNoFilterStep();
// ✘ Plan contains FilterStep (in-memory filter scanning every document)
```

The test fails, which tells you the query needs a different approach. You flip the lookup so the filter stays indexable:

```groq
*[_type == "post" && author._ref in *[_type == "author" && slug.current == $slug]._id]
  | order(publishedAt desc)[0..9]
```

```ts
expect(characteristics).toHaveNoFilterStep(); // ✔ passes
expect(characteristics).toMatchSnapshot(); // locks in the efficient plan
```

Now if a future refactor or GROQ update reintroduces the scan, the snapshot breaks and you'll know before it ships.

**Why test the plan?** You could lint your queries, or assert on response times. Here's how those approaches compare:

| Approach                 | Catches known anti-patterns | Catches unexpected regressions | Runs pre-deploy | Deterministic |
| ------------------------ | :-------------------------: | :----------------------------: | :-------------: | :-----------: |
| Lint rules               |             Yes             |               No               |       Yes       |      Yes      |
| Timing assertions        |             No              |           Sometimes            |       Yes       |      No       |
| Runtime monitoring       |             No              |              Yes               |       No        |      N/A      |
| **Execution plan tests** |             Yes             |            **Yes**             |     **Yes**     |    **Yes**    |

Execution plan tests are deterministic (same query always produces the same plan) and catch regressions before you ship. [Full comparison →](docs/why-snapshots.md)

## Quick start

```bash
npm install -D vitest-groq
```

> **Heads up — explain tests hit the live API.**
>
> Each `explain()` call is a real Content Lake API request and counts toward your project's [API quota](https://www.sanity.io/pricing). A few things to know:
>
> - **Keep explain tests in a dedicated config** (e.g. `vitest.perf.config.ts`) so they don't run on every `vitest run`.
> - **Set `useCdn: false`** on the client. Explain responses are execution plan metadata, not cacheable query results — routing through the CDN adds latency with no benefit.
> - **Rate limiting is handled automatically.** `@sanity/client` retries 429/502/503 responses with exponential backoff (up to 5 retries by default). If you have a large suite of explain tests, you can increase `maxRetries` on the client.
> - **Set `requestTagPrefix`** (e.g. `"performance-testing"`) so explain test traffic is identifiable in your project's request logs.

Set up the custom matchers in your Vitest config:

```ts
// vitest.perf.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["vitest-groq/plan-matchers"],
  },
});
```

Write your first explain test:

```ts
// queries.perf.test.ts
import { createClient } from "@sanity/client";
import { describe, expect, it } from "vitest";
import { explain } from "vitest-groq";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID!,
  dataset: process.env.SANITY_DATASET!,
  apiVersion: "2025-01-01",
  token: process.env.SANITY_TOKEN,
  useCdn: false,
  requestTagPrefix: "performance-testing",
});

describe("query execution plans", () => {
  it("fetches recent posts efficiently", async () => {
    const { characteristics } = await explain(
      client,
      `*[_type == "post"] | order(_createdAt desc)[0..9]`,
    );
    expect(characteristics).toMatchSnapshot();
    expect(characteristics).toHaveNoDuplicateFetches();
    expect(characteristics).toHaveNoFilterStep();
  });
});
```

First run generates a snapshot. Subsequent runs fail if the plan changes.

## Custom matchers

Import `vitest-groq/plan-matchers` in your setup file to register these:

| Matcher                      | What it guards               | Why it matters                                                   |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `toHaveNoDuplicateFetches()` | No duplicate Fetch filters   | Each duplicate is a redundant network round-trip                 |
| `toHaveNoFilterStep()`       | No `FilterStep` in the plan  | FilterStep means in-memory filtering, O(n) over the full dataset |
| `toHaveSortInFetch()`        | `Sort:` inside a Fetch node  | Without it, SortStep materializes all rows in memory             |
| `toHaveLimitInFetch()`       | `Limit:` inside a Fetch node | Without it, all matching rows are fetched then sliced in memory  |

Add `toHaveNoDuplicateFetches()` to every explain test. Add the others when a query achieves the corresponding optimization.

## Native matchers

For numbers and arrays, Vitest's built-in matchers are already expressive:

```ts
expect(characteristics.fetchCount).toBeLessThanOrEqual(3);
expect(characteristics.resolveRefCount).toBeLessThanOrEqual(2);
expect(characteristics.duplicateFetches.length).toBeLessThan(2);
expect(characteristics.steps).not.toContain("SortStep");
expect(characteristics.steps).toContain("HashBatchStep");
```

## Choosing assertions

| Scenario              | What to add                                          |
| --------------------- | ---------------------------------------------------- |
| Every explain test    | `toMatchSnapshot()` + `toHaveNoDuplicateFetches()`   |
| All filters indexable | + `toHaveNoFilterStep()`                             |
| Sort pushed to index  | + `toHaveSortInFetch()`                              |
| Limit pushed to index | + `toHaveLimitInFetch()`                             |
| Fetch budget          | + `expect(c.fetchCount).toBeLessThanOrEqual(n)`      |
| Reference budget      | + `expect(c.resolveRefCount).toBeLessThanOrEqual(n)` |
| Batched correlations  | + `expect(c.steps).toContain('HashBatchStep')`       |

Add optimization guards after verifying a query is optimized. They prevent silent regressions.

## Query correctness testing

The `vitest-groq/groq` entrypoint wraps [groq-js](https://github.com/sanity-io/groq-js) for testing query correctness in-memory — no network, no credentials, runs in CI alongside your unit tests.

```ts
import { groq } from "vitest-groq/groq";

const dataset = [
  { _type: "author", _id: "author-1", name: "Alice", active: true },
  {
    _type: "article",
    _id: "article-1",
    title: "Hello",
    featured: true,
    author: { _type: "reference", _ref: "author-1" },
  },
  {
    _type: "article",
    _id: "article-2",
    title: "Draft",
    featured: false,
    author: { _type: "reference", _ref: "author-1" },
  },
];

it("returns featured articles with active authors", async () => {
  const result = await groq(featuredArticlesQuery, dataset);
  expect(result).toHaveLength(1);
  expect(result[0].authorName).toBe("Alice");
});
```

Partial application binds a shared dataset across a `describe` block:

```ts
const run = groq(dataset, { timestamp: new Date("2025-03-17T00:00:00Z") });
const result = await run(recentPostsQuery);
```

`GroqOptions` exposes the full groq-js surface: `params`, `timestamp`, `identity`, `before`/`after` (delta queries), `sanity` (namespace functions), `root`, and `dereference`. Type inference works automatically with `defineQuery()` and TypeGen.

See [Query correctness testing](docs/groq-testing.md) for the full guide including time-dependent queries, delta/webhook filters, identity, sanity namespace functions, fidelity gaps, and more.

## Further reading

- [Query correctness testing](docs/groq-testing.md) — testing GROQ queries in-memory with groq-js (time, delta, identity, fidelity gaps)
- [Optimization patterns](docs/optimization.md) — common explain test failures and how to fix the underlying queries
- [Plan elements glossary](docs/plan-elements.md) — every source node and pipeline step the explain output can contain
- [Why snapshots](docs/why-snapshots.md) — how explain snapshots compare to linting, timing, and runtime observability
- [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq) — the complete Sanity reference

## API reference

### `explain(client, query, params?)`

Sends a GROQ query to Content Lake with `explain=true` and returns structured plan characteristics.

```ts
import { explain } from "vitest-groq";

const result = await explain(client, query, { id: "test" });
// result.raw          — raw explain string
// result.ms           — server-side timing
// result.resultCount  — number of results
// result.characteristics — PlanCharacteristics
```

### `parsePlan(raw)`

Extracts `PlanCharacteristics` from a raw explain string. Useful when you already have the explain output (e.g., from a CLI script).

```ts
import { parsePlan } from "vitest-groq";

const characteristics = parsePlan(explainString);
```

### Entrypoints

| Import path                 | What it exports                                                    | Peer deps        |
| --------------------------- | ------------------------------------------------------------------ | ---------------- |
| `vitest-groq`               | `explain()`, `parsePlan()`, `PlanCharacteristics`, `ExplainResult` | `@sanity/client` |
| `vitest-groq/groq`          | `groq()`, `GroqOptions`                                            | `groq-js`        |
| `vitest-groq/plan-matchers` | Calls `expect.extend()` + type augmentation (side-effect)          | `vitest`         |
| `vitest-groq/matchers`      | `planMatchers` object for manual registration / Jest compat        | none             |
