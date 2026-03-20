# Why Test GROQ

GROQ queries are the bridge between your content and your frontend. They encode business logic — which documents to show, how to sort them, what shape to return — and that logic deserves the same test coverage as the rest of your application code.

Testing GROQ gives you confidence in two dimensions:

1. **Business logic** — filters return the right documents, projections produce the expected shape, reference traversals handle edge cases. These are testable in isolation, independent of dataset size or server behavior.

2. **Performance** — the execution plan uses indexes efficiently, sorts and limits are pushed down, and subqueries are batched. These are structural properties you can verify deterministically.

`vitest-groq` provides one tool for each:

- **`groq()`** runs queries against in-memory datasets via groq-js. No network, no credentials, millisecond execution. Pin down filter logic, projections, and edge cases.
- **`explain()`** snapshots the execution plan Content Lake will use. Deterministic, structural, and independent of dataset size. Lock in the performance strategy.

## How the tools complement each other

Unit tests with `groq()` confirm the query returns the right data. Execution plan snapshots with `explain()` confirm it fetches the data efficiently. Together they cover both dimensions:

- Business logic tests verify the contract holds — output shape, filter rules, edge cases.
- Execution plan tests verify the strategy holds — indexed fetches, pushed-down sorts, batched subqueries.

The testing workflow: write `groq()` tests first to pin down the contract. Then add `explain()` snapshots for data-fetching queries. When you refactor a query for performance, the unit tests are the gate: if the contract changed, the optimization doesn't ship. Once the contract holds, the snapshot diff shows the structural improvement.

## What lint rules cover (and where testing adds value)

[sanity-lint](https://github.com/sanity-labs/sanity-lint) verifies _known patterns_ statically — a valuable first layer. Testing adds value in areas linting can't reach:

1. **Optimizer behavior.** The mapping from GROQ syntax to execution plan is not 1:1. A query that follows every lint rule may still get a different plan than expected. Testing verifies the actual plan.
2. **Regression detection across refactors.** Rewriting `count(array)` to `count(array[condition])` might be functionally identical but change the plan. Snapshots make this visible.
3. **Business logic verification.** A filter like `_type == "post" && published` that should be `_type == "post" && published == true` is syntactically valid but logically different. Unit tests verify the actual output.
4. **Complex query composition.** Queries using chained projections, nested subqueries, `HashBatchStep`/`UnionBatchStep` batching, and `ResolveRefStep` reference resolution get optimized based on the Content Lake optimizer version and query planner heuristics — testing verifies the result.

## What timing assertions cover

Asserting on wall-clock time (e.g., "this query must complete in < 50ms") measures real latency, which is useful for end-to-end budgets. Execution plan testing complements this with deterministic structural assertions:

- **Stable.** The same query always produces the same plan, regardless of Content Lake load, caching, or network conditions.
- **Dataset-independent.** Plans are structural — they don't drift as data grows.
- **CI-friendly.** No flakiness from timing variance.

## What runtime observability covers

Sanity's own query-classifier (now archived) and tools like api-devtools analyze real production traffic — essential for understanding actual usage patterns. Testing complements this by shifting verification earlier:

- **Pre-deploy.** Every query is verified before it reaches production.
- **Zero-infrastructure.** Local execution + one API call per explain test.
- **First-commit coverage.** New queries are tested immediately, without waiting for production traffic.

## Comparison

| Approach                             | Verifies logic | Verifies performance | Pre-deploy | Deterministic |
| ------------------------------------ | :------------: | :------------------: | :--------: | :-----------: |
| Lint (sanity-lint)                   |    Patterns    |          —           |    Yes     |      Yes      |
| Timing assertions                    |       —        |       Latency        |    Yes     |      No       |
| Runtime observability (api-devtools) |       —        |     Real traffic     |     No     |      N/A      |
| **groq() unit tests**               |   **Output**   |          —           |  **Yes**   |    **Yes**    |
| **explain() snapshots**              |       —        |     **Strategy**     |  **Yes**   |    **Yes**    |

## Scope and complementary tools

Each tool in the stack has a natural scope. Where vitest-groq's scope ends, other tools pick up:

| Scope boundary                                  | What covers it                                                          | How to combine                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **groq-js feature coverage**                     | Content Lake implements features groq-js doesn't yet (see [fidelity notes](groq-testing.md#fidelity-gaps)) | Test those paths in staging or with explain tests                  |
| **Latency at scale**                            | Same plan, more data = different timing. Snapshots verify structure.    | Complement with periodic benchmarks or timing assertions          |
| **New query coverage**                          | A new query has no snapshot until its first test run.                   | Convention: add an explain test alongside every new query.         |
| **Cross-query interactions**                    | One query's load affecting another is a runtime concern.                | Runtime monitoring (api-devtools, Sanity dashboard).              |
| **Optimizer improvements**                      | Sanity ships a better optimizer; plans change beneficially.             | Update snapshots after verifying the new plan is equal or better. |
