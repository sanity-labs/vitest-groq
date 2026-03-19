import type { PlanCharacteristics } from "./index";

const GROQ_PERF_GUIDE = "https://www.sanity.io/docs/developer-guides/high-performance-groq";

export const planMatchers = {
  toHaveNoFilterStep(this: { isNot?: boolean }, characteristics: PlanCharacteristics) {
    const filterSteps = characteristics.steps.filter((s) => s === "FilterStep");

    return {
      pass: characteristics.noFilterStep,
      message: (): string =>
        this.isNot
          ? `expected plan to have a FilterStep, but all filters are inside Fetch nodes`
          : `FilterStep present — the query is filtering rows in memory after fetching ` +
            `them from the index. This is O(n) over the full dataset.\n` +
            `Previously all filters were inside Fetch nodes (index-level filtering).\n\n` +
            `Plan steps: [${characteristics.steps.join(", ")}]` +
            (filterSteps.length > 0 ? `\nFilterStep count: ${filterSteps.length}` : "") +
            `\n\nSee: ${GROQ_PERF_GUIDE}`,
      actual: characteristics.noFilterStep,
      expected: true,
    };
  },

  toHaveSortInFetch(this: { isNot?: boolean }, characteristics: PlanCharacteristics) {
    const hasSortStep = characteristics.steps.includes("SortStep");

    return {
      pass: characteristics.sortInFetch,
      message: (): string =>
        this.isNot
          ? `expected sort to NOT be in Fetch node, but Fetch { Sort: ... } is present`
          : `Sort not in Fetch node — the query must sort all fetched rows in memory ` +
            `via SortStep. For large result sets this dominates latency.\n` +
            `Previously the sort was handled at the index inside a Fetch node.\n\n` +
            `Plan steps: [${characteristics.steps.join(", ")}]` +
            (hasSortStep
              ? `\nSortStep is present in the plan (in-memory sort).`
              : `\nNo SortStep in the plan — sort may be absent entirely.`) +
            `\n\nSee: ${GROQ_PERF_GUIDE}`,
      actual: characteristics.sortInFetch,
      expected: true,
    };
  },

  toHaveLimitInFetch(this: { isNot?: boolean }, characteristics: PlanCharacteristics) {
    const hasSliceStep = characteristics.steps.includes("SliceStep");

    return {
      pass: characteristics.limitInFetch,
      message: (): string =>
        this.isNot
          ? `expected limit to NOT be in Fetch node, but Fetch { Limit: ... } is present`
          : `Limit not in Fetch node — the engine fetches ALL matching rows then ` +
            `discards extras in memory via SliceStep.\n` +
            `Previously the limit was handled at the index inside a Fetch node.\n\n` +
            `Plan steps: [${characteristics.steps.join(", ")}]` +
            (hasSliceStep
              ? `\nSliceStep is present in the plan (in-memory slicing).`
              : `\nNo SliceStep in the plan — limit may be absent entirely.`) +
            `\n\nSee: ${GROQ_PERF_GUIDE}`,
      actual: characteristics.limitInFetch,
      expected: true,
    };
  },

  toHaveNoDuplicateFetches(this: { isNot?: boolean }, characteristics: PlanCharacteristics) {
    const dupes = characteristics.duplicateFetches;

    return {
      pass: dupes.length === 0,
      message: (): string =>
        this.isNot
          ? `expected duplicate Fetch filters, but none were found`
          : `Duplicate Fetch filters found — each is a redundant subquery that ` +
            `makes a separate network round-trip to the index.\n` +
            `Consolidate into a single fetch with a chained projection.\n\n` +
            `Duplicated patterns (${dupes.length}):\n` +
            dupes.map((f) => `  - ${f}`).join("\n") +
            `\n\nSee: ${GROQ_PERF_GUIDE}`,
      actual: dupes,
      expected: [],
    };
  },
};
