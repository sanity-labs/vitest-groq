# Execution Plan Glossary

The explain output is a tree of named blocks. There are two categories: **source nodes** (where data comes from) and **pipeline steps** (transformations applied to streaming rows).

## Source nodes

| Node                                             | Meaning                                                                       | Performance                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Fetch { Filter: ... }`                          | Index-level fetch with filter pushed down                                     | Fast — filter evaluated at storage layer                    |
| `Aggregate { Aggregations: [...], Filter: ... }` | Index-level aggregation (`count`, `math::sum`, etc.)                          | Fast — computed at storage layer without materializing rows |
| `Pipeline { ... }`                               | A pipeline of steps producing a result                                        | Structural — wraps a sequence of steps                      |
| `Root { ... }`                                   | Top-level scope with bound variables                                          | Structural                                                  |
| `Projection { ... }`                             | Object projection (`{ field1, field2 }`)                                      | Structural                                                  |
| `Batch { ... }`                                  | Batch sub-plan with aggregates (used inside `HashBatchStep`/`UnionBatchStep`) | Structural                                                  |
| `ArraySource { ... }`                            | Streams rows from an in-memory array                                          | Depends on array size                                       |

## Pipeline steps

| Step                             | Meaning                                                       | Performance                           |
| -------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `StreamStep`                     | Source step — streams rows from a `Fetch` or `Aggregate` node | Depends on source                     |
| `FilterStep { Expr: ... }`       | **In-memory filtering** after fetch                           | **Slow** — filter NOT pushed to index |
| `MapStep`                        | Computes new columns per row (projections, expressions)       | Fast                                  |
| `ExtendStep`                     | Binds parent-scope variables into the pipeline                | Fast                                  |
| `FlatMapStep`                    | Flattens arrays into individual rows                          | Fast                                  |
| `SliceStep`                      | Applies limit/offset (`[0..N]`)                               | Reduces data                          |
| `SortStep`                       | Sorts rows by one or more expressions                         | O(n log n)                            |
| `HashBatchStep`                  | Hash-join for correlated subqueries — batches lookups         | Efficient — avoids N+1                |
| `UnionBatchStep`                 | Union-batch join — aggregates source frames, executes batch   | Efficient — avoids N+1                |
| `NestJoinStep`                   | Aggregated left outer join (inverse of `FlatMapStep`)         | Fast                                  |
| `ResolveRefStep` / `ResolveRefs` | Batched reference resolution (`->` dereferences)              | Network — batched                     |
| `KeyStep`                        | Captures `key()` for array join operations                    | Fast                                  |
| `ScoreStep`                      | Scores rows for `score()` / search relevance                  | Depends on expressions                |
