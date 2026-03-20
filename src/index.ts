import type { SanityClient } from "@sanity/client";

/**
 * Snapshot-friendly summary of a GROQ execution plan.
 *
 * Use with `toMatchSnapshot()` to detect plan regressions, and with
 * custom matchers (`toHaveNoFilterStep()`, etc.) to guard specific optimizations.
 *
 * @example
 * ```ts
 * const { characteristics } = await explain(client, query);
 * expect(characteristics).toMatchSnapshot();
 * expect(characteristics).toHaveNoFilterStep();
 * ```
 *
 * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ}
 */
export interface PlanCharacteristics {
  /**
   * `true` when all filters are handled at the index (inside Fetch nodes).
   * `false` means a `FilterStep` is scanning every fetched row in memory — O(n).
   *
   * Guard with `expect(c).toHaveNoFilterStep()`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#reference-filter-expressions | High performance GROQ — Filter expressions}
   */
  noFilterStep: boolean;
  /**
   * `true` when at least one Fetch includes `Sort:` — rows arrive pre-sorted from the index.
   * `false` means a `SortStep` materializes all rows in memory to sort them.
   *
   * Guard with `expect(c).toHaveSortInFetch()`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#sorting | High performance GROQ — Sorting}
   */
  sortInFetch: boolean;
  /**
   * `true` when at least one Fetch includes `Limit:` — only the needed rows leave the index.
   * `false` means all matching rows are fetched then discarded via `SliceStep`.
   *
   * Guard with `expect(c).toHaveLimitInFetch()`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#deep-array-indexing-and-slicing | High performance GROQ — Slicing}
   */
  limitInFetch: boolean;
  /**
   * Ordered, deduplicated list of plan elements (pipeline steps and source nodes).
   *
   * @example
   * ```ts
   * expect(c.steps).toContain("HashBatchStep");
   * expect(c.steps).not.toContain("SortStep");
   * ```
   */
  steps: string[];
  /**
   * Number of Fetch nodes with non-trivial filters.
   *
   * @example
   * ```ts
   * expect(c.fetchCount).toBeLessThanOrEqual(3);
   * ```
   */
  fetchCount: number;
  /**
   * Fetch filters that appear more than once — each is a redundant round-trip.
   * An empty array means no duplicates (the ideal state).
   *
   * Guard with `expect(c).toHaveNoDuplicateFetches()`, or use a threshold:
   * `expect(c.duplicateFetches.length).toBeLessThan(2)`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#avoid-joins-in-filters | High performance GROQ — Avoid joins in filters}
   */
  duplicateFetches: string[];
  /**
   * Number of `ResolveRefStep` nodes — each is a batched reference lookup.
   *
   * @example
   * ```ts
   * expect(c.resolveRefCount).toBeLessThanOrEqual(2);
   * ```
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq#avoid-repeated-resolving-of-references | High performance GROQ — Reference resolution}
   */
  resolveRefCount: number;
}

/** The full response from {@link explain}, including raw output and parsed characteristics. */
export interface ExplainResult {
  /** The raw explain string returned by Content Lake. */
  raw: string;
  /** Server-side query execution time in milliseconds. */
  ms: number;
  /** Number of documents in the query result. */
  resultCount: number;
  /** Parsed plan summary — use this for assertions and snapshots. */
  characteristics: PlanCharacteristics;
}

/**
 * Send a GROQ query to Content Lake with `explain=true` and get back
 * the execution plan as structured, snapshot-friendly characteristics.
 *
 * @example
 * ```ts
 * const { characteristics } = await explain(client, query, { slug: "hello" });
 * expect(characteristics).toMatchSnapshot();
 * expect(characteristics).toHaveNoDuplicateFetches();
 * ```
 */
export async function explain(
  client: SanityClient,
  query: string,
  params?: Record<string, unknown>,
): Promise<ExplainResult> {
  const queryParams: Record<string, string> = { query, explain: "true" };
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      queryParams[`$${key}`] = JSON.stringify(value);
    }
  }

  const {
    explain: raw,
    ms,
    result,
  } = await client.request<{
    ms: number;
    explain: string;
    result?: unknown[];
  }>({
    uri: client.getDataUrl("query"),
    query: queryParams,
  });

  return {
    raw,
    ms,
    resultCount: result?.length ?? 0,
    characteristics: parsePlan(raw),
  };
}

/**
 * Parse a raw explain string into {@link PlanCharacteristics}.
 *
 * Use this when you already have the explain output (e.g. from a CLI script
 * or logged response) and want to run assertions against it.
 *
 * @example
 * ```ts
 * const characteristics = parsePlan(rawExplainString);
 * expect(characteristics).toMatchSnapshot();
 * ```
 */
export function parsePlan(raw: string): PlanCharacteristics {
  const hasFilterStep = raw.includes("FilterStep");

  // Extract unique step types in order of first appearance
  const stepRegex = /\b([A-Z][a-zA-Z]+(?:Step)?)\s*\{/g;
  const seen = new Set<string>();
  const steps: string[] = [];
  let match;
  while ((match = stepRegex.exec(raw)) !== null) {
    const step = match[1]!;
    if (!seen.has(step)) {
      seen.add(step);
      steps.push(step);
    }
  }

  // Analyze fetch operations for duplicates and pushdown
  const fetchAnalysis = analyzeRepeatedFetches(raw);

  // Count ResolveRefStep instances (not deduplicated — each is a batched network call)
  const resolveRefCount = (raw.match(/ResolveRefStep\s*\{/g) || []).length;

  return {
    noFilterStep: !hasFilterStep,
    sortInFetch: fetchAnalysis.hasSortPushdown,
    limitInFetch: fetchAnalysis.hasLimitPushdown,
    steps,
    fetchCount: fetchAnalysis.totalFetches,
    duplicateFetches: fetchAnalysis.duplicateFilters.map((d) => d.normalizedFilter),
    resolveRefCount,
  };
}

interface FetchAnalysis {
  totalFetches: number;
  duplicateFilters: Array<{ normalizedFilter: string; count: number }>;
  hasSortPushdown: boolean;
  hasLimitPushdown: boolean;
}

function normalizeFilter(filter: string): string {
  return filter.replace(/\$\d+/g, "$VAR").replace(/\s+/g, " ").trim();
}

/**
 * Analyze Fetch nodes in the execution plan.
 *
 * Detects:
 * - Repeated filter patterns (redundant subqueries)
 * - Sort pushdown (Sort: field present in a Fetch node)
 * - Limit pushdown (Limit: N present in a Fetch node)
 */
function analyzeRepeatedFetches(raw: string): FetchAnalysis {
  const fetchRegex = /Fetch \{[^}]*Filter: ([^\n]+)/g;
  const filters: string[] = [];

  let match;
  while ((match = fetchRegex.exec(raw)) !== null) {
    if (match[1]) filters.push(match[1]);
  }

  const normalizedFilters = filters.map(normalizeFilter);

  const filterCounts = new Map<string, number>();
  for (const filter of normalizedFilters) {
    filterCounts.set(filter, (filterCounts.get(filter) || 0) + 1);
  }

  // Exclude literal boolean filters from duplicate detection — these are
  // optimizer-simplified no-ops (e.g. placeholder params that match nothing
  // produce `Filter: false`), not redundant subqueries.
  const duplicateFilters = Array.from(filterCounts.entries())
    .filter(([f, count]) => count > 1 && f !== "false" && f !== "true")
    .map(([normalizedFilter, count]) => ({ normalizedFilter, count }))
    .toSorted((a, b) => b.count - a.count);

  // Detect Sort/Limit pushdown inside Fetch nodes.
  // The query engine prints these fields only when the optimizer successfully
  // pushed them into the index-level fetch.
  const hasSortPushdown = /Fetch \{[^}]*Sort:/s.test(raw);
  const hasLimitPushdown = /Fetch \{[^}]*Limit:/s.test(raw);

  return {
    totalFetches: filters.length,
    duplicateFilters,
    hasSortPushdown,
    hasLimitPushdown,
  };
}
