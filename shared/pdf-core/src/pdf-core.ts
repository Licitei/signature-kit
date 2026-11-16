import { Context, Effect, Layer, Match, Schema } from "effect";
import type { Scope } from "effect";

import {
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreExportsSchema,
  PdfCoreInspectionSchema,
  PdfCoreInspectOptionsSchema,
  PdfCoreOperationValue,
  PdfCoreSchemaNameValue,
} from "./config.js";
import type { PdfCoreInspection, PdfCoreInspectOptions } from "./config.js";

export type PdfCoreService = {
  readonly inspect: (
    pdf: Uint8Array,
    options: PdfCoreInspectOptions,
  ) => Effect.Effect<PdfCoreInspection, PdfCoreError>;
};

export class PdfCore extends Context.Service<PdfCore, PdfCoreService>()(
  "@signature-kit/pdf-core/PdfCore",
) {}

const FLAG_TEXT = 1;
const FLAG_LINKS = 2;
const FLAG_PAGE_INDEXES = 4;
const STATUS_OK = 0;
const MAGIC = 0x4346_4450;
const VERSION = 1;
const RESULT_HEADER_BYTES = 8;
const PAGE_RECORD_BYTES = 72;
const LINK_RECORD_BYTES = 48;
const TEXT_PAGE_HEADER_BYTES = 16;
const TEXT_ITEM_FLOATS = 5;
const MAX_UINT32 = 0xffff_ffff;

const utf8 = new TextDecoder();

const align8 = (value: number): number => (value + 7) & ~7;

type Allocation = { readonly pointer: number; readonly length: number };

export const makePdfCore = (
  module: WebAssembly.Module,
): Effect.Effect<PdfCoreService, PdfCoreError> =>
  Effect.gen(function* () {
    const instance = yield* Effect.tryPromise({
      try: () => WebAssembly.instantiate(module, {}),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          reason: "The PDF core WebAssembly module failed to instantiate.",
        }),
    });
    const core = yield* Schema.decodeUnknownEffect(PdfCoreExportsSchema)(instance.exports).pipe(
      Effect.mapError(
        (issue) =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.load,
            schemaName: PdfCoreSchemaNameValue.exports,
            reason: "The PDF core WebAssembly module does not expose the expected exports.",
            issueMessage: String(issue),
          }),
      ),
    );

    const allocate = (length: number): Effect.Effect<Allocation, PdfCoreError, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const pointer = length > MAX_UINT32 ? 0 : core.pdf_core_alloc(length) >>> 0;
          return pointer === 0
            ? Effect.fail(
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.limitExceeded,
                  operation: PdfCoreOperationValue.inspect,
                  reason: "The PDF core could not allocate memory for the document.",
                }),
              )
            : Effect.succeed({ pointer, length });
        }),
        (allocation) =>
          Effect.sync(() => core.pdf_core_free(allocation.pointer, allocation.length)),
      );

    const readBlock = (
      pdf: Uint8Array,
      flags: number,
      pageIndexes: ReadonlyArray<number>,
    ): Effect.Effect<ArrayBuffer, PdfCoreError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* allocate(pdf.byteLength);
          const pages = yield* allocate(pageIndexes.length * Uint32Array.BYTES_PER_ELEMENT);
          new Uint8Array(core.memory.buffer, input.pointer, pdf.byteLength).set(pdf);
          new Uint32Array(core.memory.buffer, pages.pointer, pageIndexes.length).set(pageIndexes);
          const result = yield* Effect.acquireRelease(
            Effect.suspend(() => {
              const pointer =
                core.pdf_core_inspect(
                  input.pointer,
                  pdf.byteLength,
                  flags,
                  pages.pointer,
                  pageIndexes.length,
                ) >>> 0;
              if (pointer === 0) {
                return Effect.fail(
                  new PdfCoreError({
                    code: PdfCoreErrorCodeValue.limitExceeded,
                    operation: PdfCoreOperationValue.inspect,
                    reason: "The PDF core could not allocate memory for the result.",
                  }),
                );
              }
              const memory = core.memory.buffer;
              const length = new DataView(memory).getUint32(pointer, true);
              return length < RESULT_HEADER_BYTES || pointer + length > memory.byteLength
                ? Effect.fail(
                    new PdfCoreError({
                      code: PdfCoreErrorCodeValue.wasmLoadFailed,
                      operation: PdfCoreOperationValue.inspect,
                      reason: "The PDF core returned a malformed result block.",
                    }),
                  )
                : Effect.succeed({ pointer, length });
            }),
            (block) => Effect.sync(() => core.pdf_core_free(block.pointer, block.length)),
          );
          return core.memory.buffer.slice(result.pointer, result.pointer + result.length);
        }),
      );

    const decodeBlock = (block: ArrayBuffer): Effect.Effect<PdfCoreInspection, PdfCoreError> =>
      Effect.gen(function* () {
        const view = new DataView(block);
        const status = view.getUint32(4, true);
        if (status !== STATUS_OK) {
          const reason = utf8.decode(new Uint8Array(block, RESULT_HEADER_BYTES));
          return yield* Match.value(status).pipe(
            Match.when(
              1,
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.invalidPdf,
                  operation: PdfCoreOperationValue.inspect,
                  status,
                  reason,
                }),
            ),
            Match.when(
              2,
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.encryptedPdf,
                  operation: PdfCoreOperationValue.inspect,
                  status,
                  reason,
                }),
            ),
            Match.when(
              3,
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.limitExceeded,
                  operation: PdfCoreOperationValue.inspect,
                  status,
                  reason,
                }),
            ),
            Match.when(
              4,
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.unsupportedFeature,
                  operation: PdfCoreOperationValue.inspect,
                  status,
                  reason,
                }),
            ),
            Match.orElse(
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.wasmLoadFailed,
                  operation: PdfCoreOperationValue.inspect,
                  status,
                  reason: "The PDF core returned an unknown status.",
                }),
            ),
          );
        }
        const base = RESULT_HEADER_BYTES;
        if (view.getUint32(base, true) !== MAGIC || view.getUint32(base + 4, true) !== VERSION) {
          return yield* new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.inspect,
            reason: "The PDF core result format is not supported by this package version.",
          });
        }
        const pageCount = view.getUint32(base + 8, true);
        const linkCount = view.getUint32(base + 12, true);
        const textCount = view.getUint32(base + 16, true);
        const pagesStart = base + view.getUint32(base + 20, true);
        const linksStart = base + view.getUint32(base + 24, true);
        const textStart = base + view.getUint32(base + 28, true);

        const box = (at: number): [number, number, number, number] => [
          view.getFloat64(at, true),
          view.getFloat64(at + 8, true),
          view.getFloat64(at + 16, true),
          view.getFloat64(at + 24, true),
        ];

        const pages = Array.from({ length: pageCount }, (_, index) => {
          const at = pagesStart + index * PAGE_RECORD_BYTES;
          return {
            mediaBox: box(at),
            cropBox: box(at + 32),
            rotate: view.getInt32(at + 64, true),
          };
        });

        const uriStart = linksStart + linkCount * LINK_RECORD_BYTES;
        const links = Array.from({ length: linkCount }, (_, index) => {
          const at = linksStart + index * LINK_RECORD_BYTES;
          return {
            rect: box(at),
            pageIndex: view.getUint32(at + 32, true),
            uri: utf8.decode(
              new Uint8Array(
                block,
                uriStart + view.getUint32(at + 36, true),
                view.getUint32(at + 40, true),
              ),
            ),
          };
        });

        const text = [];
        let cursor = textStart;
        for (let index = 0; index < textCount; index += 1) {
          const itemCount = view.getUint32(cursor + 4, true);
          const textLength = view.getUint32(cursor + 8, true);
          const rectsAt = cursor + TEXT_PAGE_HEADER_BYTES;
          const offsetsAt = rectsAt + itemCount * TEXT_ITEM_FLOATS * Float64Array.BYTES_PER_ELEMENT;
          const blobAt = align8(offsetsAt + (itemCount + 1) * Uint32Array.BYTES_PER_ELEMENT);
          text.push({
            pageIndex: view.getUint32(cursor, true),
            rects: new Float64Array(block, rectsAt, itemCount * TEXT_ITEM_FLOATS),
            offsets: new Uint32Array(block, offsetsAt, itemCount + 1),
            text: utf8.decode(new Uint8Array(block, blobAt, textLength)),
          });
          cursor = align8(blobAt + textLength);
        }

        return yield* Schema.decodeUnknownEffect(PdfCoreInspectionSchema)({
          pages,
          links,
          text,
        }).pipe(
          Effect.mapError(
            (issue) =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.wasmLoadFailed,
                operation: PdfCoreOperationValue.inspect,
                schemaName: PdfCoreSchemaNameValue.inspection,
                reason: "The PDF core returned an invalid inspection result.",
                issueMessage: String(issue),
              }),
          ),
        );
      });

    const inspect = Effect.fn(function* (pdf: Uint8Array, rawOptions: PdfCoreInspectOptions) {
      const options = yield* Schema.decodeUnknownEffect(PdfCoreInspectOptionsSchema)(
        rawOptions,
      ).pipe(
        Effect.mapError(
          (issue) =>
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.invalidOptions,
              operation: PdfCoreOperationValue.inspect,
              schemaName: PdfCoreSchemaNameValue.inspectOptions,
              issueMessage: String(issue),
            }),
        ),
      );
      const pageIndexes = options.pageIndexes ?? [];
      const flags =
        (options.text ? FLAG_TEXT : 0) |
        (options.links ? FLAG_LINKS : 0) |
        (options.pageIndexes === undefined ? 0 : FLAG_PAGE_INDEXES);
      const block = yield* readBlock(pdf, flags, pageIndexes);
      return yield* decodeBlock(block);
    });

    return { inspect };
  });

export const pdfCoreLayer = (module: WebAssembly.Module): Layer.Layer<PdfCore, PdfCoreError> =>
  Layer.effect(PdfCore, makePdfCore(module));
