import type { Any, ClientReturn } from "@sanity/client";
import type { EvaluateOptions, ParseOptions } from "groq-js";
import { evaluate, parse } from "groq-js";

export type GroqOptions = Omit<EvaluateOptions, "dataset"> & Pick<ParseOptions, "mode">;

// Overload 1: direct call — query first
export function groq<R = Any, const G extends string = string>(
  query: G,
  dataset: unknown[],
  options?: GroqOptions,
): Promise<ClientReturn<G, R>>;

// Overload 2: partial application — dataset first, returns query function
export function groq(
  dataset: unknown[],
  defaults?: GroqOptions,
): <R = Any, const G extends string = string>(
  query: G,
  options?: GroqOptions,
) => Promise<ClientReturn<G, R>>;

// Implementation
export function groq(
  queryOrDataset: string | unknown[],
  datasetOrDefaults?: unknown[] | GroqOptions,
  options?: GroqOptions,
) {
  if (typeof queryOrDataset === "string") {
    return exec(queryOrDataset, datasetOrDefaults as unknown[], options);
  }
  const dataset = queryOrDataset;
  const defaults = datasetOrDefaults as GroqOptions | undefined;
  return <R = Any, const G extends string = string>(
    query: G,
    opts?: GroqOptions,
  ): Promise<ClientReturn<G, R>> =>
    exec(query, dataset, { ...defaults, ...opts }) as Promise<ClientReturn<G, R>>;
}

async function exec(query: string, dataset: unknown[], options?: GroqOptions) {
  const { mode, ...evaluateOptions } = options ?? {};
  const tree = parse(query, mode ? { mode } : undefined);
  const value = await evaluate(tree, { dataset, ...evaluateOptions });
  return value.get();
}
