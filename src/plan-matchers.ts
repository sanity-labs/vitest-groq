import { expect } from "vitest";

import { planMatchers } from "./_planMatchers";

expect.extend(planMatchers);

declare module "@vitest/expect" {
  interface Matchers<T = any> {
    /**
     * Assert no `FilterStep` in the execution plan.
     *
     * **Why:** FilterStep means in-memory filtering — every row from the Fetch
     * is evaluated against the predicate. For large datasets this is O(n).
     * When all filters are inside Fetch nodes, the index narrows the scan.
     *
     * Add when a query achieves `noFilterStep: true` in its snapshot.
     *
     * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#reference-filter-expressions | High performance GROQ — Filter expressions}
     */
    toHaveNoFilterStep(): T;

    /**
     * Assert `Sort:` appears inside a Fetch node (`Fetch { Sort: ... }`).
     *
     * **Why:** Without index-level sorting, a SortStep must materialize all
     * matching rows in memory and sort them. For queries returning many rows
     * this dominates latency. With Sort in Fetch, rows arrive pre-sorted.
     *
     * Add when a query achieves `sortInFetch: true` in its snapshot.
     *
     * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#sorting | High performance GROQ — Sorting}
     */
    toHaveSortInFetch(): T;

    /**
     * Assert `Limit:` appears inside a Fetch node (`Fetch { Limit: ... }`).
     *
     * **Why:** Without index-level limiting, the engine fetches ALL matching
     * rows then discards extras via SliceStep. With Limit in Fetch, only the
     * requested number of rows leave the index.
     *
     * Add when a query achieves `limitInFetch: true` in its snapshot.
     *
     * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#deep-array-indexing-and-slicing | High performance GROQ — Slicing}
     */
    toHaveLimitInFetch(): T;

    /**
     * Assert no Fetch filter pattern appears more than once.
     *
     * **Why:** Each duplicate Fetch filter is a redundant subquery — a separate
     * network round-trip to the index that returns the same rows. Consolidate
     * into a single fetch with a chained projection.
     *
     * Add to **every** explain test (universal guard).
     *
     * For threshold-based checks, use native matchers instead:
     * `expect(c.duplicateFetches.length).toBeLessThan(2)`
     *
     * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#avoid-joins-in-filters | High performance GROQ — Avoid joins in filters}
     */
    toHaveNoDuplicateFetches(): T;
  }
}
