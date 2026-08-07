import { expectTypeOf } from "vitest";

import { groq } from "../src/groq";

// Mirrors what `sanity typegen generate` emits: an augmentation of the
// `SanityQueries` registry keyed by the exact query string.
//
// Module augmentation applies to the whole TypeScript program, not just this
// file, so the key is a sentinel that no real query will use. Keying it on a
// realistic query would silently retype identical query strings in the runtime
// tests.
declare module "@sanity/client" {
  interface SanityQueries {
    '*[_type == "__typegenProbe"]{ __typegenField }': Array<{ __typegenField: string | null }>;
  }
}

const PROBE = '*[_type == "__typegenProbe"]{ __typegenField }';
const UNREGISTERED = "*[_type == $notInTheRegistry]";

type ProbeResult = Array<{ __typegenField: string | null }>;

const dataset: unknown[] = [];

// Direct form resolves the generated type from the query string literal.
expectTypeOf(await groq(dataset, PROBE)).toEqualTypeOf<ProbeResult>();

// Curried form resolves it identically.
const run = groq(dataset);
expectTypeOf(await run(PROBE)).toEqualTypeOf<ProbeResult>();

// Curried form with bound defaults still resolves the generated type.
const runWithDefaults = groq(dataset, { params: { limit: 5 } });
expectTypeOf(await runWithDefaults(PROBE)).toEqualTypeOf<ProbeResult>();

// A query absent from the registry falls back to `Any`.
expectTypeOf(await groq(dataset, UNREGISTERED)).toBeAny();
expectTypeOf(await run(UNREGISTERED)).toBeAny();

// An explicit type parameter overrides the fallback.
expectTypeOf(await groq<ProbeResult>(dataset, UNREGISTERED)).toEqualTypeOf<ProbeResult>();
expectTypeOf(await run<ProbeResult>(UNREGISTERED)).toEqualTypeOf<ProbeResult>();

// A widened `string` cannot resolve the registry and falls back to `Any`.
const widened: string = PROBE;
expectTypeOf(await groq(dataset, widened)).toBeAny();
