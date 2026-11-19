import { Effect, Exit, Scope } from "effect";

import { pdfCoreBrowserModule } from "./browser.js";
import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import type { PdfCoreDocumentInfo, PdfCoreLazyOptions, PdfCoreLazyStats } from "./config.js";
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

export type PdfCorePromiseDocument = PromiseMethods<Omit<PdfCoreLazyDocument, "info" | "stats">> & {
  readonly info: () => Promise<PdfCoreDocumentInfo>;
  readonly stats: () => Promise<PdfCoreLazyStats>;
  readonly close: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
};

export type PdfCoreClient = PromiseMethods<Omit<PdfCoreService, "openLazy">> & {
  readonly openLazy: (
    source: PdfCorePromiseRangeSource,
    options?: PdfCoreLazyOptions,
  ) => Promise<PdfCorePromiseDocument>;
};
const run = <A>(effect: Effect.Effect<A, PdfCoreError>): Promise<A> =>
  // effect-boundary: promise entry point for apps without Effect [allow-run: rejects with the PdfCoreError]
  Effect.runPromise(effect);

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
        info: () => run(document.info),
        inspect: (...args: Parameters<PdfCoreLazyDocument["inspect"]>) =>
          run(document.inspect(...args)),
        text: (...args: Parameters<PdfCoreLazyDocument["text"]>) => run(document.text(...args)),
        tables: (...args: Parameters<PdfCoreLazyDocument["tables"]>) =>
          run(document.tables(...args)),
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
  inspect: (...args) => run(core.inspect(...args)),
  info: (...args) => run(core.info(...args)),
  text: (...args) => run(core.text(...args)),
  tables: (...args) => run(core.tables(...args)),
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
