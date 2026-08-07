---
name: vitest-groq
description: Test GROQ queries with vitest-groq. Use when writing business logic tests (groq()), explain tests, diagnosing query performance, improving execution plans, or testing query contracts in-memory.
argument-hint: <query-or-file>
metadata:
  version: "1.0.0"
---

# vitest-groq

Bring your GROQ queries into your test suite. Pin down the business logic, guard the execution plan, and catch regressions when queries change.

## What you do

Follow the full testing cycle. Business logic first, then performance:

1. **Read the query.** Understand the GROQ query, what it filters, projects, and joins.
2. **Lock the contract.** Write `groq()` unit tests with a small in-memory dataset. Assert on output shape, filter behavior, and edge cases. These are the gate for all future changes.
3. **Guard the execution plan.** Write an `explain()` test with `toMatchSnapshot()` + `toHaveNoDuplicateFetches()`. Read the snapshot to understand the current strategy.
4. **Improve the query.** If the snapshot reveals a FilterStep, SortStep, or other concern, refactor the query (see optimization patterns below). Run the `groq()` tests to confirm the contract held, then update the snapshot and add targeted assertions (e.g. `toHaveNoFilterStep()`) to lock in the improvement.

## Locking the contract (groq())

The `vitest-groq/groq` entrypoint wraps groq-js for testing query logic without network or credentials. Always write these first.

```ts
import { groq } from "vitest-groq/groq";

const dataset = [
  { _type: "post", _id: "post-1", title: "Hello" },
  { _type: "author", _id: "author-1", name: "Alice" },
];

const result = await groq(dataset, `*[_type == "post"]{ title }`);
```

Partial application binds a shared dataset:

```ts
const run = groq(dataset, { timestamp: new Date("2025-03-17T00:00:00Z") });
const result = await run(recentPostsQuery);
```

Options: `params`, `timestamp`, `identity`, `before`/`after` (delta), `sanity`, `mode`.

## Guarding the execution plan (explain())

Explain tests require a Sanity client with real credentials:

```ts
const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID!,
  dataset: process.env.SANITY_DATASET!,
  apiVersion: "2025-01-01",
  token: process.env.SANITY_AUTH_TOKEN,
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

Start every explain test with `toMatchSnapshot()` + `toHaveNoDuplicateFetches()`. Read the snapshot to understand the plan. Add targeted matchers only after improving the query:

```ts
import { explain } from "vitest-groq";

it("uses indexed fetches", async () => {
  const { characteristics } = await explain(client, query, params);
  expect(characteristics).toMatchSnapshot();
  expect(characteristics).toHaveNoDuplicateFetches();
});
```

### Custom matchers

| Matcher                      | What it verifies                                     |
| ---------------------------- | ---------------------------------------------------- |
| `toHaveNoDuplicateFetches()` | Each subquery runs once (no duplicate Fetch filters) |
| `toHaveNoFilterStep()`       | All filters pushed to index (no in-memory scanning)  |
| `toHaveSortInFetch()`        | Sort pushed to index (no in-memory materialization)  |
| `toHaveLimitInFetch()`       | Limit pushed to index (fetches only the rows needed) |

### Native matchers for budgets

```ts
expect(characteristics.fetchCount).toBeLessThanOrEqual(3);
expect(characteristics.resolveRefCount).toBeLessThanOrEqual(2);
expect(characteristics.steps).not.toContain("SortStep");
```

## Improving the query

When a snapshot reveals a FilterStep, SortStep, or other concern, refactor the query. Always run the `groq()` tests first to confirm the contract held, then update the snapshot.

**FilterStep (in-memory scan):**

- Move dereferences out of filters: `author->active != false` → `author._ref in *[_type == "author" && active != false]._id`
- Use set membership (`_id in` / `_ref in`) so the filter stays indexable

**SortStep (in-memory sort):**

- Sort on the same field the filter uses, or on `_createdAt`/`_updatedAt` which have default indexes

**No limit pushdown:**

- Place the slice immediately after `order()`: `| order(field desc)[0..9]`

**Duplicate fetches:**

- Avoid repeating the same subquery in multiple projections. Extract it to a chained projection.

## Reference documentation

For complete guides, read these project docs:

- `docs/optimization.md` — optimization patterns and query rewrites
- `docs/plan-elements.md` — every source node and pipeline step
- `docs/groq-testing.md` — in-memory query testing (time, delta, identity, fidelity notes)
- `docs/why-test-groq.md` — business logic and performance testing compared with other approaches
