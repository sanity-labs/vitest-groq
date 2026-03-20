# GROQ Optimization Patterns

These patterns show how to improve a query's execution plan, how to rewrite for better index usage, and which assertions to add. See the [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq) guide for the complete reference.

---

## FilterStep: in-memory filtering

**Symptom:** `toHaveNoFilterStep()` fails — a `FilterStep` is scanning every fetched row in memory.

The most common cause is `count()` inside a filter predicate. The query engine can't push a correlated count to the index. See the "Reference: Filter expressions" section of [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq) for which filters can be pushed down.

```groq
// BAD — forces FilterStep, O(n × m)
*[_type == "post" && count(*[_type == "comment" && post._ref == ^._id]) > 0]
```

**Rewrite** using set membership — the engine builds the set once, then pushes `_id in <set>` to the index:

```groq
// GOOD — no FilterStep, O(n + m)
*[_type == "post" && _id in *[_type == "comment"].post._ref]
```

**Test:**

```ts
const { characteristics } = await explain(client, postsWithCommentsQuery);
expect(characteristics).toMatchSnapshot();
expect(characteristics).toHaveNoDuplicateFetches();
expect(characteristics).toHaveNoFilterStep();
```

---

## SortStep: in-memory sorting

**Symptom:** `toHaveSortInFetch()` fails — a `SortStep` is materializing all matching rows in memory to sort them.

This happens when the sort expression isn't eligible for index-level pushdown. Common causes: sorting on a computed expression, sorting after an in-memory filter, or sorting on a field that isn't a plain attribute. See the "Sorting" section of [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq) for which sort expressions can be pushed down.

```groq
// BAD — sort can't be pushed to index after FilterStep
*[_type == "post" && count(*[_type == "comment" && post._ref == ^._id]) > 0]
  | order(_createdAt desc)[0..10]
```

**Rewrite** to make the filter indexable first — once the engine can push the filter into the Fetch, it can often push the sort too:

```groq
// GOOD — filter and sort both pushed to index
*[_type == "post" && _id in *[_type == "comment"].post._ref]
  | order(_createdAt desc)[0..10]
```

**Test:**

```ts
const { characteristics } = await explain(client, recentCommentedPostsQuery);
expect(characteristics).toMatchSnapshot();
expect(characteristics).toHaveNoDuplicateFetches();
expect(characteristics).toHaveNoFilterStep();
expect(characteristics).toHaveSortInFetch();
```

For a stronger guarantee — no in-memory sort _anywhere_ in the plan:

```ts
expect(characteristics.steps).not.toContain("SortStep");
```

---

## SliceStep: in-memory slicing

**Symptom:** `toHaveLimitInFetch()` fails — the engine fetches ALL matching rows, then discards extras via `SliceStep`.

This usually follows the same root cause as SortStep — if the filter or sort can't be pushed to the index, the limit can't be either. See "Deep array indexing and slicing" in [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq).

```groq
// BAD — slice applied in memory after full scan
*[_type == "post" && defined(body)][0..10]
```

**Rewrite** — ensure the filter is indexable so the limit can be pushed down:

```groq
// GOOD — Fetch { Filter: ..., Limit: 11 }
*[_type == "post"][0..10]{ ..., "hasBody": defined(body) }
```

Or if you need the filter, make sure it's on indexed fields:

```groq
// GOOD — _type filter is always indexable, limit pushed to Fetch
*[_type == "post" && _id in *[_type == "post" && defined(body)]._id][0..10]
```

**Test:**

```ts
const { characteristics } = await explain(client, recentPostsQuery);
expect(characteristics).toMatchSnapshot();
expect(characteristics).toHaveNoDuplicateFetches();
expect(characteristics).toHaveLimitInFetch();
```

---

## Duplicate Fetch filters: redundant subqueries

**Symptom:** `toHaveNoDuplicateFetches()` fails — the same filter pattern appears in multiple Fetch nodes, meaning the engine runs the same subquery more than once. See "Avoid joins in filters" in [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq).

```groq
// BAD — fetches all comments twice (once per projected field)
*[_type == "author"]{
  name,
  "commentCount": count(*[_type == "comment" && author._ref == ^._id]),
  "recentComment": *[_type == "comment" && author._ref == ^._id]
    | order(_createdAt desc)[0]
}
```

**Rewrite** using chained projections — fetch the data once, reuse it:

```groq
// GOOD — single fetch, no duplicates
*[_type == "author"]{
  name,
  "comments": *[_type == "comment" && author._ref == ^._id]
    | order(_createdAt desc)
}
{
  name,
  "commentCount": count(comments),
  "recentComment": comments[0]
}
```

**Test:**

```ts
const { characteristics } = await explain(client, authorWithCommentsQuery);
expect(characteristics).toMatchSnapshot();
expect(characteristics).toHaveNoDuplicateFetches();
```

When some duplication is acceptable (e.g., two different filters that happen to look similar after normalization), use a threshold instead:

```ts
expect(characteristics.duplicateFetches.length).toBeLessThan(2);
```

---

## Reference resolution budget

**Symptom:** `resolveRefCount` is higher than expected — each `ResolveRefStep` is a batched network call for `->` dereferences. See "Avoid repeated resolving of references" in [High performance GROQ](https://www.sanity.io/docs/developer-guides/high-performance-groq).

```groq
// BAD — resolves author twice
*[_type == "post"]{
  title,
  "authorName": author->name,
  "authorBio": author->bio
}
```

**Rewrite** — dereference once and project from the result:

```groq
// GOOD — single ResolveRefStep
*[_type == "post"]{
  title,
  "author": author->{ name, bio }
}
```

**Test:**

```ts
const { characteristics } = await explain(client, postsWithAuthorQuery);
expect(characteristics).toMatchSnapshot();
expect(characteristics).toHaveNoDuplicateFetches();
expect(characteristics.resolveRefCount).toBeLessThanOrEqual(1);
```

---

## Correlated subqueries: HashBatchStep

**Symptom:** you see `FilterStep` where you expected `HashBatchStep` — the engine is running N separate subqueries instead of batching them.

```groq
// Usually OK — engine batches with HashBatchStep
*[_type == "post"][0..50]{
  "comments": *[_type == "comment" && post._ref == ^._id]
}
```

If the plan shows `FilterStep` instead of `HashBatchStep`, the engine couldn't batch the correlation. Restructure using set membership:

```groq
// Fallback — pre-compute the set
*[_type == "post"][0..50]{
  _id,
  "commentPostIds": *[_type == "comment"].post._ref
}
{
  "comments": *[_type == "comment" && post._ref == ^._id && ^._id in ^.commentPostIds]
}
```

**Test:**

```ts
const { characteristics } = await explain(client, postsWithCommentsQuery);
expect(characteristics).toMatchSnapshot();
expect(characteristics).toHaveNoDuplicateFetches();
expect(characteristics.steps).toContain("HashBatchStep");
expect(characteristics.steps).not.toContain("FilterStep");
```

---

## Choosing the right assertions

| Scenario                      | Assertions to add                                    |
| ----------------------------- | ---------------------------------------------------- |
| Every explain test            | `toMatchSnapshot()` + `toHaveNoDuplicateFetches()`   |
| All filters are indexable     | + `toHaveNoFilterStep()`                             |
| Sort pushed to index          | + `toHaveSortInFetch()`                              |
| Limit pushed to index         | + `toHaveLimitInFetch()`                             |
| No in-memory sort anywhere    | + `expect(c.steps).not.toContain('SortStep')`        |
| Fetch budget                  | + `expect(c.fetchCount).toBeLessThanOrEqual(n)`      |
| Reference budget              | + `expect(c.resolveRefCount).toBeLessThanOrEqual(n)` |
| Correlated subqueries batched | + `expect(c.steps).toContain('HashBatchStep')`       |

Add optimization guards as a query achieves each optimization — they lock in the improvement across future refactors.
