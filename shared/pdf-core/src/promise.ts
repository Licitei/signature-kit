import { Effect, Exit, Scope } from "effect";

import { pdfCoreBrowserModule } from "./browser.js";
import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import type {
  PdfCoreDisplayList,
  PdfCoreLazyOptions,
  PdfCoreLazyStats,
  PdfCoreOcrOptions,
  PdfCoreOcrRaster,
  PdfCoreOcrRequest,
  PdfCoreOcrResult,
  PdfCoreOperation,
  PdfCoreTables,
  PdfCoreTablesOptions,
  PdfCoreText,
  PdfCoreTextOptions,
  PdfCoreTextPages,
} from "./config.js";
import { makePdfCore } from "./pdf-core.js";
import type { PdfCoreLazyDocument, PdfCoreService } from "./pdf-core.js";

export type PdfCorePromiseRangeSource = {
  readonly size: number;
  readonly read: (offset: number, length: number) => Uint8Array | Promise<Uint8Array>;
};

type PromiseMethods<Service> = {
  readonly [Name in keyof Service]: Service[Name] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, PdfCoreError>
    ? (...args: Args) => Promise<A>
    : never;
};

export type PdfCorePromiseOcrOptions = Omit<PdfCoreOcrOptions, "recognize" | "render"> & {
  readonly recognize: (
    request: PdfCoreOcrRequest,
    signal: AbortSignal,
  ) => Promise<PdfCoreOcrResult>;
  readonly render?: (page: PdfCoreDisplayList, signal: AbortSignal) => Promise<PdfCoreOcrRaster>;
};

export type PdfCorePromiseTextOptions = Omit<PdfCoreTextOptions, "ocr"> & {
  readonly ocr?: PdfCorePromiseOcrOptions;
};
export type PdfCorePromiseTablesOptions = Omit<PdfCoreTablesOptions, "ocr"> & {
  readonly ocr?: PdfCorePromiseOcrOptions;
};

type Extraction = "text" | "textPages" | "tables";

export type PdfCorePromiseDocument = PromiseMethods<
  Omit<PdfCoreLazyDocument, "stats" | Extraction>
> & {
  readonly text: (options?: PdfCorePromiseTextOptions) => Promise<PdfCoreText>;
  readonly textPages: (options?: PdfCorePromiseTextOptions) => Promise<PdfCoreTextPages>;
  readonly tables: (options?: PdfCorePromiseTablesOptions) => Promise<PdfCoreTables>;
  readonly stats: () => Promise<PdfCoreLazyStats>;
  readonly close: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
};

export type PdfCoreClient = PromiseMethods<Omit<PdfCoreService, "openLazy" | Extraction>> & {
  readonly text: (pdf: Uint8Array, options?: PdfCorePromiseTextOptions) => Promise<PdfCoreText>;
  readonly textPages: (
    pdf: Uint8Array,
    options?: PdfCorePromiseTextOptions,
  ) => Promise<PdfCoreTextPages>;
  readonly tables: (
    pdf: Uint8Array,
    options?: PdfCorePromiseTablesOptions,
  ) => Promise<PdfCoreTables>;
  readonly openLazy: (
    source: PdfCorePromiseRangeSource,
    options?: PdfCoreLazyOptions,
  ) => Promise<PdfCorePromiseDocument>;
};
const run = <A>(effect: Effect.Effect<A, PdfCoreError>): Promise<A> =>
  // effect-boundary: promise entry point for apps without Effect [allow-run: rejects with the PdfCoreError]
  Effect.runPromise(effect);

const effectOptions = <Options extends PdfCorePromiseTablesOptions>(
  operation: PdfCoreOperation,
  options?: Options,
): (Omit<Options, "ocr"> & { readonly ocr?: PdfCoreOcrOptions<PdfCoreError> }) | undefined => {
  if (options === undefined) return undefined;
  const { ocr, ...base } = options;
  if (ocr === undefined) return base;
  const { recognize, render, ...policy } = ocr;
  return {
    ...base,
    ocr: {
      ...policy,
      recognize: (request) =>
        Effect.tryPromise({
          try: (signal) => recognize(request, signal),
          catch: () =>
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.ocrFailed,
              operation,
              pageIndex: request.pageIndex,
            }),
        }),
      ...(render === undefined
        ? {}
        : {
            render: (page: PdfCoreDisplayList) =>
              Effect.tryPromise({
                try: (signal) => render(page, signal),
                catch: () =>
                  new PdfCoreError({
                    code: PdfCoreErrorCodeValue.ocrFailed,
                    operation,
                    pageIndex: page.pageIndex,
                    reason: "The OCR page renderer failed.",
                  }),
              }),
          }),
    },
  };
};

const openLazy = (
  core: PdfCoreService,
  source: PdfCorePromiseRangeSource,
  options?: PdfCoreLazyOptions,
) =>
  run(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const document = yield* core
        .openLazy(
          {
            size: source.size,
            read: (offset, length) =>
              Effect.tryPromise({
                try: async () => source.read(offset, length),
                catch: () =>
                  new PdfCoreError({
                    code: PdfCoreErrorCodeValue.rangeReadFailed,
                    operation: PdfCoreOperationValue.readRange,
                    reason: `The PDF source could not read ${length} bytes at offset ${offset}.`,
                  }),
              }),
          },
          options,
        )
        .pipe(
          Scope.provide(scope),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
        );
      const close = () => run(Scope.close(scope, Exit.void));
      return {
        text: (opts?: PdfCorePromiseTextOptions) =>
          run(document.text(effectOptions(PdfCoreOperationValue.text, opts))),
        textPages: (opts?: PdfCorePromiseTextOptions) =>
          run(document.textPages(effectOptions(PdfCoreOperationValue.text, opts))),
        tables: (opts?: PdfCorePromiseTablesOptions) =>
          run(document.tables(effectOptions(PdfCoreOperationValue.tables, opts))),
        pageDiagnostics: (...args: Parameters<PdfCoreLazyDocument["pageDiagnostics"]>) =>
          run(document.pageDiagnostics(...args)),
        pageImages: (...args: Parameters<PdfCoreLazyDocument["pageImages"]>) =>
          run(document.pageImages(...args)),
        renderPages: (...args: Parameters<PdfCoreLazyDocument["renderPages"]>) =>
          run(document.renderPages(...args)),
        stats: () => run(document.stats),
        close,
        [Symbol.asyncDispose]: close,
      };
    }),
  );

const toClient = (core: PdfCoreService): PdfCoreClient => ({
  openLazy: (source, options) => openLazy(core, source, options),
  wasmMemoryBytes: () => run(core.wasmMemoryBytes()),
  pageDiagnostics: (...args) => run(core.pageDiagnostics(...args)),
  pageImages: (...args) => run(core.pageImages(...args)),
  inspect: (...args) => run(core.inspect(...args)),
  text: (pdf, options) => run(core.text(pdf, effectOptions(PdfCoreOperationValue.text, options))),
  textPages: (pdf, options) =>
    run(core.textPages(pdf, effectOptions(PdfCoreOperationValue.text, options))),
  tables: (pdf, options) =>
    run(core.tables(pdf, effectOptions(PdfCoreOperationValue.tables, options))),
  signatures: (...args) => run(core.signatures(...args)),
  revisionComplete: (...args) => run(core.revisionComplete(...args)),
  document: (...args) => run(core.document(...args)),
  edit: (...args) => run(core.edit(...args)),
  merge: (...args) => run(core.merge(...args)),
  deflate: (...args) => run(core.deflate(...args)),
  create: (...args) => run(core.create(...args)),
  fontMetrics: (...args) => run(core.fontMetrics(...args)),
  pngSize: (...args) => run(core.pngSize(...args)),
  renderPages: (...args) => run(core.renderPages(...args)),
});

export const createPdfCoreClient = (module: WebAssembly.Module): Promise<PdfCoreClient> =>
  run(makePdfCore(module).pipe(Effect.map(toClient)));

export const loadPdfCoreBrowser = (): Promise<PdfCoreClient> =>
  run(pdfCoreBrowserModule.pipe(Effect.flatMap(makePdfCore), Effect.map(toClient)));
