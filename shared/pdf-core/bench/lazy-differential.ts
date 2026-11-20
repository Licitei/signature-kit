import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";

import { PdfCoreError } from "../dist/config.js";
import type { PdfCoreLazyStats, PdfCoreTextOptions } from "../dist/config.js";
import { makePdfCore, pdfCoreBlobSource, pdfCoreBytesSource } from "../dist/pdf-core.js";
import type { PdfCoreLazyDocument, PdfCoreRangeSource } from "../dist/pdf-core.js";
import { createPdfCoreClient } from "../dist/promise.js";
import type { PdfCorePromiseDocument } from "../dist/promise.js";

type Reader = Pick<
  PdfCorePromiseDocument,
  "text" | "tables" | "textPages" | "pageDiagnostics" | "pageImages" | "renderPages"
>;

const selections = (count: number, seed: number) => {
  const last = count - 1;
  const singles = [...new Set([0, Math.floor(last / 2), last])].filter((index) => index >= 0);
  const multiple = Array.from({ length: Math.min(count, 5) }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % count;
  });
  return [
    ...singles.map((index) => ({ name: `page-${index}`, pageIndexes: [index] })),
    { name: "sample", pageIndexes: multiple },
    { name: "all", pageIndexes: undefined },
  ];
};

const calls = ({ name, pageIndexes }: ReturnType<typeof selections>[number]) => {
  const page = pageIndexes === undefined ? {} : { pageIndexes };
  const textOptions = (["text", "markdown"] satisfies Array<PdfCoreTextOptions["format"]>).flatMap(
    (format) =>
      [false, true].map((dropRunningHeaders) => ({ ...page, format, dropRunningHeaders })),
  );
  return [
    ...textOptions.flatMap((options) => [
      {
        name: `text/${options.format}/${options.dropRunningHeaders}`,
        run: (reader: Reader) => reader.text(options),
      },
      {
        name: `textPages/${options.format}/${options.dropRunningHeaders}`,
        run: (reader: Reader) => reader.textPages(options),
      },
    ]),
    { name: "tables", run: (reader: Reader) => reader.tables(page) },
    { name: "pageDiagnostics", run: (reader: Reader) => reader.pageDiagnostics(page) },
    { name: "pageImages", run: (reader: Reader) => reader.pageImages(page) },
    {
      name: "pageImages/gray",
      run: (reader: Reader) => reader.pageImages({ ...page, format: "gray" }),
    },
    { name: "renderPages", run: (reader: Reader) => reader.renderPages(page) },
  ].map((call) => ({ ...call, name: `${name}/${call.name}` }));
};

const isPdfCoreError = Schema.is(PdfCoreError);
const digest = (value: unknown) =>
  Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify(value, (_, field: unknown) =>
      ArrayBuffer.isView(field)
        ? { bytes: Bun.CryptoHasher.hash("sha256", field, "hex"), length: field.byteLength }
        : field,
    ),
    "hex",
  );

const outcome = (read: () => Promise<unknown>) =>
  read().then(
    (value) => ({ status: "ok", digest: digest(value) }),
    (error: unknown) =>
      isPdfCoreError(error)
        ? { status: "error", code: error.code, operation: error.operation }
        : { status: "defect", reason: String(error) },
  );

const effectReader = (
  document: PdfCoreLazyDocument,
  run: <A>(effect: Effect.Effect<A, PdfCoreError>) => Promise<A>,
): Reader => ({
  text: (options) => run(document.text(options)),
  tables: (options) => run(document.tables(options)),
  textPages: (options) => run(document.textPages(options)),
  pageDiagnostics: (options) => run(document.pageDiagnostics(options)),
  pageImages: (options) => run(document.pageImages(options)),
  renderPages: (options) => run(document.renderPages(options)),
});

const { values } = parseArgs({
  options: {
    start: { type: "string", default: "0" },
    stride: { type: "string", default: "1" },
    limit: { type: "string" },
  },
});
const corpus = process.env.PDF_CORPUS ?? "/home/yorizel/Documents/bench-parsers";
const entries = await readdir(corpus, { withFileTypes: true, recursive: true });
const paths = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
const start = Number(values.start);
const stride = Number(values.stride);
const limit = values.limit === undefined ? paths.length : Number(values.limit);
if (![start, stride, limit].every(Number.isSafeInteger) || start < 0 || stride < 1 || limit < 1) {
  throw new Error("Expected nonnegative --start and positive --stride and --limit integers.");
}
const files = paths
  .filter((_, index) => index >= start && (index - start) % stride === 0)
  .slice(0, limit);
const module = await WebAssembly.compile(
  await readFile(new URL("../dist/pdf-core.wasm", import.meta.url)),
);
let compared = 0;
let mismatches = 0;
let flaggedReads = 0;
let failures = 0;

for (const [index, file] of files.entries()) {
  const corpusIndex = start + index * stride;
  const path = relative(corpus, file);
  const result = await Promise.resolve()
    .then(async () => {
      const pdf = await readFile(file);
      const blob = new Blob([pdf]);
      const core = await createPdfCoreClient(module);
      const coreEffect = await Effect.runPromise(makePdfCore(module));
      const full: Reader = {
        text: (options) => core.text(pdf, options),
        tables: (options) => core.tables(pdf, options),
        textPages: (options) => core.textPages(pdf, options),
        pageDiagnostics: (options) => core.pageDiagnostics(pdf, options),
        pageImages: (options) => core.pageImages(pdf, options),
        renderPages: (options) => core.renderPages(pdf, options),
      };
      const pageCount = await core.inspect(pdf, { text: false, links: false }).then(
        ({ pages }) => pages.length,
        (error: unknown) => {
          if (!isPdfCoreError(error)) throw error;
          return 0;
        },
      );
      const matrix = selections(pageCount, corpusIndex).map(calls);
      const expected = new Map<string, Awaited<ReturnType<typeof outcome>>>();
      for (const group of matrix) {
        for (const call of group) expected.set(call.name, await outcome(() => call.run(full)));
      }

      const compare = async (reader: Reader, stats: () => Promise<PdfCoreLazyStats>) => {
        const rows = [];
        const run = async (group: (typeof matrix)[number], pass: string, concurrent: boolean) => {
          const before = await stats();
          const results = [];
          const execute = async (call: (typeof group)[number]) => {
            const actual = await outcome(() => call.run(reader));
            const full = expected.get(call.name);
            compared += 1;
            if (actual.status === "defect" || JSON.stringify(actual) !== JSON.stringify(full)) {
              mismatches += 1;
              return { call: call.name, actual, full };
            }
            return undefined;
          };
          if (concurrent) {
            results.push(...(await Promise.all(group.map(execute))));
          } else {
            for (const call of group) {
              const result = await execute(call);
              const after = await stats();
              rows.push({ pass, call: call.name, ...delta(before, after), ...result });
              Object.assign(before, after);
              if (
                call.name.startsWith("page-") &&
                pass === "forward" &&
                pdf.length > 2 * 1024 * 1024 &&
                pageCount > 3 &&
                (rows.at(-1)?.bytesRead ?? 0) > pdf.length * 0.75
              ) {
                flaggedReads += 1;
                Object.assign(rows.at(-1) ?? {}, { highRead: true });
              }
            }
            return;
          }
          rows.push({
            pass,
            calls: group.map(({ name }) => name),
            ...delta(before, await stats()),
            mismatches: results.filter((entry) => entry !== undefined),
          });
        };
        for (const group of matrix) await run(group, "forward", false);
        for (const group of matrix.slice(0, -1).toReversed()) {
          await run(group.toReversed(), "reverse", false);
        }
        const single = pageCount > 0 ? matrix[0] : undefined;
        if (single !== undefined) await run(single, "concurrent", true);
        return rows;
      };

      const compareEffect = (source: PdfCoreRangeSource) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const document = yield* coreEffect.openLazy(source);
              const run = Effect.runPromiseWith(yield* Effect.context());
              return yield* Effect.promise(() =>
                compare(effectReader(document, run), () => run(document.stats)),
              );
            }),
          ),
        );
      const effectBytes = await compareEffect(pdfCoreBytesSource(pdf));
      const effectBlob = await compareEffect(pdfCoreBlobSource(blob));
      await using promiseBytes = await core.openLazy({
        size: pdf.length,
        read: (offset, length) => pdf.subarray(offset, offset + length),
      });
      await using promiseBlob = await core.openLazy({
        size: blob.size,
        read: async (offset, length) =>
          new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
      });
      return {
        pageCount,
        size: pdf.length,
        effectBytes,
        effectBlob,
        promiseBytes: await compare(promiseBytes, promiseBytes.stats),
        promiseBlob: await compare(promiseBlob, promiseBlob.stats),
      };
    })
    .then(
      (report) => report,
      (error: unknown) => {
        failures += 1;
        return { failure: String(error) };
      },
    );
  console.log(JSON.stringify({ index: corpusIndex, path, ...result }));
  Bun.gc(true);
}

console.log(
  JSON.stringify({
    discovered: paths.length,
    tested: files.length,
    compared,
    mismatches,
    flaggedReads,
    failures,
  }),
);
process.exitCode = mismatches + failures === 0 ? 0 : 1;

function delta(before: PdfCoreLazyStats, after: PdfCoreLazyStats) {
  return {
    bytesRead: after.bytesRead - before.bytesRead,
    rounds: after.rounds - before.rounds,
    strategy: after.strategy,
  };
}
