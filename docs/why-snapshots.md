# Why Snapshots (and Not Something Else)

Execution plan snapshots are **structural and deterministic**. The same query with the same optimizer produces the same plan regardless of dataset size or server load. They fill the gap between static analysis and runtime observability.

## Why not just lint rules?

[sanity-lint](https://github.com/sanity-labs/sanity-lint) catches _known bad patterns_ statically. It's necessary but not sufficient:

1. **It can't predict optimizer behavior.** A query can pass all lint rules and still get a `FilterStep` because the optimizer chose differently. The mapping from GROQ syntax to execution plan is not 1:1.
2. **It can't detect regressions from "correct" refactors.** Rewriting `count(array)` to `count(array[condition])` might be functionally identical but change the plan.
3. **Complex queries compose unpredictably.** Queries using chained projections, nested subqueries, `HashBatchStep`/`UnionBatchStep` batching, and `ResolveRefStep` reference resolution get optimized based on the Content Lake optimizer version and query planner heuristics — not just the syntax.

## Why not timing assertions?

Asserting on wall-clock time (e.g., "this query must complete in < 50ms") is tempting but unreliable:

- **Variance.** The same query on the same dataset can vary 2-10x depending on Content Lake load, caching, and network.
- **Dataset growth.** Timing drifts as data grows, causing false failures even when the plan is unchanged.
- **Flaky CI.** Timing-based tests are the #1 source of non-deterministic failures in CI pipelines.

## Why not a service like query-classifier?

Sanity's own query-classifier (now archived) classified queries as "slow" by analyzing historical query data server-side. The approach has merits but requires:

- Server-side infrastructure to collect and classify query data
- Production traffic to populate the data — new queries have no signal
- Retrospective detection — problems are found after they ship

The snapshot approach is **proactive** (pre-deploy), **zero-infrastructure** (one API call per test), and **covers every query from its first commit**.

## The snapshot sweet spot

| Approach                             | Catches known patterns | Catches unknown regressions | Pre-deploy | Deterministic |
| ------------------------------------ | :--------------------: | :-------------------------: | :--------: | :-----------: |
| Lint (sanity-lint)                   |          Yes           |             No              |    Yes     |      Yes      |
| Timing assertions                    |           No           |          Partially          |    Yes     |      No       |
| Runtime observability (api-devtools) |           No           |             Yes             |     No     |      N/A      |
| **Explain snapshots**                |          Yes           |           **Yes**           |  **Yes**   |    **Yes**    |

The key differentiator: snapshots catch **unknown unknowns** — plan changes you didn't anticipate, caused by query refactors, new GROQ features, or optimizer updates.

## Blind spots and limitations

Be honest about what explain snapshots don't cover:

| Blind spot                                      | Why                                                                     | Mitigation                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Timing regressions from data growth**         | Same plan, more data = slower. Snapshots test structure, not speed.     | Periodic benchmarks with a CLI explain script                     |
| **New queries with no baseline**                | No snapshot = no protection until first run.                            | Convention: add an explain test for every new query.              |
| **Cross-query interactions**                    | One query's load affecting another's latency is invisible.              | Runtime monitoring (api-devtools, Sanity dashboard).              |
| **False positives from optimizer improvements** | Sanity ships a better optimizer, plans change beneficially, tests fail. | Update snapshots after verifying the new plan is equal or better. |
