import { createReadStream } from "node:fs";
import { basename, extname, resolve } from "node:path";
import readline from "node:readline";
import { Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip, createInflate } from "node:zlib";
import { extract as tarExtract } from "tar-stream";

// Minimum bytes needed for tar magic detection ("ustar" at offset 257).
const TAR_MAGIC_OFFSET = 262;

const isGzip = (buf: Buffer) =>
  buf.length >= 3 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08;

const isDeflate = (buf: Buffer) =>
  buf.length >= 2 && buf[0] === 0x78 && (buf[1] === 1 || buf[1] === 0x9c || buf[1] === 0xda);

// https://en.wikipedia.org/wiki/Tar_(computing)#UStar_format — "ustar" at offset 257
const isTar = (buf: Buffer) =>
  buf.length >= 262 &&
  buf[257] === 0x75 &&
  buf[258] === 0x73 &&
  buf[259] === 0x74 &&
  buf[260] === 0x61 &&
  buf[261] === 0x72;

/**
 * Load an NDJSON file or Sanity export tarball as a dataset for use with `groq()`.
 *
 * Format is detected by magic bytes (matching `sanity documents validate` behavior):
 *
 * - **Plain NDJSON** — one JSON object per line, blank lines skipped
 * - **Gzipped NDJSON / tarball** — auto-decompressed via `node:zlib`
 * - **Tar archive** — first `.ndjson` entry is extracted
 *
 * @param path - Absolute or relative file path (resolved from `cwd()`),
 *               or a `URL` (typically `new URL("./fixtures/data.ndjson", import.meta.url)`).
 *
 * @example
 * ```ts
 * import { loadDataset } from "vitest-groq/dataset";
 * import { groq } from "vitest-groq/groq";
 *
 * const posts = await loadDataset(new URL("./fixtures/posts.ndjson", import.meta.url));
 * const result = await groq(posts, `*[_type == "post"]{ title }`);
 * ```
 *
 * @public
 */
export async function loadDataset(path: string | URL): Promise<unknown[]> {
  const filePath = path instanceof URL ? fileURLToPath(path) : resolve(path);
  const stream = createReadStream(filePath);

  const documents: unknown[] = [];
  let lineNumber = 0;

  const lines = readline.createInterface({
    input: Readable.from(maybeExtract(stream, filePath)),
  });

  for await (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      documents.push(JSON.parse(trimmed));
    } catch {
      lines.close();
      throw new Error(
        `loadDataset: malformed JSON at ${filePath}:${lineNumber}\n` +
          `  ${trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed}`,
      );
    }
  }

  return documents;
}

async function* extract<T>(
  stream: AsyncIterable<Buffer>,
  extractor: AsyncIterable<T> & Writable,
): AsyncIterable<T> {
  const drained = new Promise<void>((resolve, reject) => {
    setTimeout(async () => {
      try {
        for await (const chunk of stream) extractor.write(chunk);
        extractor.end();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });

  yield* extractor;
  await drained;
  extractor.destroy();
}

async function* maybeExtract(
  stream: AsyncIterable<Buffer>,
  filePath: string,
): AsyncIterable<Buffer> {
  let buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);

    // Gzip/deflate only need a few bytes — check immediately.
    if (buffer.length < 3) continue;

    const rest = async function* () {
      yield buffer;
      yield* stream;
    };

    if (isGzip(buffer)) {
      yield* maybeExtract(extract(rest(), createGunzip()), filePath);
      return;
    }

    if (isDeflate(buffer)) {
      yield* maybeExtract(extract(rest(), createInflate()), filePath);
      return;
    }

    // Tar needs 262 bytes for the "ustar" magic — keep accumulating.
    if (buffer.length < TAR_MAGIC_OFFSET) continue;

    if (isTar(buffer)) {
      yield* extractNdjsonFromTar(rest(), filePath);
      return;
    }

    // Plain NDJSON — pass through
    yield* rest();
    return;
  }

  // Stream exhausted before reaching TAR_MAGIC_OFFSET and wasn't
  // compressed — treat remaining bytes as plain NDJSON.
  if (buffer.length > 0) {
    yield buffer;
  }
}

async function* extractNdjsonFromTar(
  stream: AsyncIterable<Buffer>,
  filePath: string,
): AsyncIterable<Buffer> {
  const extractor = tarExtract();

  for await (const entry of extract(stream, extractor)) {
    const name = basename(entry.header.name);
    const ext = extname(name).toLowerCase();
    if (ext !== ".ndjson" || name.startsWith(".")) continue;

    for await (const chunk of entry) yield chunk;
    return;
  }

  throw new Error(`loadDataset: ${filePath} is a tarball but contains no .ndjson file`);
}
