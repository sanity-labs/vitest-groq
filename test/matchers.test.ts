import { describe, expect, it } from "vitest";

import type { PlanCharacteristics } from "../src/index";
import { planMatchers } from "../src/_planMatchers";

function makeCharacteristics(overrides: Partial<PlanCharacteristics> = {}): PlanCharacteristics {
  return {
    noFilterStep: true,
    sortInFetch: true,
    limitInFetch: true,
    steps: ["Root", "Pipeline", "StreamStep", "Fetch", "MapStep"],
    fetchCount: 1,
    duplicateFetches: [],
    resolveRefCount: 0,
    ...overrides,
  };
}

describe("toHaveNoFilterStep", () => {
  it("passes when noFilterStep is true", () => {
    const result = planMatchers.toHaveNoFilterStep.call(
      { isNot: false },
      makeCharacteristics({ noFilterStep: true }),
    );
    expect(result.pass).toBe(true);
  });

  it("fails when noFilterStep is false", () => {
    const result = planMatchers.toHaveNoFilterStep.call(
      { isNot: false },
      makeCharacteristics({ noFilterStep: false, steps: ["Root", "FilterStep", "Fetch"] }),
    );
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("FilterStep present");
    expect(result.message()).toContain("O(n)");
  });

  it("produces .isNot message", () => {
    const result = planMatchers.toHaveNoFilterStep.call(
      { isNot: true },
      makeCharacteristics({ noFilterStep: true }),
    );
    expect(result.message()).toContain("expected plan to have a FilterStep");
  });
});

describe("toHaveSortInFetch", () => {
  it("passes when sortInFetch is true", () => {
    const result = planMatchers.toHaveSortInFetch.call(
      { isNot: false },
      makeCharacteristics({ sortInFetch: true }),
    );
    expect(result.pass).toBe(true);
  });

  it("fails when sortInFetch is false", () => {
    const result = planMatchers.toHaveSortInFetch.call(
      { isNot: false },
      makeCharacteristics({ sortInFetch: false, steps: ["Root", "SortStep", "Fetch"] }),
    );
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("Sort not in Fetch node");
    expect(result.message()).toContain("SortStep is present");
  });

  it("notes when SortStep is absent entirely", () => {
    const result = planMatchers.toHaveSortInFetch.call(
      { isNot: false },
      makeCharacteristics({ sortInFetch: false }),
    );
    expect(result.message()).toContain("sort may be absent entirely");
  });

  it("produces .isNot message", () => {
    const result = planMatchers.toHaveSortInFetch.call(
      { isNot: true },
      makeCharacteristics({ sortInFetch: true }),
    );
    expect(result.message()).toContain("expected sort to NOT be in Fetch node");
  });
});

describe("toHaveLimitInFetch", () => {
  it("passes when limitInFetch is true", () => {
    const result = planMatchers.toHaveLimitInFetch.call(
      { isNot: false },
      makeCharacteristics({ limitInFetch: true }),
    );
    expect(result.pass).toBe(true);
  });

  it("fails when limitInFetch is false", () => {
    const result = planMatchers.toHaveLimitInFetch.call(
      { isNot: false },
      makeCharacteristics({ limitInFetch: false, steps: ["Root", "SliceStep", "Fetch"] }),
    );
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("Limit not in Fetch node");
    expect(result.message()).toContain("SliceStep is present");
  });

  it("notes when SliceStep is absent entirely", () => {
    const result = planMatchers.toHaveLimitInFetch.call(
      { isNot: false },
      makeCharacteristics({ limitInFetch: false }),
    );
    expect(result.message()).toContain("limit may be absent entirely");
  });

  it("produces .isNot message", () => {
    const result = planMatchers.toHaveLimitInFetch.call(
      { isNot: true },
      makeCharacteristics({ limitInFetch: true }),
    );
    expect(result.message()).toContain("expected limit to NOT be in Fetch node");
  });
});

describe("toHaveNoDuplicateFetches", () => {
  it("passes when no duplicates", () => {
    const result = planMatchers.toHaveNoDuplicateFetches.call(
      { isNot: false },
      makeCharacteristics({ duplicateFetches: [] }),
    );
    expect(result.pass).toBe(true);
  });

  it("fails when duplicates exist", () => {
    const result = planMatchers.toHaveNoDuplicateFetches.call(
      { isNot: false },
      makeCharacteristics({ duplicateFetches: ['_type == "comment"'] }),
    );
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("Duplicate Fetch filters found");
    expect(result.message()).toContain('_type == "comment"');
  });

  it("lists multiple duplicates", () => {
    const result = planMatchers.toHaveNoDuplicateFetches.call(
      { isNot: false },
      makeCharacteristics({
        duplicateFetches: ['_type == "comment"', '_type == "post"'],
      }),
    );
    expect(result.message()).toContain("Duplicated patterns (2)");
    expect(result.message()).toContain('_type == "comment"');
    expect(result.message()).toContain('_type == "post"');
  });

  it("produces .isNot message", () => {
    const result = planMatchers.toHaveNoDuplicateFetches.call(
      { isNot: true },
      makeCharacteristics({ duplicateFetches: [] }),
    );
    expect(result.message()).toContain("expected duplicate Fetch filters, but none were found");
  });
});
