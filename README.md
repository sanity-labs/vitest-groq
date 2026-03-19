# vitest-groq

Test how your GROQ queries run, not just what they return.

When Sanity's Content Lake runs a GROQ query, it builds an **execution plan**: the strategy it uses to find your data. Some plans use an index (fast, even with millions of documents). Others scan every document in the dataset looking for matches (slow, and gets worse as your dataset grows).

The tricky part: both plans return the same results. Your query looks correct, your app works fine, and nothing breaks until the dataset grows and pages start taking seconds to load.

`vitest-groq` gives you two tools to catch problems before they ship:

1. **`groq()`** — runs GROQ queries against in-memory datasets via [groq-js](https://github.com/sanity-io/groq-js). Tests filter logic, sort order, projection shapes, and edge cases. No network, no credentials, runs in CI alongside your unit tests.

2. **`explain()`** — asks Content Lake how it *plans* to execute a query and snapshots the strategy. Catches full table scans, unnecessary sorts, redundant fetches, and reference resolution bloat. Same query always produces the same plan, regardless of dataset size or server load.

**No single approach covers everything.** Lint rules catch known anti-patterns but can't detect regressions. Timing assertions are flaky. Runtime monitoring only fires after users are affected. A solid GROQ testing strategy layers several tools, each covering a different gap:

| Layer                    | What it catches                        | When it runs   | Deterministic |
| ------------------------ | -------------------------------------- | -------------- | :-----------: |
| Lint rules               | Known anti-patterns (static)           | Pre-commit     |      Yes      |
| **Correctness tests**    | **Wrong data, broken filters, shapes** | **CI (fast)**  |    **Yes**    |
| **Execution plan tests** | **Slow plans, optimizer regressions**  | **CI (API)**   |    **Yes**    |
| Timing assertions        | Gross latency changes                  | CI / staging   |      No       |
| Runtime monitoring       | Real-world performance                 | Post-deploy    |      N/A      |

`vitest-groq` fills the two **bold** rows — the pre-deploy layers that are both deterministic and CI-friendly. [Full comparison →](docs/why-snapshots.md)

## How the two tools work together

**1. Write unit tests to pin down the contract.** For each query, build a small dataset and assert on output shape and edge cases. These run in milliseconds — your safety net during refactors.

**2. Add execution plan snapshots.** For each data-fetching query, capture how Content Lake will execute it. The snapshot locks in the current strategy.

**3. When something looks wrong, fix the query.** The unit tests confirm the output didn't change. The snapshot diff shows the structural improvement — you'll see steps like `SortStep` disappear and `sortInFetch` flip to `true`.

## Quick start

```bash
npm install -D vitest-groq groq-js
```

### Unit tests with `groq()`

No setup file needed. Import and test:

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

Datasets can stay small. Three to five documents is usually enough to cover a query's meaningful paths. See [Query correctness testing](docs/groq-testing.md) for the full guide including partial application, time-dependent queries, delta/webhook filters, and fidelity gaps.

### Execution plan tests with `explain()`

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

On the first run Vitest records the snapshot. Future runs break if the plan regresses.

## Custom matchers

Import `vitest-groq/plan-matchers` in your setup file to register these:

| Matcher                      | What it guards               | Why it matters                                                   |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `toHaveNoDuplicateFetches()` | No duplicate Fetch filters   | Each duplicate is a redundant network round-trip                 |
| `toHaveNoFilterStep()`       | No `FilterStep` in the plan  | FilterStep scans every document, O(n) over the full dataset      |
| `toHaveSortInFetch()`        | `Sort:` inside a Fetch node  | Without it, SortStep materializes all rows to sort them          |
| `toHaveLimitInFetch()`       | `Limit:` inside a Fetch node | Without it, all matching rows are fetched then sliced            |

`toHaveNoDuplicateFetches()` belongs in every explain test. Add the others as a query achieves each optimization.

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

Add guards incrementally — once a query is optimized, the assertions prevent it from regressing.

## Further reading

- [Query correctness testing](docs/groq-testing.md) — partial application, time-dependent queries, delta/webhook filters, identity, fidelity gaps
- [Optimization patterns](docs/optimization.md) — common explain test failures and how to fix the underlying queries
- [Plan elements glossary](docs/plan-elements.md) — every source node and pipeline step in the explain output
- [Why snapshots](docs/why-snapshots.md) — detailed comparison with linting, timing assertions, and runtime monitoring
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

### `groq(query, dataset, options?)`

Runs a query against a local dataset via groq-js. Returns the result with full type inference when used with `defineQuery()`.

```ts
import { groq } from "vitest-groq/groq";

// Direct call
const result = await groq(query, dataset, { params: { locale: "en" } });

// Partial application — bind dataset + options, reuse across tests
const run = groq(dataset, { timestamp: new Date("2025-03-17") });
const result = await run(query);
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
