import { describe, expect, it } from "vitest";

import { parsePlan } from "../src/index";

// Fixture explain strings modeled on real query engine output.
// Multi-line Fetch blocks match the real explain output format.
// The filter regex captures to end-of-line, so filter must be on its own line.

const SIMPLE_FETCH = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "author"
        Sort: _createdAt DESC
        Limit: 10
      }
    }
    MapStep { ... }
    SliceStep { 0..10 }
  }
}
`;

const FILTER_STEP_PLAN = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "post"
      }
    }
    FilterStep { Expr: status == "published" }
    MapStep { ... }
  }
}
`;

const SORT_STEP_PLAN = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "post"
      }
    }
    SortStep { _createdAt DESC }
    SliceStep { 0..50 }
  }
}
`;

const HASH_BATCH_PLAN = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "post"
        Sort: _createdAt DESC
        Limit: 50
      }
    }
    MapStep { ... }
    HashBatchStep {
      Batch {
        Fetch {
          Filter: _type == "comment"
        }
      }
    }
    ResolveRefStep { ... }
    MapStep { ... }
  }
}
`;

const DUPLICATE_FETCH_PLAN = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "author"
      }
    }
    MapStep {
      Pipeline {
        StreamStep {
          Fetch {
            Filter: _type == "comment"
          }
        }
      }
      Pipeline {
        StreamStep {
          Fetch {
            Filter: _type == "comment"
          }
        }
      }
    }
  }
}
`;

const MULTIPLE_RESOLVE_REF = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "comment"
      }
    }
    ResolveRefStep { ... }
    MapStep { ... }
    ResolveRefStep { ... }
    ResolveRefStep { ... }
  }
}
`;

const BOOLEAN_FILTER_PLAN = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "post"
      }
    }
    MapStep {
      Pipeline {
        StreamStep {
          Fetch {
            Filter: false
          }
        }
      }
      Pipeline {
        StreamStep {
          Fetch {
            Filter: false
          }
        }
      }
    }
  }
}
`;

const AGGREGATE_PLAN = `
Root {
  Pipeline {
    StreamStep {
      Aggregate { Aggregations: [count], Filter: _type == "comment" }
    }
    MapStep { ... }
  }
}
`;

describe("parsePlan", () => {
  it("detects no FilterStep in a simple indexed query", () => {
    const result = parsePlan(SIMPLE_FETCH);
    expect(result.noFilterStep).toBe(true);
  });

  it("detects FilterStep when present", () => {
    const result = parsePlan(FILTER_STEP_PLAN);
    expect(result.noFilterStep).toBe(false);
  });

  it("detects sort pushdown in Fetch node", () => {
    const result = parsePlan(SIMPLE_FETCH);
    expect(result.sortInFetch).toBe(true);
  });

  it("detects missing sort pushdown", () => {
    const result = parsePlan(SORT_STEP_PLAN);
    expect(result.sortInFetch).toBe(false);
  });

  it("detects limit pushdown in Fetch node", () => {
    const result = parsePlan(SIMPLE_FETCH);
    expect(result.limitInFetch).toBe(true);
  });

  it("detects missing limit pushdown", () => {
    const result = parsePlan(FILTER_STEP_PLAN);
    expect(result.limitInFetch).toBe(false);
  });

  it("extracts unique steps in order of first appearance", () => {
    const result = parsePlan(HASH_BATCH_PLAN);
    expect(result.steps).toEqual([
      "Root",
      "Pipeline",
      "StreamStep",
      "Fetch",
      "MapStep",
      "HashBatchStep",
      "Batch",
      "ResolveRefStep",
    ]);
  });

  it("counts Fetch nodes with filters", () => {
    const result = parsePlan(HASH_BATCH_PLAN);
    expect(result.fetchCount).toBe(2);
  });

  it("detects duplicate Fetch filters", () => {
    const result = parsePlan(DUPLICATE_FETCH_PLAN);
    expect(result.duplicateFetches).toEqual(['_type == "comment"']);
  });

  it("excludes boolean filters from duplicate detection", () => {
    const result = parsePlan(BOOLEAN_FILTER_PLAN);
    expect(result.duplicateFetches).toEqual([]);
  });

  it("counts ResolveRefStep instances", () => {
    const result = parsePlan(MULTIPLE_RESOLVE_REF);
    expect(result.resolveRefCount).toBe(3);
  });

  it("normalizes variable names in duplicate detection", () => {
    const plan = `
Root {
  Pipeline {
    StreamStep {
      Fetch {
        Filter: _type == "post" && _id == $1
      }
    }
    MapStep {
      Pipeline {
        StreamStep {
          Fetch {
            Filter: _type == "post" && _id == $2
          }
        }
      }
    }
  }
}
`;
    const result = parsePlan(plan);
    expect(result.duplicateFetches).toEqual(['_type == "post" && _id == $VAR']);
  });

  it("handles Aggregate source nodes", () => {
    const result = parsePlan(AGGREGATE_PLAN);
    expect(result.steps).toContain("Aggregate");
    expect(result.noFilterStep).toBe(true);
  });

  it("returns zero fetchCount for aggregate-only plans", () => {
    const result = parsePlan(AGGREGATE_PLAN);
    expect(result.fetchCount).toBe(0);
  });

  it("returns empty results for an empty plan", () => {
    const result = parsePlan("");
    expect(result).toEqual({
      noFilterStep: true,
      sortInFetch: false,
      limitInFetch: false,
      steps: [],
      fetchCount: 0,
      duplicateFetches: [],
      resolveRefCount: 0,
    });
  });
});
