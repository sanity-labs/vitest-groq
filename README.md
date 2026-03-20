# vitest-groq

Bring your GROQ queries into your test suite. Pin down the business logic, guard the execution plan, and catch regressions when queries change.

A complete GROQ testing strategy layers several tools, each adding a different strength:

| Layer                    | What it verifies                       | When it runs   | Deterministic |
| ------------------------ | -------------------------------------- | -------------- | :-----------: |
| Lint rules               | Syntax and known patterns (static)     | Pre-commit     |      Yes      |
| **Business logic tests** | **Correct data, filters, shapes**      | **CI (fast)**  |    **Yes**    |
| **Execution plan tests** | **Fast plans, optimizer stability**    | **CI (API)**   |    **Yes**    |
| Timing assertions        | Latency within budget                  | CI / staging   |      No       |
| Runtime monitoring       | Real-world performance                 | Post-deploy    |      N/A      |

`vitest-groq` fills the two **bold** rows. Business logic tests lock the contract — output shape, filter rules, edge cases. Execution plan tests lock the performance strategy. When a query changes, the first confirms the contract still holds; the second confirms the plan is still efficient. [Why test GROQ →](docs/why-test-groq.md)

```bash
npm install -D vitest-groq groq-js
```

## Lock the contract

Start by writing unit tests for the query's business logic. Build a small dataset that covers the meaningful paths, then assert on the output. No setup file, no network, no credentials — `groq()` runs queries against in-memory data via [groq-js](https://github.com/sanity-io/groq-js).

```ts
import { describe, expect, it } from "vitest";
import { groq } from "vitest-groq/groq";

const dataset = [
  { _type: "author", _id: "author-1", name: "Alice", active: true },
  { _type: "author", _id: "author-2", name: "Bob", active: false },
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
  {
    _type: "article",
    _id: "article-3",
    title: "Gone",
    featured: true,
    author: { _type: "reference", _ref: "author-2" },
  },
];

describe("featuredArticlesQuery", () => {
  const QUERY = `*[_type == "article" && featured == true && author->active != false] {
    _id, title, "authorName": author->name
  }`;

  it("returns featured articles with active authors", async () => {
    const result = await groq(QUERY, dataset);
    expect(result).toHaveLength(1);
    expect(result[0].authorName).toBe("Alice");
  });

  it("excludes articles whose author is inactive", async () => {
    const result = await groq(QUERY, dataset);
    expect(result).not.toContainEqual(
      expect.objectContaining({ _id: "article-3" }),
    );
  });
});
```

Three to five documents is usually enough. These tests run in milliseconds — they're your safety net during refactors. See [Query contract testing](docs/groq-testing.md) for partial application, time-dependent queries, delta/webhook filters, and fidelity notes.

## Guard the execution plan

Once the contract is locked, add execution plan snapshots to verify performance. `explain()` asks Content Lake how it plans to execute a query and returns the strategy — which indexes it uses, whether sorts and limits are pushed down, how references are resolved.

> **Heads up — explain tests hit the live API.**
>
> Each `explain()` call is a real Content Lake API request and counts toward your project's [API quota](https://www.sanity.io/pricing). A few things to know:
>
> - **Keep explain tests in a dedicated config** (e.g. `vitest.perf.config.ts`) so they don't run on every `vitest run`.
> - **Set `useCdn: false`** on the client. Explain responses are execution plan metadata, not cacheable query results — routing through the CDN adds latency with no benefit.
> - **Rate limiting is handled automatically.** `@sanity/client` retries 429/502/503 responses with exponential backoff (up to 5 retries by default). If you have a large suite of explain tests, you can increase `maxRetries` on the client.
> - **Set `requestTagPrefix`** (e.g. `"performance-testing"`) so explain test traffic is identifiable in your project's request logs.

Explain tests authenticate with a **robot token**. Create one at [manage.sanity.io](https://manage.sanity.io) → your project → API → Tokens (no need to install the `sanity` CLI). Add it to `.env.local`, which should already be in your `.gitignore`:

```env
SANITY_PROJECT_ID=your-project-id
SANITY_DATASET=production
SANITY_AUTH_TOKEN=skRobot…
```

Set up the Vitest config to load these variables and register the custom matchers:

```ts
// vitest.perf.config.ts
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "SANITY_");

  return {
    test: {
      setupFiles: ["vitest-groq/plan-matchers"],
      env,
    },
  };
});
```

Then write an explain test for a data-fetching query:

```ts
// queries.perf.test.ts
import { createClient } from "@sanity/client";
import { describe, expect, it } from "vitest";
import { explain } from "vitest-groq";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID!,
  dataset: process.env.SANITY_DATASET!,
  apiVersion: "2025-01-01",
  token: process.env.SANITY_AUTH_TOKEN,
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

On the first run Vitest records the snapshot. On subsequent runs, any change to the plan shows up as a diff — you review it and either update the snapshot (the plan improved) or fix the query (the plan regressed).

## Assertion reference

Import `vitest-groq/plan-matchers` in your setup file to register these:

| Matcher                      | What it verifies             | Why it matters                                                   |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `toHaveNoDuplicateFetches()` | Each subquery runs once      | Avoids redundant network round-trips                             |
| `toHaveNoFilterStep()`       | All filters use an index     | Ensures O(log n) lookups instead of full scans                   |
| `toHaveSortInFetch()`        | Sort pushed to index         | Results arrive pre-sorted from the storage layer                 |
| `toHaveLimitInFetch()`       | Limit pushed to index        | Only the rows needed are fetched                                 |

`toHaveNoDuplicateFetches()` belongs in every explain test. Add the others as a query achieves each optimization.

For numeric and array properties, use Vitest built-ins directly:

`expect(c.fetchCount).toBeLessThanOrEqual(3)` · `expect(c.steps).not.toContain("SortStep")`

See [Optimization patterns](docs/optimization.md) for guidance on which assertions to add when.

## Further reading

- [Query contract testing](docs/groq-testing.md) — partial application, time-dependent queries, delta/webhook filters, identity, fidelity notes
- [Optimization patterns](docs/optimization.md) — improving execution plans with query rewrites and index-friendly patterns
- [Plan elements glossary](docs/plan-elements.md) — every source node and pipeline step in the explain output
- [Why test GROQ](docs/why-test-groq.md) — business logic and performance testing compared with linting, timing assertions, and runtime monitoring
- [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq) — the complete Sanity reference
