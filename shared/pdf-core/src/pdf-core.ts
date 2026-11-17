import { Context, Effect, Layer, Match, Schema } from "effect";
import type { Scope } from "effect";

import {
  PdfCoreCreateOptionsSchema,
  PdfCoreDocumentOptionsSchema,
  PdfCoreDocumentSchema,
  PdfCoreEditOperationsSchema,
  PdfCoreEditOptionsSchema,
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreExportsSchema,
  PdfCoreFieldNameFailureSchema,
  PdfCoreInspectionSchema,
  PdfCoreInspectOptionsSchema,
  PdfCoreMergeOptionsSchema,
  PdfCoreMergeSourcesSchema,
  PdfCoreOperationValue,
  PdfCoreSchemaNameValue,
  PdfCoreSignatureAnalysisSchema,
  PdfCoreSignatureFailureSchema,
  PdfCoreSignatureReportSchema,
  PdfCoreSignatureSlotFailureSchema,
  PdfCoreTablesOptionsSchema,
  PdfCoreTablesSchema,
  PdfCoreTextOptionsSchema,
  PdfCoreTextSchema,
  PdfCoreWinAnsiFontSchema,
} from "./config.js";
import type {
  PdfCoreCreateOptions,
  PdfCoreDocument,
  PdfCoreDocumentOptions,
  PdfCoreEditOperation,
  PdfCoreEditOperations,
  PdfCoreEditOptions,
  PdfCoreEditTarget,
  PdfCoreFontMetrics,
  PdfCoreInspection,
  PdfCoreInspectOptions,
  PdfCoreMergeOptions,
  PdfCoreMergeSources,
  PdfCoreObjectRef,
  PdfCoreOperation,
  PdfCoreSchemaName,
  PdfCoreSignatureAnalysis,
  PdfCoreSignatureReport,
  PdfCoreTables,
  PdfCoreTablesOptions,
  PdfCoreText,
  PdfCoreTextOptions,
  PdfCoreWinAnsiFont,
} from "./config.js";

export type PdfCoreService = {
  readonly inspect: (
    pdf: Uint8Array,
    options: PdfCoreInspectOptions,
  ) => Effect.Effect<PdfCoreInspection, PdfCoreError>;
  readonly text: (
    pdf: Uint8Array,
    options?: PdfCoreTextOptions,
  ) => Effect.Effect<PdfCoreText, PdfCoreError>;
  readonly tables: (
    pdf: Uint8Array,
    options?: PdfCoreTablesOptions,
  ) => Effect.Effect<PdfCoreTables, PdfCoreError>;
  readonly signatures: (
    pdf: Uint8Array,
    analysis: PdfCoreSignatureAnalysis,
  ) => Effect.Effect<PdfCoreSignatureReport, PdfCoreError>;
  readonly revisionComplete: (pdf: Uint8Array, end: number) => Effect.Effect<boolean, PdfCoreError>;
  readonly document: (
    pdf: Uint8Array,
    options?: PdfCoreDocumentOptions,
  ) => Effect.Effect<PdfCoreDocument, PdfCoreError>;
  readonly edit: (
    pdf: Uint8Array,
    operations: PdfCoreEditOperations,
    options?: PdfCoreEditOptions,
  ) => Effect.Effect<Uint8Array, PdfCoreError>;
  readonly merge: (
    sources: PdfCoreMergeSources,
    options?: PdfCoreMergeOptions,
  ) => Effect.Effect<Uint8Array, PdfCoreError>;
  readonly deflate: (data: Uint8Array) => Effect.Effect<Uint8Array, PdfCoreError>;
  readonly create: (options: PdfCoreCreateOptions) => Effect.Effect<Uint8Array, PdfCoreError>;
  readonly fontMetrics: (
    baseFont: PdfCoreWinAnsiFont,
  ) => Effect.Effect<PdfCoreFontMetrics, PdfCoreError>;
};

export class PdfCore extends Context.Service<PdfCore, PdfCoreService>()(
  "@signature-kit/pdf-core/PdfCore",
) {}

const FLAG_TEXT = 1;
const FLAG_LINKS = 2;
const FLAG_PAGE_INDEXES = 4;
const FLAG_MARKDOWN = 8;
const FLAG_DROP_RUNNING = 16;
const STATUS_OK = 0;
const MAGIC = 0x4346_4450;
const VERSION = 2;
const TEXT_MAGIC = 0x5854_4450;
const TEXT_VERSION = 1;
const TEXT_HEADER_BYTES = 16;
const TABLES_MAGIC = 0x4254_4450;
const TABLES_VERSION = 1;
const TABLES_HEADER_BYTES = 16;
const TABLE_RECORD_BYTES = 48;
const CELL_RECORD_BYTES = 56;
const RESULT_HEADER_BYTES = 8;
const PAGE_RECORD_BYTES = 72;
const LINK_RECORD_BYTES = 48;
const TEXT_PAGE_HEADER_BYTES = 16;
const TEXT_ITEM_FLOATS = 5;
const MAX_UINT32 = 0xffff_ffff;
const SIGNATURES_MAGIC = 0x4753_4450;
const SIGNATURES_VERSION = 1;
const SIGNATURES_HEADER_BYTES = 24;
const SIGNATURE_RECORD_BYTES = 72;
const DOCUMENT_MAGIC = 0x4944_4450;
const DOCUMENT_VERSION = 2;
const DOCUMENT_HEADER_BYTES = 32;
const DOCUMENT_PAGE_RECORD_BYTES = 80;
const DOCUMENT_ANNOTATION_RECORD_BYTES = 72;
const EDIT_MAGIC = 0x4445_4450;
const EDIT_VERSION = 1;
const EDIT_INCREMENTAL = 1;
const EDIT_REWRITE = 2;
const EDIT_OBJECT_STREAMS = 4;
const METRICS_MAGIC = 0x4d46_4450;
const METRICS_VERSION = 1;
const METRICS_PAYLOAD_BYTES = 8 + 256 * 4;
const MERGE_DROP_WIDGETS = 1;
const MERGE_OBJECT_STREAMS = 2;
const ALL_PAGES = MAX_UINT32;
const SIGNATURE_MODES = { scan: 0, dictionaries: 1, verification: 2 } satisfies Record<
  PdfCoreSignatureAnalysis,
  number
>;
const EDIT_OPCODES = {
  setObject: 1,
  setStream: 2,
  set: 3,
  remove: 4,
  append: 5,
  removeItem: 6,
  setFlags: 7,
  appendContent: 8,
  addResource: 9,
  image: 10,
  standardFont: 11,
  signature: 12,
  repairCatalog: 13,
  png: 14,
} satisfies Record<PdfCoreEditOperation["op"], number>;

const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

type PayloadWriter = {
  readonly u32: (value: number) => void;
  readonly bytes: (value: Uint8Array) => void;
  readonly text: (value: string) => void;
  readonly finish: () => Uint8Array;
};

const payloadWriter = (): PayloadWriter => {
  const parts: Array<Uint8Array> = [];
  let length = 0;
  const push = (part: Uint8Array): void => {
    parts.push(part);
    length += part.byteLength;
  };
  const u32 = (value: number): void => {
    const word = new Uint8Array(4);
    new DataView(word.buffer).setUint32(0, value >>> 0, true);
    push(word);
  };
  return {
    u32,
    bytes: (value) => {
      u32(value.byteLength);
      push(value);
    },
    text: (value) => {
      const encoded = utf8Encoder.encode(value);
      u32(encoded.byteLength);
      push(encoded);
    },
    finish: () => {
      const out = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    },
  };
};

const writeRef = (writer: PayloadWriter, ref: PdfCoreObjectRef | undefined): void => {
  writer.u32(ref?.number ?? 0);
  writer.u32(ref?.generation ?? 0);
};

const writeTarget = (writer: PayloadWriter, target: PdfCoreEditTarget): void => {
  const base = target.base;
  Match.value(base).pipe(
    Match.when({ kind: "catalog" }, () => {
      writer.u32(0);
      writer.u32(0);
      writer.u32(0);
    }),
    Match.when({ kind: "page" }, (page) => {
      writer.u32(1);
      writer.u32(page.pageIndex);
      writer.u32(0);
    }),
    Match.when({ kind: "object" }, (object) => {
      writer.u32(2);
      writer.u32(object.ref.number);
      writer.u32(object.ref.generation);
    }),
    Match.exhaustive,
  );
  const path = target.path ?? [];
  writer.u32(path.length);
  for (const step of path) {
    if (typeof step === "string") {
      writer.u32(0);
      writer.text(step);
    } else {
      writer.u32(1);
      writer.u32(step);
    }
  }
};

const writeOperation = (writer: PayloadWriter, operation: PdfCoreEditOperation): void => {
  writer.u32(EDIT_OPCODES[operation.op]);
  Match.value(operation).pipe(
    Match.when({ op: "setObject" }, (value) => {
      writeRef(writer, value.ref);
      writer.text(value.value);
    }),
    Match.when({ op: "setStream" }, (value) => {
      writeRef(writer, value.ref);
      writer.text(value.dict);
      writer.bytes(value.data);
      writer.u32(value.compress === true ? 1 : 0);
    }),
    Match.when({ op: "set" }, (value) => {
      writeTarget(writer, value.target);
      writer.text(value.key);
      writer.text(value.value);
    }),
    Match.when({ op: "remove" }, (value) => {
      writeTarget(writer, value.target);
      writer.text(value.key);
    }),
    Match.when({ op: "append" }, (value) => {
      writeTarget(writer, value.target);
      writer.text(value.key);
      writer.text(value.value);
    }),
    Match.when({ op: "removeItem" }, (value) => {
      writeTarget(writer, value.target);
      writer.text(value.key);
      writer.text(value.value);
    }),
    Match.when({ op: "setFlags" }, (value) => {
      writeTarget(writer, value.target);
      writer.text(value.key);
      writer.u32(value.flags);
    }),
    Match.when({ op: "appendContent" }, (value) => {
      writer.u32(value.pageIndex);
      writeRef(writer, value.ref);
      writeRef(writer, value.wrapRef);
      writer.bytes(value.data);
      writer.u32(value.compress === true ? 1 : 0);
    }),
    Match.when({ op: "addResource" }, (value) => {
      writer.u32(value.pageIndex);
      writer.text(value.category);
      writer.text(value.name);
      writer.text(value.value);
    }),
    Match.when({ op: "image" }, (value) => {
      writeRef(writer, value.ref);
      writeRef(writer, value.softMaskRef);
      writer.u32(value.width);
      writer.u32(value.height);
      writer.u32(value.colorSpace === "rgb" ? 3 : 1);
      writer.u32(value.alpha ? 1 : 0);
      writer.bytes(value.samples);
    }),
    Match.when({ op: "png" }, (value) => {
      writeRef(writer, value.ref);
      writeRef(writer, value.softMaskRef);
      writer.bytes(value.png);
    }),
    Match.when({ op: "standardFont" }, (value) => {
      writeRef(writer, value.ref);
      writer.text(value.baseFont);
    }),
    Match.when({ op: "signature" }, (value) => {
      writeRef(writer, value.ref);
      writer.u32(value.contentsLength);
      writer.text(value.entries);
    }),
    Match.when({ op: "repairCatalog" }, () => undefined),
    Match.exhaustive,
  );
};

const align8 = (value: number): number => (value + 7) & ~7;

type Allocation = { readonly pointer: number; readonly length: number };
type ResultBlock = {
  readonly memory: ArrayBuffer;
  readonly pointer: number;
  readonly length: number;
};
type Entry = (
  pdfPointer: number,
  pdfLength: number,
  flags: number,
  pagesPointer: number,
  pagesLength: number,
) => number;

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

    const allocate = (
      operation: PdfCoreOperation,
      length: number,
    ): Effect.Effect<Allocation, PdfCoreError, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const pointer = length > MAX_UINT32 ? 0 : core.pdf_core_alloc(length) >>> 0;
          return pointer === 0
            ? Effect.fail(
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.limitExceeded,
                  operation,
                  reason: "The PDF core could not allocate memory for the document.",
                }),
              )
            : Effect.succeed({ pointer, length });
        }),
        (allocation) =>
          Effect.sync(() => core.pdf_core_free(allocation.pointer, allocation.length)),
      );

    const readBlock = <A>(
      operation: PdfCoreOperation,
      entry: Entry,
      pdf: Uint8Array,
      flags: number,
      pageIndexes: ReadonlyArray<number>,
      decode: (block: ResultBlock) => Effect.Effect<A, PdfCoreError>,
    ): Effect.Effect<A, PdfCoreError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* allocate(operation, pdf.byteLength);
          const pages = yield* allocate(
            operation,
            pageIndexes.length * Uint32Array.BYTES_PER_ELEMENT,
          );
          new Uint8Array(core.memory.buffer, input.pointer, pdf.byteLength).set(pdf);
          new Uint32Array(core.memory.buffer, pages.pointer, pageIndexes.length).set(pageIndexes);
          const result = yield* Effect.acquireRelease(
            Effect.suspend(() => {
              const pointer =
                entry(input.pointer, pdf.byteLength, flags, pages.pointer, pageIndexes.length) >>>
                0;
              if (pointer === 0) {
                return Effect.fail(
                  new PdfCoreError({
                    code: PdfCoreErrorCodeValue.limitExceeded,
                    operation,
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
                      operation,
                      reason: "The PDF core returned a malformed result block.",
                    }),
                  )
                : Effect.succeed({ pointer, length });
            }),
            (block) => Effect.sync(() => core.pdf_core_free(block.pointer, block.length)),
          );
          return yield* decode({
            memory: core.memory.buffer,
            pointer: result.pointer,
            length: result.length,
          });
        }),
      );

    const copyIn = (
      operation: PdfCoreOperation,
      bytes: Uint8Array,
    ): Effect.Effect<Allocation, PdfCoreError, Scope.Scope> =>
      allocate(operation, bytes.byteLength).pipe(
        Effect.tap((allocation) =>
          Effect.sync(() =>
            new Uint8Array(core.memory.buffer, allocation.pointer, bytes.byteLength).set(bytes),
          ),
        ),
      );

    const resultBlock = (
      operation: PdfCoreOperation,
      call: () => number,
    ): Effect.Effect<ResultBlock, PdfCoreError, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const pointer = call() >>> 0;
          if (pointer === 0) {
            return Effect.fail(
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.limitExceeded,
                operation,
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
                  operation,
                  reason: "The PDF core returned a malformed result block.",
                }),
              )
            : Effect.succeed({ pointer, length });
        }),
        (block) => Effect.sync(() => core.pdf_core_free(block.pointer, block.length)),
      ).pipe(
        Effect.map((block) => ({
          memory: core.memory.buffer,
          pointer: block.pointer,
          length: block.length,
        })),
      );

    const payloadBytes = (
      operation: PdfCoreOperation,
      block: ResultBlock,
    ): Effect.Effect<Uint8Array, PdfCoreError> =>
      new DataView(block.memory, block.pointer, block.length).getUint32(4, true) === STATUS_OK
        ? Effect.succeed(
            new Uint8Array(
              block.memory,
              block.pointer + RESULT_HEADER_BYTES,
              block.length - RESULT_HEADER_BYTES,
            ).slice(),
          )
        : failStatus(operation, block);

    const failStatus = (
      operation: PdfCoreOperation,
      block: ResultBlock,
    ): Effect.Effect<never, PdfCoreError> => {
      const status = new DataView(block.memory, block.pointer, block.length).getUint32(4, true);
      const reason = utf8.decode(
        new Uint8Array(
          block.memory,
          block.pointer + RESULT_HEADER_BYTES,
          block.length - RESULT_HEADER_BYTES,
        ),
      );
      return Effect.fail(
        Match.value(status).pipe(
          Match.when(
            1,
            () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.invalidPdf,
                operation,
                status,
                reason,
              }),
          ),
          Match.when(
            2,
            () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.encryptedPdf,
                operation,
                status,
                reason,
              }),
          ),
          Match.when(
            3,
            () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.limitExceeded,
                operation,
                status,
                reason,
              }),
          ),
          Match.when(
            4,
            () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.unsupportedFeature,
                operation,
                status,
                reason,
              }),
          ),
          Match.when(
            5,
            () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.invalidOptions,
                operation,
                status,
                reason,
              }),
          ),
          Match.orElse(
            () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.wasmLoadFailed,
                operation,
                status,
                reason: "The PDF core returned an unknown status.",
              }),
          ),
        ),
      );
    };

    const decodeBlock = (block: ResultBlock): Effect.Effect<PdfCoreInspection, PdfCoreError> =>
      Effect.gen(function* () {
        const view = new DataView(block.memory, block.pointer, block.length);
        const bytes = (at: number, length: number): Uint8Array =>
          new Uint8Array(block.memory, block.pointer + at, length);
        const status = view.getUint32(4, true);
        if (status !== STATUS_OK) {
          return yield* failStatus(PdfCoreOperationValue.inspect, block);
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
              bytes(uriStart + view.getUint32(at + 36, true), view.getUint32(at + 40, true)),
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
            rects: new Float64Array(
              block.memory,
              block.pointer + rectsAt,
              itemCount * TEXT_ITEM_FLOATS,
            ).slice(),
            offsets: new Uint32Array(
              block.memory,
              block.pointer + offsetsAt,
              itemCount + 1,
            ).slice(),
            text: utf8.decode(bytes(blobAt, textLength)),
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
      return yield* readBlock(
        PdfCoreOperationValue.inspect,
        core.pdf_core_inspect,
        pdf,
        flags,
        pageIndexes,
        decodeBlock,
      );
    });

    const decodeTextBlock = (block: ResultBlock): Effect.Effect<PdfCoreText, PdfCoreError> =>
      Effect.gen(function* () {
        const view = new DataView(block.memory, block.pointer, block.length);
        if (view.getUint32(4, true) !== STATUS_OK) {
          return yield* failStatus(PdfCoreOperationValue.text, block);
        }
        const base = RESULT_HEADER_BYTES;
        if (
          view.getUint32(base, true) !== TEXT_MAGIC ||
          view.getUint32(base + 4, true) !== TEXT_VERSION
        ) {
          return yield* new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.text,
            reason: "The PDF core text format is not supported by this package version.",
          });
        }
        const pageCount = view.getUint32(base + 8, true);
        const offsetsAt = base + TEXT_HEADER_BYTES;
        const blobAt = align8(offsetsAt + (pageCount + 1) * Uint32Array.BYTES_PER_ELEMENT);
        const pages = Array.from({ length: pageCount }, (_, index) => {
          const start = view.getUint32(offsetsAt + index * 4, true);
          const end = view.getUint32(offsetsAt + (index + 1) * 4, true);
          return utf8.decode(
            new Uint8Array(block.memory, block.pointer + blobAt + start, end - start),
          );
        });
        return yield* Schema.decodeUnknownEffect(PdfCoreTextSchema)(pages).pipe(
          Effect.mapError(
            (issue) =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.wasmLoadFailed,
                operation: PdfCoreOperationValue.text,
                schemaName: PdfCoreSchemaNameValue.text,
                reason: "The PDF core returned an invalid text result.",
                issueMessage: String(issue),
              }),
          ),
        );
      });

    const text = Effect.fn(function* (pdf: Uint8Array, rawOptions: PdfCoreTextOptions = {}) {
      const options = yield* Schema.decodeUnknownEffect(PdfCoreTextOptionsSchema)(rawOptions).pipe(
        Effect.mapError(
          (issue) =>
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.invalidOptions,
              operation: PdfCoreOperationValue.text,
              schemaName: PdfCoreSchemaNameValue.textOptions,
              issueMessage: String(issue),
            }),
        ),
      );
      const pageIndexes = options.pageIndexes ?? [];
      const flags =
        (options.pageIndexes === undefined ? 0 : FLAG_PAGE_INDEXES) |
        (options.format === "markdown" ? FLAG_MARKDOWN : 0) |
        (options.dropRunningHeaders === false ? 0 : FLAG_DROP_RUNNING);
      return yield* readBlock(
        PdfCoreOperationValue.text,
        core.pdf_core_text,
        pdf,
        flags,
        pageIndexes,
        decodeTextBlock,
      );
    });

    const decodeTablesBlock = (block: ResultBlock): Effect.Effect<PdfCoreTables, PdfCoreError> =>
      Effect.gen(function* () {
        const view = new DataView(block.memory, block.pointer, block.length);
        if (view.getUint32(4, true) !== STATUS_OK) {
          return yield* failStatus(PdfCoreOperationValue.tables, block);
        }
        const base = RESULT_HEADER_BYTES;
        if (
          view.getUint32(base, true) !== TABLES_MAGIC ||
          view.getUint32(base + 4, true) !== TABLES_VERSION
        ) {
          return yield* new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.tables,
            reason: "The PDF core tables format is not supported by this package version.",
          });
        }
        const tableCount = view.getUint32(base + 8, true);
        const cellCount = view.getUint32(base + 12, true);
        const blobAt =
          base +
          TABLES_HEADER_BYTES +
          tableCount * TABLE_RECORD_BYTES +
          cellCount * CELL_RECORD_BYTES;
        const box = (at: number): [number, number, number, number] => [
          view.getFloat64(at, true),
          view.getFloat64(at + 8, true),
          view.getFloat64(at + 16, true),
          view.getFloat64(at + 24, true),
        ];
        const tables = [];
        let cursor = base + TABLES_HEADER_BYTES;
        for (let index = 0; index < tableCount; index += 1) {
          const cellsInTable = view.getUint32(cursor + 12, true);
          const cells = [];
          let cellAt = cursor + TABLE_RECORD_BYTES;
          for (let cell = 0; cell < cellsInTable; cell += 1) {
            cells.push({
              row: view.getUint32(cellAt, true),
              col: view.getUint32(cellAt + 4, true),
              rowSpan: view.getUint32(cellAt + 8, true),
              colSpan: view.getUint32(cellAt + 12, true),
              bbox: box(cellAt + 16),
              text: utf8.decode(
                new Uint8Array(
                  block.memory,
                  block.pointer + blobAt + view.getUint32(cellAt + 48, true),
                  view.getUint32(cellAt + 52, true),
                ),
              ),
            });
            cellAt += CELL_RECORD_BYTES;
          }
          tables.push({
            pageIndex: view.getUint32(cursor, true),
            rows: view.getUint32(cursor + 4, true),
            cols: view.getUint32(cursor + 8, true),
            bbox: box(cursor + 16),
            cells,
          });
          cursor = cellAt;
        }
        return yield* Schema.decodeUnknownEffect(PdfCoreTablesSchema)(tables).pipe(
          Effect.mapError(
            (issue) =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.wasmLoadFailed,
                operation: PdfCoreOperationValue.tables,
                schemaName: PdfCoreSchemaNameValue.tables,
                reason: "The PDF core returned an invalid tables result.",
                issueMessage: String(issue),
              }),
          ),
        );
      });

    const tables = Effect.fn(function* (pdf: Uint8Array, rawOptions: PdfCoreTablesOptions = {}) {
      const options = yield* Schema.decodeUnknownEffect(PdfCoreTablesOptionsSchema)(
        rawOptions,
      ).pipe(
        Effect.mapError(
          (issue) =>
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.invalidOptions,
              operation: PdfCoreOperationValue.tables,
              schemaName: PdfCoreSchemaNameValue.tablesOptions,
              issueMessage: String(issue),
            }),
        ),
      );
      const pageIndexes = options.pageIndexes ?? [];
      const flags = options.pageIndexes === undefined ? 0 : FLAG_PAGE_INDEXES;
      return yield* readBlock(
        PdfCoreOperationValue.tables,
        core.pdf_core_tables,
        pdf,
        flags,
        pageIndexes,
        decodeTablesBlock,
      );
    });

    const invalidOptions =
      (operation: PdfCoreOperation, schemaName?: PdfCoreSchemaName) =>
      (issue: unknown): PdfCoreError =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.invalidOptions,
          operation,
          ...(schemaName === undefined ? {} : { schemaName }),
          issueMessage: String(issue),
        });

    const malformedResult =
      (operation: PdfCoreOperation, schemaName: PdfCoreSchemaName, reason: string) =>
      (issue: unknown): PdfCoreError =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation,
          schemaName,
          reason,
          issueMessage: String(issue),
        });

    const unsupportedFormat = (operation: PdfCoreOperation): PdfCoreError =>
      new PdfCoreError({
        code: PdfCoreErrorCodeValue.wasmLoadFailed,
        operation,
        reason: "The PDF core result format is not supported by this package version.",
      });

    const span = (view: DataView, at: number, present: boolean) =>
      present
        ? {
            keyStart: view.getUint32(at, true),
            valueStart: view.getUint32(at + 4, true),
            valueEnd: view.getUint32(at + 8, true),
          }
        : undefined;

    const decodeSignatures = (
      block: ResultBlock,
    ): Effect.Effect<PdfCoreSignatureReport, PdfCoreError> =>
      Effect.gen(function* () {
        const operation = PdfCoreOperationValue.signatures;
        const view = new DataView(block.memory, block.pointer, block.length);
        if (view.getUint32(4, true) !== STATUS_OK) return yield* failStatus(operation, block);
        const base = RESULT_HEADER_BYTES;
        if (
          view.getUint32(base, true) !== SIGNATURES_MAGIC ||
          view.getUint32(base + 4, true) !== SIGNATURES_VERSION
        ) {
          return yield* unsupportedFormat(operation);
        }
        const failureCode = view.getUint32(base + 8, true);
        const flags = view.getUint32(base + 12, true);
        const count = view.getUint32(base + 16, true);
        const dictionaries = Array.from({ length: count }, (_, index) => {
          const at = base + SIGNATURES_HEADER_BYTES + index * SIGNATURE_RECORD_BYTES;
          const recordFlags = view.getUint32(at + 12, true);
          const byteRange = span(view, at + 16, (recordFlags & 2) !== 0);
          const contents = span(view, at + 28, (recordFlags & 4) !== 0);
          return {
            kind: (recordFlags & 1) !== 0 ? "documentTimestamp" : "signature",
            objectNumber: view.getUint32(at, true),
            generation: view.getUint32(at + 4, true),
            objectStart: view.getUint32(at + 8, true),
            ...(byteRange === undefined ? {} : { byteRange }),
            ...((recordFlags & 8) === 0
              ? {}
              : {
                  byteRangeValues: [
                    view.getFloat64(at + 40, true),
                    view.getFloat64(at + 48, true),
                    view.getFloat64(at + 56, true),
                    view.getFloat64(at + 64, true),
                  ],
                }),
            ...(contents === undefined ? {} : { contents }),
            unsignedPlaceholder: (recordFlags & 16) !== 0,
          };
        });
        const failure =
          failureCode === 0 ? undefined : PdfCoreSignatureFailureSchema.literals[failureCode - 1];
        return yield* Schema.decodeUnknownEffect(PdfCoreSignatureReportSchema)({
          ...(failure === undefined ? {} : { failure }),
          parseFailed: (flags & 1) !== 0,
          streamFailed: (flags & 2) !== 0,
          streamUncertain: (flags & 4) !== 0,
          limitExceeded: (flags & 8) !== 0,
          dictionaries,
        }).pipe(
          Effect.mapError(
            malformedResult(
              operation,
              PdfCoreSchemaNameValue.signatureReport,
              "The PDF core returned an invalid signature report.",
            ),
          ),
        );
      });

    const signatures = Effect.fn(function* (
      pdf: Uint8Array,
      rawAnalysis: PdfCoreSignatureAnalysis,
    ) {
      const operation = PdfCoreOperationValue.signatures;
      const analysis = yield* Schema.decodeUnknownEffect(PdfCoreSignatureAnalysisSchema)(
        rawAnalysis,
      ).pipe(Effect.mapError(invalidOptions(operation)));
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* copyIn(operation, pdf);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_signatures(input.pointer, pdf.byteLength, SIGNATURE_MODES[analysis]),
          );
          return yield* decodeSignatures(block);
        }),
      );
    });

    const revisionComplete = Effect.fn(function* (pdf: Uint8Array, end: number) {
      if (!Number.isSafeInteger(end) || end <= 0 || end > pdf.byteLength || end > MAX_UINT32) {
        return false;
      }
      return yield* Effect.scoped(
        copyIn(PdfCoreOperationValue.revision, pdf).pipe(
          Effect.map(
            (input) => core.pdf_core_revision_complete(input.pointer, pdf.byteLength, end) === 1,
          ),
        ),
      );
    });

    const decodeDocument = (block: ResultBlock): Effect.Effect<PdfCoreDocument, PdfCoreError> =>
      Effect.gen(function* () {
        const operation = PdfCoreOperationValue.document;
        const view = new DataView(block.memory, block.pointer, block.length);
        if (view.getUint32(4, true) !== STATUS_OK) return yield* failStatus(operation, block);
        const base = RESULT_HEADER_BYTES;
        if (
          view.getUint32(base, true) !== DOCUMENT_MAGIC ||
          view.getUint32(base + 4, true) !== DOCUMENT_VERSION
        ) {
          return yield* unsupportedFormat(operation);
        }
        const pageCount = view.getUint32(base + 8, true);
        const annotationCount = view.getUint32(base + 12, true);
        const nextObjectNumber = view.getUint32(base + 16, true);
        const flags = view.getUint32(base + 20, true);
        const fieldFailure = view.getUint32(base + 24, true);
        const nameLength = view.getUint32(base + 28, true);
        const box = (at: number): [number, number, number, number] => [
          view.getFloat64(at, true),
          view.getFloat64(at + 8, true),
          view.getFloat64(at + 16, true),
          view.getFloat64(at + 24, true),
        ];
        const ref = (at: number) => {
          const number = view.getUint32(at, true);
          return number === 0 ? {} : { ref: { number, generation: view.getUint32(at + 4, true) } };
        };
        const pagesAt = base + DOCUMENT_HEADER_BYTES;
        const pages = Array.from({ length: pageCount }, (_, index) => {
          const at = pagesAt + index * DOCUMENT_PAGE_RECORD_BYTES;
          return {
            mediaBox: box(at),
            cropBox: box(at + 32),
            rotate: view.getInt32(at + 64, true),
            ...ref(at + 68),
            annotationCount: view.getUint32(at + 76, true),
          };
        });
        const annotationsAt = pagesAt + pageCount * DOCUMENT_PAGE_RECORD_BYTES;
        const urisAt = annotationsAt + annotationCount * DOCUMENT_ANNOTATION_RECORD_BYTES;
        let uriBytes = 0;
        const annotations = Array.from({ length: annotationCount }, (_, index) => {
          const at = annotationsAt + index * DOCUMENT_ANNOTATION_RECORD_BYTES;
          const annotationFlags = view.getUint32(at + 16, true);
          const slot = view.getUint32(at + 20, true);
          const first = view.getUint32(at + 24, true);
          const second = view.getUint32(at + 28, true);
          const uriOffset = view.getUint32(at + 64, true);
          const uriLength = view.getUint32(at + 68, true);
          uriBytes += uriLength;
          const signatureSlot = Match.value(slot).pipe(
            Match.when(1, () => ({ kind: "open", field: { kind: "widget" } })),
            Match.when(2, () => ({
              kind: "open",
              field: { kind: "object", ref: { number: first, generation: second } },
            })),
            Match.when(3, () => ({ kind: "open", field: { kind: "widgetParent" } })),
            Match.when(4, () => ({
              kind: "malformed",
              reason: PdfCoreSignatureSlotFailureSchema.literals[first - 1],
            })),
            Match.orElse(() => ({ kind: "none" })),
          );
          return {
            pageIndex: view.getUint32(at, true),
            index: view.getUint32(at + 4, true),
            ...ref(at + 8),
            widget: (annotationFlags & 1) !== 0,
            titled: (annotationFlags & 4) !== 0,
            ...((annotationFlags & 2) === 0 ? {} : { rect: box(at + 32) }),
            ...((annotationFlags & 8) === 0
              ? {}
              : {
                  uri: utf8.decode(
                    new Uint8Array(block.memory, block.pointer + urisAt + uriOffset, uriLength),
                  ),
                }),
            signatureSlot,
          };
        });
        const nameAt = urisAt + uriBytes;
        const fieldName =
          (flags & 2) !== 0
            ? {
                _tag: "available",
                name: utf8.decode(new Uint8Array(block.memory, block.pointer + nameAt, nameLength)),
              }
            : (flags & 4) !== 0
              ? {
                  _tag: "failed",
                  reason: PdfCoreFieldNameFailureSchema.literals[fieldFailure - 1],
                }
              : undefined;
        return yield* Schema.decodeUnknownEffect(PdfCoreDocumentSchema)({
          nextObjectNumber,
          acroForm: (flags & 1) !== 0,
          pages,
          annotations,
          ...(fieldName === undefined ? {} : { fieldName }),
        }).pipe(
          Effect.mapError(
            malformedResult(
              operation,
              PdfCoreSchemaNameValue.document,
              "The PDF core returned an invalid document description.",
            ),
          ),
        );
      });

    const document = Effect.fn(function* (
      pdf: Uint8Array,
      rawOptions: PdfCoreDocumentOptions = {},
    ) {
      const operation = PdfCoreOperationValue.document;
      const options = yield* Schema.decodeUnknownEffect(PdfCoreDocumentOptionsSchema)(
        rawOptions,
      ).pipe(Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.documentOptions)));
      const pageIndexes = options.annotationPages ?? [];
      const prefix = utf8Encoder.encode(options.fieldNamePrefix ?? "");
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* copyIn(operation, pdf);
          const pages = yield* allocate(
            operation,
            pageIndexes.length * Uint32Array.BYTES_PER_ELEMENT,
          );
          new Uint32Array(core.memory.buffer, pages.pointer, pageIndexes.length).set(pageIndexes);
          const prefixInput = yield* copyIn(operation, prefix);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_document(
              input.pointer,
              pdf.byteLength,
              options.annotationPages === undefined ? 0 : FLAG_PAGE_INDEXES,
              pages.pointer,
              pageIndexes.length,
              prefixInput.pointer,
              prefix.byteLength,
            ),
          );
          return yield* decodeDocument(block);
        }),
      );
    });

    const edit = Effect.fn(function* (
      pdf: Uint8Array,
      rawOperations: PdfCoreEditOperations,
      rawOptions: PdfCoreEditOptions = {},
    ) {
      const operation = PdfCoreOperationValue.edit;
      const operations = yield* Schema.decodeUnknownEffect(PdfCoreEditOperationsSchema)(
        rawOperations,
      ).pipe(Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.editOperations)));
      const options = yield* Schema.decodeUnknownEffect(PdfCoreEditOptionsSchema)(rawOptions).pipe(
        Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.editOptions)),
      );
      const writer = payloadWriter();
      writer.u32(EDIT_MAGIC);
      writer.u32(EDIT_VERSION);
      writer.u32(
        Match.value(options.mode ?? "auto").pipe(
          Match.when("auto", () => 0),
          Match.when("incremental", () => EDIT_INCREMENTAL),
          Match.when("rewrite", () => EDIT_REWRITE),
          Match.exhaustive,
        ) | (options.objectStreams === true ? EDIT_OBJECT_STREAMS : 0),
      );
      writer.u32(operations.length);
      for (const value of operations) writeOperation(writer, value);
      const payload = writer.finish();
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* copyIn(operation, pdf);
          const ops = yield* copyIn(operation, payload);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_edit(input.pointer, pdf.byteLength, ops.pointer, payload.byteLength),
          );
          return yield* payloadBytes(operation, block);
        }),
      );
    });

    const merge = Effect.fn(function* (
      rawSources: PdfCoreMergeSources,
      rawOptions: PdfCoreMergeOptions = {},
    ) {
      const operation = PdfCoreOperationValue.merge;
      const sources = yield* Schema.decodeUnknownEffect(PdfCoreMergeSourcesSchema)(rawSources).pipe(
        Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.mergeSources)),
      );
      const options = yield* Schema.decodeUnknownEffect(PdfCoreMergeOptionsSchema)(rawOptions).pipe(
        Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.mergeOptions)),
      );
      const writer = payloadWriter();
      writer.u32(sources.length);
      for (const source of sources) {
        writer.u32(source.pdf.byteLength);
        const pages = source.pageIndexes;
        writer.u32(pages === undefined ? ALL_PAGES : pages.length);
        for (const page of pages ?? []) writer.u32(page);
      }
      const header = writer.finish();
      const total = sources.reduce((sum, source) => sum + source.pdf.byteLength, header.byteLength);
      const flags =
        (options.dropWidgets === true ? MERGE_DROP_WIDGETS : 0) |
        (options.objectStreams === true ? MERGE_OBJECT_STREAMS : 0);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* allocate(operation, total);
          const view = new Uint8Array(core.memory.buffer, input.pointer, total);
          view.set(header);
          let offset = header.byteLength;
          for (const source of sources) {
            view.set(source.pdf, offset);
            offset += source.pdf.byteLength;
          }
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_merge(input.pointer, total, flags),
          );
          return yield* payloadBytes(operation, block);
        }),
      );
    });

    const deflate = Effect.fn(function* (data: Uint8Array) {
      const operation = PdfCoreOperationValue.deflate;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* copyIn(operation, data);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_deflate(input.pointer, data.byteLength),
          );
          return yield* payloadBytes(operation, block);
        }),
      );
    });

    const create = Effect.fn(function* (rawOptions: PdfCoreCreateOptions) {
      const operation = PdfCoreOperationValue.create;
      const options = yield* Schema.decodeUnknownEffect(PdfCoreCreateOptionsSchema)(
        rawOptions,
      ).pipe(Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.createOptions)));
      const sizes = Float64Array.from(options.pages.flatMap((page) => [page.width, page.height]));
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* allocate(operation, sizes.byteLength);
          new Float64Array(core.memory.buffer, input.pointer, sizes.length).set(sizes);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_create(input.pointer, sizes.length),
          );
          return yield* payloadBytes(operation, block);
        }),
      );
    });

    const fontMetrics = Effect.fn(function* (rawBaseFont: PdfCoreWinAnsiFont) {
      const operation = PdfCoreOperationValue.fontMetrics;
      const baseFont = yield* Schema.decodeUnknownEffect(PdfCoreWinAnsiFontSchema)(
        rawBaseFont,
      ).pipe(Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.fontName)));
      const name = utf8Encoder.encode(baseFont);
      const payload = yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* copyIn(operation, name);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_font_metrics(input.pointer, name.byteLength),
          );
          return yield* payloadBytes(operation, block);
        }),
      );
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      if (
        payload.byteLength !== METRICS_PAYLOAD_BYTES ||
        view.getUint32(0, true) !== METRICS_MAGIC ||
        view.getUint32(4, true) !== METRICS_VERSION
      ) {
        return yield* new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation,
          reason: "The PDF core returned malformed font metrics.",
        });
      }
      const unicode = new Uint16Array(256);
      const widths = new Uint16Array(256);
      for (let code = 0; code < 256; code += 1) {
        unicode[code] = view.getUint16(8 + code * 4, true);
        widths[code] = view.getUint16(10 + code * 4, true);
      }
      return { baseFont, unicode, widths };
    });

    return {
      inspect,
      text,
      tables,
      signatures,
      revisionComplete,
      document,
      edit,
      merge,
      deflate,
      create,
      fontMetrics,
    };
  });

export const pdfCoreLayer = (module: WebAssembly.Module): Layer.Layer<PdfCore, PdfCoreError> =>
  Layer.effect(PdfCore, makePdfCore(module));
