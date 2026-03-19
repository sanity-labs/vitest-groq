/**
 * Structural subset of `SanityClient` — avoids concrete class coupling
 * so consumers don't hit duplicate-package issues with `npm link` or
 * mismatched `@sanity/client` versions.
 */
export interface SanityClientLike {
  request<T>(options: { uri: string; query: Record<string, string> }): Promise<T>;
  getDataUrl(endpoint: string): string;
}

/**
 * Stable, snapshot-friendly characteristics extracted from a GROQ execution plan.
 *
 * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ}
 */
export interface PlanCharacteristics {
  /**
   * No `FilterStep` in the plan — all filters are inside Fetch nodes.
   *
   * When `false`, the engine is scanning rows in memory after fetching.
   * Guard with `expect(c).toHaveNoFilterStep()`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ — Filter expressions}
   */
  noFilterStep: boolean;
  /**
   * At least one `Fetch { Sort: ... }` — sort handled at the index.
   *
   * When `false`, a `SortStep` materializes all rows in memory to sort them.
   * Guard with `expect(c).toHaveSortInFetch()`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ — Sorting}
   */
  sortInFetch: boolean;
  /**
   * At least one `Fetch { Limit: ... }` — slice handled at the index.
   *
   * When `false`, all matching rows are fetched then discarded via `SliceStep`.
   * Guard with `expect(c).toHaveLimitInFetch()`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ — Slicing}
   */
  limitInFetch: boolean;
  /**
   * Ordered unique plan elements (pipeline steps + source nodes).
   *
   * Use native matchers: `expect(c.steps).toContain('HashBatchStep')`,
   * `expect(c.steps).not.toContain('SortStep')`.
   */
  steps: string[];
  /**
   * Number of Fetch nodes with non-trivial filters.
   *
   * Use native matchers: `expect(c.fetchCount).toBeLessThanOrEqual(3)`.
   */
  fetchCount: number;
  /**
   * Normalized Fetch filters appearing more than once.
   * Each entry is a redundant subquery — a separate network round-trip.
   *
   * Use native matchers: `expect(c.duplicateFetches).toEqual([])`,
   * or `expect(c.duplicateFetches.length).toBeLessThan(2)` for tolerance.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ — Avoid joins in filters}
   */
  duplicateFetches: string[];
  /**
   * Number of `ResolveRefStep` instances (batched reference lookups).
   *
   * Use native matchers: `expect(c.resolveRefCount).toBeLessThanOrEqual(3)`.
   *
   * @see {@link https://www.sanity.io/docs/developer-guides/high-performance-groq | High performance GROQ — Reference resolution}
   */
  resolveRefCount: number;
}

export interface ExplainResult {
  raw: string;
  ms: number;
  resultCount: number;
  characteristics: PlanCharacteristics;
}

/**
 * Run a GROQ query with `explain=true` against Content Lake and return
 * structured execution-plan characteristics suitable for snapshot testing.
 */
export async function explain(
  client: SanityClientLike,
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
 * Extract stable, snapshot-friendly characteristics from a raw explain plan.
 *
 * Shared by both the `explain()` test utility and CLI scripts.
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
