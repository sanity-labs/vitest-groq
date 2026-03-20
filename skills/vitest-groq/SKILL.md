---
name: vitest-groq
description: Write and debug GROQ execution plan tests using vitest-groq. Use when creating explain tests, diagnosing slow queries, understanding plan characteristics, or testing GROQ query business logic in-memory.
argument-hint: <query-or-file>
metadata:
  version: "1.0.0"
---

# vitest-groq

Bring your GROQ queries into your test suite. Pin down the business logic, guard the execution plan, and catch regressions when queries change.

## What you do

When the user asks you to write or debug GROQ performance tests, follow this workflow:

1. **Read the query** — understand the GROQ query and what it's trying to do
2. **Write an explain test** — use `explain()` to get the execution plan from Content Lake
3. **Assert on the plan** — use custom matchers to guard against regressions
4. **Optimize the query if needed** — apply optimization patterns for better index usage

## Setup

Explain tests require a Sanity client with real credentials. Recommend this configuration:

```ts
const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID!,
  dataset: process.env.SANITY_DATASET!,
  apiVersion: "2025-01-01",
  token: process.env.SANITY_TOKEN,
  useCdn: false,
  requestTagPrefix: "performance-testing",
});
```

Key settings:
- `useCdn: false` — explain plans are metadata, not cacheable query results
- `requestTagPrefix` — identifies test traffic in Sanity request logs
- Rate limiting is handled automatically by `@sanity/client` (retries with backoff)

Register custom matchers in the Vitest config:

```ts
// vitest.perf.config.ts
export default defineConfig({
  test: { setupFiles: ["vitest-groq/plan-matchers"] },
});
```

## Writing explain tests

```ts
import { explain } from "vitest-groq";

it("fetches recent posts efficiently", async () => {
  const { characteristics } = await explain(client, query, params);
  expect(characteristics).toMatchSnapshot();
  expect(characteristics).toHaveNoDuplicateFetches();
  expect(characteristics).toHaveNoFilterStep();
});
```

### Custom matchers

| Matcher                      | What it verifies                                            |
| ---------------------------- | ----------------------------------------------------------- |
| `toHaveNoDuplicateFetches()` | Each subquery runs once (no duplicate Fetch filters)        |
| `toHaveNoFilterStep()`       | All filters pushed to index (no in-memory scanning)         |
| `toHaveSortInFetch()`        | Sort pushed to index (no in-memory materialization)         |
| `toHaveLimitInFetch()`       | Limit pushed to index (fetches only the rows needed)        |

**Every explain test** should have `toMatchSnapshot()` + `toHaveNoDuplicateFetches()`. Add others when the query achieves the corresponding optimization.

### Native matchers for budgets

```ts
expect(characteristics.fetchCount).toBeLessThanOrEqual(3);
expect(characteristics.resolveRefCount).toBeLessThanOrEqual(2);
expect(characteristics.steps).not.toContain("SortStep");
```

## Testing query business logic (in-memory)

The `vitest-groq/groq` entrypoint wraps groq-js for testing GROQ query logic without network or credentials:

```ts
import { groq } from "vitest-groq/groq";

const dataset = [
  { _type: "post", _id: "post-1", title: "Hello" },
  { _type: "author", _id: "author-1", name: "Alice" },
];

const result = await groq(`*[_type == "post"]{ title }`, dataset);
```

Partial application binds a shared dataset:

```ts
const run = groq(dataset, { timestamp: new Date("2025-03-17T00:00:00Z") });
const result = await run(recentPostsQuery);
```

Options: `params`, `timestamp`, `identity`, `before`/`after` (delta), `sanity`, `mode`.

## Optimization patterns

Common patterns for improving execution plans:

**FilterStep (in-memory scan):**
- Move dereferences out of filters: `author->slug.current == $slug` → flip the lookup so `_ref in` stays indexable
- Ensure the filter field has a backing index

**SortStep (in-memory sort):**
- Sort on the same field the filter uses, or on `_createdAt`/`_updatedAt` which have default indexes

**No limit pushdown:**
- Place the slice immediately after `order()`: `| order(field desc)[0..9]`

**Duplicate fetches:**
- Avoid repeating the same subquery in multiple projections — extract it to a variable or restructure

## Reference documentation

For complete guides, read these project docs:
- `docs/optimization.md` — optimization patterns and query rewrites
- `docs/plan-elements.md` — every source node and pipeline step
- `docs/groq-testing.md` — in-memory query testing (time, delta, identity, fidelity notes)
- `docs/why-test-groq.md` — business logic and performance testing compared with other approaches
