import type { Any, ClientReturn } from "@sanity/client";
import type { EvaluateOptions, ParseOptions } from "groq-js";
import { evaluate, parse } from "groq-js";

/**
 * Options forwarded to groq-js. Includes everything from `EvaluateOptions`
 * (except `dataset`, which is the first argument) plus `mode` from the parser.
 *
 * Common options: `params`, `timestamp`, `identity`, `before`/`after` (delta queries),
 * `sanity` (namespace functions like `sanity::dataset()`).
 *
 * @public
 */
export type GroqOptions = Omit<EvaluateOptions, "dataset"> & Pick<ParseOptions, "mode">;

/**
 * Run a GROQ query against an in-memory dataset.
 *
 * @example
 * ```ts
 * const result = await groq(dataset, `*[_type == "post"]{ title }`);
 * const result = await groq(dataset, query, { params: { id: "doc.1" } });
 * ```
 *
 * @public
 */
export function groq<R = Any, const G extends string = string>(
  dataset: unknown[],
  query: G,
  options?: GroqOptions,
): Promise<ClientReturn<G, R>>;

/**
 * Bind a dataset (and optional defaults) to create a reusable query function.
 *
 * @example
 * ```ts
 * const run = groq(dataset, { timestamp: new Date("2025-03-17") });
 * const result = await run(myQuery);
 * const result = await run(otherQuery, { params: { limit: 5 } });
 * ```
 *
 * @public
 */
export function groq(
  dataset: unknown[],
  defaults?: GroqOptions,
): <R = Any, const G extends string = string>(
  query: G,
  options?: GroqOptions,
) => Promise<ClientReturn<G, R>>;

export function groq(
  dataset: unknown[],
  queryOrDefaults?: string | GroqOptions,
  options?: GroqOptions,
) {
  if (typeof queryOrDefaults === "string") {
    return exec(queryOrDefaults, dataset, options);
  }
  const defaults = queryOrDefaults;
  return <R = Any, const G extends string = string>(
    query: G,
    opts?: GroqOptions,
  ): Promise<ClientReturn<G, R>> => exec(query, dataset, { ...defaults, ...opts });
}

async function exec(query: string, dataset: unknown[], options?: GroqOptions) {
  const { mode, ...evaluateOptions } = options ?? {};
  // groq-js folds params into the tree at parse time; slice bounds must be constant by then.
  const tree = parse(query, { mode, params: evaluateOptions.params });
  const value = await evaluate(tree, { dataset, ...evaluateOptions });
  return value.get();
}
