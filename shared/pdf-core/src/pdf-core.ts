import { Context, Effect, Layer, Match, Ref, Schema, Semaphore } from "effect";
import type { Scope } from "effect";

import {
  PdfCoreCreateOptionsSchema,
  PDF_CORE_DEFAULT_RENDER_SCALE,
  PdfCoreDisplayListsSchema,
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
  PDF_CORE_MAX_LAZY_BYTES,
  PdfCoreLazyOptionsSchema,
  PdfCoreRangeSizeSchema,
  PdfCoreRenderOptionsSchema,
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
  PdfCoreDisplayLists,
  PdfCoreDocument,
  PdfCoreDocumentOptions,
  PdfCoreEditOperation,
  PdfCoreEditOperations,
  PdfCoreEditOptions,
  PdfCoreEditTarget,
  PdfCoreFontMetrics,
  PdfCoreInspection,
  PdfCoreInspectOptions,
  PdfCoreLazyOptions,
  PdfCoreLazyStats,
  PdfCoreMergeOptions,
  PdfCoreMergeSources,
  PdfCoreObjectRef,
  PdfCoreOperation,
  PdfCorePngSize,
  PdfCoreRenderOptions,
  PdfCoreSchemaName,
  PdfCoreSignatureAnalysis,
  PdfCoreSignatureReport,
  PdfCoreTables,
  PdfCoreTablesOptions,
  PdfCoreText,
  PdfCoreTextOptions,
  PdfCoreTextPages,
  PdfCoreOcrOptions,
  PdfCoreOcrRaster,
  PdfCoreOcrRequest,
  PdfCoreWinAnsiFont,
} from "./config.js";

import { recognizePages } from "./ocr.js";
import type { OcrPage } from "./ocr.js";

export type PdfCoreRangeSource = {
  readonly size: number;
  readonly read: (offset: number, length: number) => Effect.Effect<Uint8Array, PdfCoreError>;
};

export type PdfCoreLazyDocument = {
  readonly text: <E = never, R = never>(
    options?: PdfCoreTextOptions<E, R>,
  ) => Effect.Effect<PdfCoreText, PdfCoreError | E, R>;
  readonly textPages: <E = never, R = never>(
    options?: PdfCoreTextOptions<E, R>,
  ) => Effect.Effect<PdfCoreTextPages, PdfCoreError | E, R>;
  readonly tables: <E = never, R = never>(
    options?: PdfCoreTablesOptions<E, R>,
  ) => Effect.Effect<PdfCoreTables, PdfCoreError | E, R>;
  readonly renderPages: (
    options?: PdfCoreRenderOptions,
  ) => Effect.Effect<PdfCoreDisplayLists, PdfCoreError>;
  readonly stats: Effect.Effect<PdfCoreLazyStats>;
};

export const pdfCoreBytesSource = (bytes: Uint8Array): PdfCoreRangeSource => ({
  size: bytes.byteLength,
  read: (offset, length) => Effect.sync(() => bytes.subarray(offset, offset + length)),
});

export const pdfCoreBlobSource = (blob: Blob): PdfCoreRangeSource => ({
  size: blob.size,
  read: (offset, length) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.rangeReadFailed,
          operation: PdfCoreOperationValue.readRange,
          reason: "The PDF Blob range could not be read.",
        }),
    }),
});

export type PdfCoreService = {
  readonly openLazy: (
    source: PdfCoreRangeSource,
    options?: PdfCoreLazyOptions,
  ) => Effect.Effect<PdfCoreLazyDocument, PdfCoreError, Scope.Scope>;
  readonly wasmMemoryBytes: () => Effect.Effect<number>;
  readonly inspect: (
    pdf: Uint8Array,
    options: PdfCoreInspectOptions,
  ) => Effect.Effect<PdfCoreInspection, PdfCoreError>;
  readonly text: <E = never, R = never>(
    pdf: Uint8Array,
    options?: PdfCoreTextOptions<E, R>,
  ) => Effect.Effect<PdfCoreText, PdfCoreError | E, R>;
  readonly textPages: <E = never, R = never>(
    pdf: Uint8Array,
    options?: PdfCoreTextOptions<E, R>,
  ) => Effect.Effect<PdfCoreTextPages, PdfCoreError | E, R>;
  readonly tables: <E = never, R = never>(
    pdf: Uint8Array,
    options?: PdfCoreTablesOptions<E, R>,
  ) => Effect.Effect<PdfCoreTables, PdfCoreError | E, R>;
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
  readonly pngSize: (png: Uint8Array) => Effect.Effect<PdfCorePngSize, PdfCoreError>;
  readonly renderPages: (
    pdf: Uint8Array,
    options?: PdfCoreRenderOptions,
  ) => Effect.Effect<PdfCoreDisplayLists, PdfCoreError>;
};

export class PdfCore extends Context.Service<PdfCore, PdfCoreService>()(
  "@signature-kit/pdf-core/PdfCore",
) {}

const FLAG_TEXT = 1;
const FLAG_LINKS = 2;
const FLAG_PAGE_INDEXES = 4;
const FLAG_MARKDOWN = 8;
const FLAG_DROP_RUNNING = 16;
const FLAG_RUNS = 32;
const FLAG_OCR_TABLES = 64;
const STATUS_OK = 0;
const STATUS_LIMIT_EXCEEDED = 3;
const MAGIC = 0x4346_4450;
const VERSION = 3;
const TEXT_MAGIC = 0x5854_4450;
const TEXT_VERSION = 1;
const TEXT_HEADER_BYTES = 16;
const TABLES_MAGIC = 0x4254_4450;
const TABLES_VERSION = 1;
const TABLES_HEADER_BYTES = 16;
const TABLE_RECORD_BYTES = 48;
const CELL_RECORD_BYTES = 56;
const RENDER_MAGIC = 0x4c52_4450;
const RENDER_VERSION = 1;
const RENDER_HEADER_BYTES = 16;
const RENDER_PAGE_HEADER_BYTES = 56;
const RESULT_HEADER_BYTES = 8;
const PAGE_RECORD_BYTES = 72;
const LINK_RECORD_BYTES = 48;
const TEXT_PAGE_HEADER_BYTES = 16;
const TEXT_ITEM_FLOATS = 5;
const MAX_UINT32 = 0xffff_ffff;
const SIGNATURES_MAGIC = 0x4753_4450;
const SIGNATURES_VERSION = 2;
const SIGNATURES_HEADER_BYTES = 24;
const SIGNATURE_RECORD_BYTES = 80;
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
  readonly floats: (values: ReadonlyArray<number>) => void;
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
    floats: (values) => {
      const data = new Uint8Array(values.length * Float64Array.BYTES_PER_ELEMENT);
      const view = new DataView(data.buffer);
      values.forEach((value, index) =>
        view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, value, true),
      );
      push(data);
    },
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

type BlockReader = <A>(
  operation: PdfCoreOperation,
  entry: Entry,
  flags: number,
  pageIndexes: ReadonlyArray<number>,
  decode: (block: ResultBlock) => Effect.Effect<A, PdfCoreError>,
  scale?: number,
  ocr?: Uint8Array,
) => Effect.Effect<A, PdfCoreError>;

const lazyProfiles = {
  [PdfCoreOperationValue.text]: 0,
  [PdfCoreOperationValue.tables]: 1,
  [PdfCoreOperationValue.render]: 2,
};

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
      ocr?: Uint8Array,
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
          const extract = core.pdf_core_extract_ocr;
          if (ocr !== undefined && extract === undefined) {
            return yield* new PdfCoreError({
              code: PdfCoreErrorCodeValue.wasmLoadFailed,
              operation,
              reason: "The PDF core WebAssembly module does not support OCR extraction.",
            });
          }
          const payload = ocr === undefined ? undefined : yield* copyIn(operation, ocr);
          const result = yield* Effect.acquireRelease(
            Effect.suspend(() => {
              const pointer =
                (payload === undefined || extract === undefined
                  ? entry(input.pointer, pdf.byteLength, flags, pages.pointer, pageIndexes.length)
                  : extract(
                      input.pointer,
                      pdf.byteLength,
                      flags | (operation === PdfCoreOperationValue.tables ? FLAG_OCR_TABLES : 0),
                      pages.pointer,
                      pageIndexes.length,
                      payload.pointer,
                      payload.length,
                    )) >>> 0;
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
      guard?: () => PdfCoreError | undefined,
    ): Effect.Effect<ResultBlock, PdfCoreError, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const blocked = guard?.();
          if (blocked !== undefined) {
            return Effect.fail(blocked);
          }
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
            STATUS_LIMIT_EXCEEDED,
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
          const stylesAt = align8(offsetsAt + (itemCount + 1) * Uint32Array.BYTES_PER_ELEMENT);
          const blobAt = align8(stylesAt + itemCount);
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
            styles: bytes(stylesAt, itemCount).slice(),
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
        (options.runs === true ? FLAG_RUNS : 0) |
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

    const textOptions = Effect.fn(function* (rawOptions: unknown) {
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
      return options;
    });

    const readText = (read: BlockReader, options: PdfCoreTextOptions, ocr?: Uint8Array) => {
      const pageIndexes = options.pageIndexes ?? [];
      const flags =
        (options.pageIndexes === undefined ? 0 : FLAG_PAGE_INDEXES) |
        (options.format === "markdown" ? FLAG_MARKDOWN : 0) |
        (options.dropRunningHeaders === false ? 0 : FLAG_DROP_RUNNING);
      return read(
        PdfCoreOperationValue.text,
        core.pdf_core_text,
        flags,
        pageIndexes,
        decodeTextBlock,
        undefined,
        ocr,
      );
    };

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

    const runTables = Effect.fn(function* <E, R>(
      read: BlockReader,
      rawOptions: PdfCoreTablesOptions<E, R> = {},
    ) {
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
      const ocr = rawOptions.ocr;
      const recognized =
        ocr === undefined || ocr?.policy === "never"
          ? []
          : yield* readOcrDetails(read, options.pageIndexes).pipe(
              Effect.flatMap((pages) =>
                runOcr(read, PdfCoreOperationValue.tables, ocr, pages, false),
              ),
            );
      const tables = yield* read(
        PdfCoreOperationValue.tables,
        core.pdf_core_tables,
        flags,
        pageIndexes,
        decodeTablesBlock,
        undefined,
        encodeOcr(recognized),
      );
      if (recognized.length === 0) return tables;
      const replaced = new Set(recognized.map(({ pageIndex }) => pageIndex));
      return tables.map((table) =>
        replaced.has(table.pageIndex) ? { ...table, source: "ocr" } : table,
      ) satisfies PdfCoreTables;
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
          const subFilterOffset = view.getUint32(at + 72, true);
          const subFilter =
            subFilterOffset === 0
              ? undefined
              : utf8.decode(
                  new Uint8Array(
                    block.memory,
                    block.pointer + base + subFilterOffset,
                    view.getUint32(at + 76, true),
                  ),
                );
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
            ...(subFilter === undefined ? {} : { subFilter }),
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

    const pngSize = Effect.fn(function* (png: Uint8Array) {
      const operation = PdfCoreOperationValue.pngSize;
      const payload = yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* copyIn(operation, png);
          const block = yield* resultBlock(operation, () =>
            core.pdf_core_png_size(input.pointer, png.byteLength),
          );
          return yield* payloadBytes(operation, block);
        }),
      );
      if (payload.byteLength !== 8) {
        return yield* new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation,
          reason: "The PDF core returned a malformed PNG size.",
        });
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      return { width: view.getUint32(0, true), height: view.getUint32(4, true) };
    });

    const decodeRenderBlock =
      (scale: number) =>
      (block: ResultBlock): Effect.Effect<PdfCoreDisplayLists, PdfCoreError> =>
        Effect.gen(function* () {
          const view = new DataView(block.memory, block.pointer, block.length);
          if (view.getUint32(4, true) !== STATUS_OK) {
            return yield* failStatus(PdfCoreOperationValue.render, block);
          }
          const base = RESULT_HEADER_BYTES;
          if (
            view.getUint32(base, true) !== RENDER_MAGIC ||
            view.getUint32(base + 4, true) !== RENDER_VERSION
          ) {
            return yield* new PdfCoreError({
              code: PdfCoreErrorCodeValue.wasmLoadFailed,
              operation: PdfCoreOperationValue.render,
              reason: "The PDF core render format is not supported by this package version.",
            });
          }
          const pageCount = view.getUint32(base + 8, true);
          const copy = (at: number, length: number): Uint8Array =>
            new Uint8Array(block.memory, block.pointer + at, length).slice();
          const pages = [];
          let cursor = base + RENDER_HEADER_BYTES;
          for (let index = 0; index < pageCount; index += 1) {
            const opsLength = view.getUint32(cursor + 8, true);
            const blobCount = view.getUint32(cursor + 12, true);
            const opsAt = cursor + RENDER_PAGE_HEADER_BYTES;
            const tableAt = align8(opsAt + opsLength);
            const blobsAt = align8(tableAt + blobCount * 8);
            const blobs = Array.from({ length: blobCount }, (_, blob) =>
              copy(
                blobsAt + view.getUint32(tableAt + blob * 8, true),
                view.getUint32(tableAt + blob * 8 + 4, true),
              ),
            );
            pages.push({
              pageIndex: view.getUint32(cursor, true),
              rotate: view.getInt32(cursor + 4, true),
              view: [
                view.getFloat64(cursor + 16, true),
                view.getFloat64(cursor + 24, true),
                view.getFloat64(cursor + 32, true),
                view.getFloat64(cursor + 40, true),
              ],
              scale,
              ops: copy(opsAt, opsLength),
              blobs,
            });
            cursor += view.getUint32(cursor + 48, true);
          }
          return yield* Schema.decodeUnknownEffect(PdfCoreDisplayListsSchema)(pages).pipe(
            Effect.mapError(
              (issue) =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.wasmLoadFailed,
                  operation: PdfCoreOperationValue.render,
                  schemaName: PdfCoreSchemaNameValue.displayLists,
                  reason: "The PDF core returned an invalid render result.",
                  issueMessage: String(issue),
                }),
            ),
          );
        });

    const runRenderPages = Effect.fn(function* (
      read: BlockReader,
      rawOptions: PdfCoreRenderOptions = {},
    ) {
      const options = yield* Schema.decodeUnknownEffect(PdfCoreRenderOptionsSchema)(
        rawOptions,
      ).pipe(
        Effect.mapError(
          (issue) =>
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.invalidOptions,
              operation: PdfCoreOperationValue.render,
              schemaName: PdfCoreSchemaNameValue.renderOptions,
              issueMessage: String(issue),
            }),
        ),
      );
      const scale = options.scale ?? PDF_CORE_DEFAULT_RENDER_SCALE;
      const pageIndexes = options.pageIndexes ?? [];
      const flags = options.pageIndexes === undefined ? 0 : FLAG_PAGE_INDEXES;
      return yield* read(
        PdfCoreOperationValue.render,
        (pdfPointer, pdfLength, entryFlags, pagesPointer, pagesLength) =>
          core.pdf_core_render(pdfPointer, pdfLength, entryFlags, pagesPointer, pagesLength, scale),
        flags,
        pageIndexes,
        decodeRenderBlock(scale),
        scale,
      );
    });

    const readOcrDetails = Effect.fn(function* (
      read: BlockReader,
      pageIndexes: ReadonlyArray<number> | undefined,
    ): Effect.fn.Return<ReadonlyArray<Omit<PdfCoreOcrRequest, "image">>, PdfCoreError> {
      const pages = yield* runRenderPages(read, { pageIndexes, scale: 1 });
      const text = yield* readText(read, { pageIndexes, dropRunningHeaders: false });
      return pages.map(({ pageIndex, view, rotate }, index) => ({
        pageIndex,
        pageBox: view,
        rotate,
        textLayer: (text[index]?.trim().length ?? 0) > 0 ? "usable" : "none",
      }));
    });

    const encodeOcr = (pages: ReadonlyArray<OcrPage>): Uint8Array | undefined => {
      if (pages.length === 0) return undefined;
      const writer = payloadWriter();
      for (const { pageIndex, content } of [...pages].sort(
        (left, right) => left.pageIndex - right.pageIndex,
      )) {
        writer.u32(pageIndex);
        if ("text" in content) {
          writer.u32(0);
          writer.text(content.text);
          continue;
        }
        writer.u32(1);
        writer.u32(content.words.length);
        for (const word of content.words) {
          writer.floats(word.geometry);
          writer.text(word.text);
        }
      }
      return writer.finish();
    };

    const runOcr = <E, R>(
      read: BlockReader,
      operation: PdfCoreOperation,
      options: PdfCoreOcrOptions<E, R> | undefined,
      pages: ReadonlyArray<Omit<PdfCoreOcrRequest, "image">>,
      markdown: boolean,
    ) =>
      recognizePages(
        operation,
        options,
        pages,
        (_pageIndex): Effect.Effect<PdfCoreOcrRaster | undefined, PdfCoreError> =>
          Effect.succeed(undefined),
        (pageIndex) =>
          runRenderPages(read, { pageIndexes: [pageIndex] }).pipe(Effect.map(([page]) => page)),
        markdown,
      );

    const runText = Effect.fn(function* <E, R>(
      read: BlockReader,
      rawOptions: PdfCoreTextOptions<E, R> = {},
    ) {
      const options = yield* textOptions(rawOptions);
      const ocr = rawOptions.ocr;
      if (ocr === undefined || ocr?.policy === "never") return yield* readText(read, options);
      const pages = yield* readOcrDetails(read, options.pageIndexes);
      const recognized = yield* runOcr(
        read,
        PdfCoreOperationValue.text,
        ocr,
        pages,
        options.format === "markdown",
      );
      return yield* readText(read, options, encodeOcr(recognized));
    });

    const runTextPages = Effect.fn(function* <E, R>(
      read: BlockReader,
      rawOptions: PdfCoreTextOptions<E, R> = {},
    ): Effect.fn.Return<PdfCoreTextPages, PdfCoreError | E, R> {
      const options = yield* textOptions(rawOptions);
      const pages = yield* readOcrDetails(read, options.pageIndexes);
      const recognized = yield* runOcr(
        read,
        PdfCoreOperationValue.text,
        rawOptions.ocr,
        pages,
        options.format === "markdown",
      );
      const text = yield* readText(read, options, encodeOcr(recognized));
      const replaced = new Map(recognized.map((page) => [page.pageIndex, page]));
      return pages.map(({ pageIndex, textLayer }, index) => {
        const page = replaced.get(pageIndex);
        return {
          pageIndex,
          text: text[index] ?? "",
          textLayer,
          source: page === undefined ? "native" : "ocr",
          ...(page?.confidence === undefined ? {} : { confidence: page.confidence }),
        };
      });
    });

    const full =
      (pdf: Uint8Array): BlockReader =>
      (operation, entry, flags, indexes, decode, _scale, ocr) =>
        readBlock(operation, entry, pdf, flags, indexes, decode, ocr);

    const openLazy = Effect.fn(function* (
      source: PdfCoreRangeSource,
      options?: PdfCoreLazyOptions,
    ) {
      const operation = PdfCoreOperationValue.openLazy;
      const size = yield* Schema.decodeUnknownEffect(PdfCoreRangeSizeSchema)(source.size).pipe(
        Effect.mapError(invalidOptions(operation)),
      );
      const tuning = yield* Schema.decodeUnknownEffect(PdfCoreLazyOptionsSchema)(
        options === undefined ? {} : options,
      ).pipe(Effect.mapError(invalidOptions(operation, PdfCoreSchemaNameValue.lazyOptions)));
      if (size > PDF_CORE_MAX_LAZY_BYTES) {
        return yield* new PdfCoreError({
          code: PdfCoreErrorCodeValue.limitExceeded,
          operation,
          reason: "Lazy PDF sources may contain at most 512 MiB.",
        });
      }
      const maxRoundBytes = tuning.maxRoundBytes ?? 2 * 1024 * 1024;
      const lock = yield* Semaphore.make(1);
      type LazyState = PdfCoreLazyStats & {
        readonly closed: boolean;
        readonly fallback?: Uint8Array;
      };
      const state = yield* Ref.make<LazyState>({
        closed: false,
        bytesRead: 0,
        rounds: 0,
        strategy: "lazy",
      });
      const handle = yield* Effect.acquireRelease(
        Effect.suspend(() => {
          const opened =
            core.pdf_core_lazy_open(
              size,
              tuning.probeBytes ?? 64 * 1024,
              tuning.gapBytes ?? 32 * 1024,
              maxRoundBytes,
            ) >>> 0;
          return opened === 0
            ? Effect.fail(
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.limitExceeded,
                  operation,
                  reason: "This WebAssembly instance exhausted its lazy document handles.",
                }),
              )
            : Effect.succeed(opened);
        }),
        (opened) =>
          Ref.update(state, ({ closed: _closed, fallback: _fallback, ...stats }) => ({
            ...stats,
            closed: true,
          })).pipe(Effect.andThen(Effect.sync(() => core.pdf_core_lazy_close(opened)))),
      );

      const closed = () =>
        Ref.getUnsafe(state).closed
          ? new PdfCoreError({ code: PdfCoreErrorCodeValue.documentClosed, operation })
          : undefined;
      const ensureOpen = Effect.suspend(() => {
        const precise = closed();
        return precise === undefined ? Effect.void : Effect.fail(precise);
      });

      const fetchRange = Effect.fn(function* (offset: number, length: number) {
        yield* ensureOpen;
        const bytes = yield* source.read(offset, length);
        yield* Ref.update(state, (current) => ({
          ...current,
          bytesRead: current.bytesRead + bytes.byteLength,
        }));
        yield* ensureOpen;
        if (bytes.byteLength !== length) {
          return yield* new PdfCoreError({
            code: PdfCoreErrorCodeValue.rangeReadFailed,
            operation: PdfCoreOperationValue.readRange,
            reason: `Expected ${length} bytes at offset ${offset}, received ${bytes.byteLength}.`,
          });
        }
        return bytes;
      });

      const startRound = Ref.update(state, (current) => ({
        ...current,
        rounds: current.rounds + 1,
      }));
      const supply = Effect.fn(function* (
        ranges: ReadonlyArray<{ offset: number; length: number }>,
      ) {
        yield* startRound;
        const batch = yield* Effect.forEach(
          ranges,
          ({ offset, length }) => fetchRange(offset, length),
          { concurrency: 4 },
        );
        const length = batch.reduce((sum, bytes) => sum + bytes.byteLength, 0);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const input = yield* allocate(PdfCoreOperationValue.readRange, length);
            const blocked = closed();
            if (blocked !== undefined) {
              return yield* blocked;
            }
            let pointer = input.pointer;
            for (const [index, range] of ranges.entries()) {
              const bytes = batch[index];
              if (bytes === undefined) {
                return yield* Effect.die("Missing bytes in the lazy PDF range batch.");
              }
              new Uint8Array(core.memory.buffer, pointer, bytes.byteLength).set(bytes);
              if (core.pdf_core_lazy_feed(handle, range.offset, pointer, bytes.byteLength) !== 1) {
                return yield* Effect.die("The PDF core rejected its own planned byte range.");
              }
              pointer += bytes.byteLength;
            }
          }),
        );
      });

      const plan = Effect.fn(function* (
        operation: PdfCoreOperation,
        profile: number,
        flags: number,
        pages: Allocation,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const result = yield* resultBlock(
              operation,
              () =>
                core.pdf_core_lazy_plan(
                  handle,
                  flags,
                  pages.pointer,
                  pages.length / Uint32Array.BYTES_PER_ELEMENT,
                  profile,
                ),
              closed,
            ).pipe(
              Effect.catchIf(
                (error) => error.code === PdfCoreErrorCodeValue.wasmLoadFailed,
                Effect.die,
              ),
            );
            const view = new DataView(result.memory, result.pointer, result.length);
            const resultStatus = view.getUint32(4, true);
            if (resultStatus === STATUS_LIMIT_EXCEEDED) {
              return yield* failStatus(operation, result);
            }
            if (resultStatus !== STATUS_OK) {
              return yield* Effect.die("The PDF core failed to encode its lazy plan.");
            }
            const payload = result.length - RESULT_HEADER_BYTES;
            const status = payload >= 4 ? view.getUint32(RESULT_HEADER_BYTES, true) : -1;
            if ((status === 0 || status === 2) && payload === 4) {
              return { status, ranges: [] };
            }
            if (status !== 1 || payload < 12 || (payload - 4) % 8 !== 0) {
              return yield* Effect.die("The PDF core returned an invalid lazy plan.");
            }
            const ranges = [];
            let previousEnd = 0;
            let totalBytes = 0;
            for (let cursor = RESULT_HEADER_BYTES + 4; cursor < result.length; cursor += 8) {
              const offset = view.getUint32(cursor, true);
              const length = view.getUint32(cursor + 4, true);
              if (length === 0 || offset < previousEnd || offset + length > size) {
                return yield* Effect.die(
                  "The PDF core returned overlapping or out-of-bounds ranges.",
                );
              }
              ranges.push({ offset, length });
              previousEnd = offset + length;
              totalBytes += length;
            }
            if (totalBytes > maxRoundBytes) {
              return yield* Effect.die("The lazy plan exceeds the round byte limit.");
            }
            return { status, ranges };
          }),
        );
      });

      const read: BlockReader = (operation, entry, flags, indexes, decode, requestedScale, ocr) =>
        lock.withPermits(1)(
          Effect.scoped(
            Effect.gen(function* () {
              const scale = requestedScale ?? 1;
              const profile =
                operation === PdfCoreOperationValue.text ||
                operation === PdfCoreOperationValue.tables ||
                operation === PdfCoreOperationValue.render
                  ? lazyProfiles[operation]
                  : undefined;
              if (profile === undefined) {
                return yield* Effect.die("Invalid lazy PDF operation.");
              }
              yield* ensureOpen;
              const pages = yield* allocate(
                operation,
                indexes.length * Uint32Array.BYTES_PER_ELEMENT,
              );
              new Uint32Array(core.memory.buffer, pages.pointer, indexes.length).set(indexes);
              const extract = core.pdf_core_lazy_run_ocr;
              if (ocr !== undefined && extract === undefined) {
                return yield* new PdfCoreError({
                  code: PdfCoreErrorCodeValue.wasmLoadFailed,
                  operation,
                  reason: "The PDF core WebAssembly module does not support lazy OCR extraction.",
                });
              }
              const payload = ocr === undefined ? undefined : yield* copyIn(operation, ocr);
              while (Ref.getUnsafe(state).strategy === "lazy") {
                const next = yield* plan(operation, profile, flags, pages);
                if (next.status === 1) {
                  yield* supply(next.ranges);
                  continue;
                }
                if (next.status === 0) {
                  const decoded = yield* Effect.scoped(
                    Effect.gen(function* () {
                      yield* ensureOpen;
                      const result = yield* resultBlock(
                        operation,
                        () =>
                          payload === undefined || extract === undefined
                            ? core.pdf_core_lazy_run(handle, profile, flags, scale)
                            : extract(handle, profile, flags, payload.pointer, payload.length),
                        closed,
                      );
                      const view = new DataView(result.memory, result.pointer, result.length);
                      if (view.getUint32(4, true) === STATUS_OK) {
                        if (result.length === RESULT_HEADER_BYTES) {
                          return { fallback: true };
                        }
                        if (result.length === RESULT_HEADER_BYTES + 4) {
                          if (view.getUint32(RESULT_HEADER_BYTES, true) !== 1) {
                            return yield* Effect.die(
                              "The PDF core returned an invalid lazy retry.",
                            );
                          }
                          return { retry: true };
                        }
                      }
                      return { value: yield* decode(result) };
                    }),
                  );
                  if ("value" in decoded) {
                    return decoded.value;
                  }
                  if ("retry" in decoded) {
                    continue;
                  }
                }
                yield* Ref.update(state, (current): LazyState => ({
                  ...current,
                  strategy: "fallback",
                }));
                core.pdf_core_lazy_close(handle);
              }
              const cached = (yield* Ref.get(state)).fallback;
              const bytes = cached ?? (yield* startRound.pipe(Effect.andThen(fetchRange(0, size))));
              yield* Ref.update(state, (current) =>
                current.closed ? current : { ...current, fallback: bytes },
              );
              yield* ensureOpen;
              return yield* full(bytes)(operation, entry, flags, indexes, decode, scale, ocr);
            }),
          ),
        );

      return {
        text: <E, R>(options?: PdfCoreTextOptions<E, R>) => runText(read, options),
        textPages: <E, R>(options?: PdfCoreTextOptions<E, R>) => runTextPages(read, options),
        tables: <E, R>(options?: PdfCoreTablesOptions<E, R>) => runTables(read, options),
        renderPages: (options?: PdfCoreRenderOptions) => runRenderPages(read, options),
        stats: Ref.get(state).pipe(
          Effect.map(({ bytesRead, rounds, strategy }) => ({ bytesRead, rounds, strategy })),
        ),
      };
    });

    return {
      openLazy,
      wasmMemoryBytes: () => Effect.sync(() => core.memory.buffer.byteLength),
      inspect,
      text: (pdf, options) => runText(full(pdf), options),
      textPages: (pdf, options) => runTextPages(full(pdf), options),
      tables: (pdf, options) => runTables(full(pdf), options),
      renderPages: (pdf, options) => runRenderPages(full(pdf), options),
      signatures,
      revisionComplete,
      document,
      edit,
      merge,
      deflate,
      create,
      fontMetrics,
      pngSize,
    };
  });

export const pdfCoreLayer = (module: WebAssembly.Module): Layer.Layer<PdfCore, PdfCoreError> =>
  Layer.effect(PdfCore, makePdfCore(module));
