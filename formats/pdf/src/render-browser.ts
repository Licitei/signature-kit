import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { renderDisplayListImage } from "@signature-kit/pdf-core/canvas";
import type { PdfCorePageImage } from "@signature-kit/pdf-core/canvas";
import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type { PdfCoreError } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Transferable from "effect/workers/Transferable";

import {
  DEFAULT_PDF_RENDER_TIMEOUT_MILLIS,
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  PdfPageRenderOptionsSchema,
  PdfPageRendererWorkerOptionsSchema,
  PdfSchemaNameValue,
} from "./config.js";
import type { PdfPageRenderOptions, PdfPageRendererWorkerOptions } from "./config.js";

const RENDER_BATCH_PAGES = 16;
const RENDER_CONCURRENCY = 4;

export type PdfPageImage = PdfCorePageImage;

export class PdfPageRenderer extends Context.Service<
  PdfPageRenderer,
  {
    readonly render: (
      pdf: Uint8Array,
      options?: PdfPageRenderOptions,
    ) => Effect.Effect<ReadonlyArray<PdfPageImage>, PdfError>;
  }
>()("@signature-kit/pdf/PdfPageRenderer") {}

export const renderPdfPagesBrowser = (
  pdf: Uint8Array,
  options: PdfPageRenderOptions = {},
): Effect.Effect<ReadonlyArray<PdfPageImage>, PdfError, PdfPageRenderer> =>
  Effect.gen(function* () {
    const renderer = yield* PdfPageRenderer;
    const images = yield* renderer.render(pdf, options);
    yield* Effect.annotateCurrentSpan("signature_kit.pdf.page_count", images.length);
    return images;
  }).pipe(
    Effect.withSpan(PdfOperationValue.renderPages, {
      attributes: { "signature_kit.pdf.bytes": pdf.byteLength },
    }),
  );

const batches = (pageIndexes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
  const groups: Array<ReadonlyArray<number>> = [];
  for (let start = 0; start < pageIndexes.length; start += RENDER_BATCH_PAGES) {
    groups.push(pageIndexes.slice(start, start + RENDER_BATCH_PAGES));
  }
  return groups;
};

const renderedPageSchema = Schema.Struct({
  pageIndex: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
  type: Schema.String,
  bytes: Transferable.Uint8Array,
});

export const PdfRenderRequests = RpcGroup.make(
  Rpc.make("Pages", {
    payload: Schema.Struct({ pdf: Schema.Uint8Array }),
    success: Schema.Int,
    error: PdfError,
  }),
  Rpc.make("Render", {
    payload: Schema.Struct({ pdf: Schema.Uint8Array, options: PdfPageRenderOptionsSchema }),
    success: Schema.Array(renderedPageSchema),
    error: PdfError,
  }),
);

export const pdfPageRendererLayer: Layer.Layer<PdfPageRenderer, never, PdfCore> = Layer.effect(
  PdfPageRenderer,
  Effect.gen(function* () {
    const core = yield* PdfCore;
    return {
      render: (pdf, rawOptions = {}) =>
        Effect.gen(function* () {
          const options = yield* Schema.decodeUnknownEffect(PdfPageRenderOptionsSchema)(
            rawOptions,
          ).pipe(
            Effect.mapError(
              (issue) =>
                new PdfError({
                  code: PdfErrorCodeValue.invalidPdf,
                  retryable: false,
                  operation: PdfOperationValue.renderPages,
                  schemaName: PdfSchemaNameValue.pdfPageRenderOptions,
                  reason: "Invalid PDF page render options.",
                  issueMessage: String(issue),
                }),
            ),
          );
          const pageIndexes =
            options.pageIndexes ??
            (yield* core
              .inspect(pdf, { text: false, links: false })
              .pipe(Effect.map((inspection) => inspection.pages.map((_, index) => index))));
          const rendered = yield* Effect.forEach(batches(pageIndexes), (batch) =>
            core
              .renderPages(pdf, {
                pageIndexes: batch,
                ...(options.scale === undefined ? {} : { scale: options.scale }),
              })
              .pipe(
                Effect.flatMap((lists) =>
                  Effect.forEach(lists, (list) => renderDisplayListImage(list), {
                    concurrency: RENDER_CONCURRENCY,
                  }),
                ),
              ),
          );
          return rendered.flat();
        }).pipe(
          Effect.catchTag("PdfCoreError", (error: PdfCoreError) =>
            Effect.fail(
              new PdfError({
                code: Match.value(error.code).pipe(
                  Match.when(
                    PdfCoreErrorCodeValue.wasmLoadFailed,
                    () => PdfErrorCodeValue.pdfLoadFailed,
                  ),
                  Match.when(
                    PdfCoreErrorCodeValue.paintFailed,
                    () => PdfErrorCodeValue.pdfLoadFailed,
                  ),
                  Match.when(
                    PdfCoreErrorCodeValue.limitExceeded,
                    () => PdfErrorCodeValue.limitExceeded,
                  ),
                  Match.orElse(() => PdfErrorCodeValue.invalidPdf),
                ),
                retryable: false,
                operation: PdfOperationValue.renderPages,
                reason: error.reason ?? "The PDF pages could not be rendered.",
              }),
            ),
          ),
        ),
    } satisfies PdfPageRenderer["Service"];
  }),
);

export const pdfPageRendererHandlersLayer = PdfRenderRequests.toLayer(
  Effect.gen(function* () {
    const renderer = yield* PdfPageRenderer;
    const core = yield* PdfCore;
    return PdfRenderRequests.of({
      Pages: ({ pdf }) =>
        core.inspect(pdf, { text: false, links: false }).pipe(
          Effect.map((inspection) => inspection.pages.length),
          Effect.catchTag("PdfCoreError", (error: PdfCoreError) =>
            Effect.fail(
              new PdfError({
                code:
                  error.code === PdfCoreErrorCodeValue.limitExceeded
                    ? PdfErrorCodeValue.limitExceeded
                    : PdfErrorCodeValue.invalidPdf,
                retryable: false,
                operation: PdfOperationValue.renderPages,
                reason: error.reason ?? "The PDF pages could not be counted.",
              }),
            ),
          ),
        ),
      Render: ({ pdf, options }) =>
        renderer.render(pdf, options).pipe(
          Effect.flatMap((pages) =>
            Effect.forEach(pages, (page) =>
              Effect.tryPromise({
                try: () => page.image.arrayBuffer(),
                catch: () =>
                  new PdfError({
                    code: PdfErrorCodeValue.pdfLoadFailed,
                    retryable: false,
                    operation: PdfOperationValue.renderPages,
                    reason: "A rendered page image could not be read.",
                  }),
              }).pipe(
                Effect.map((buffer) => ({
                  pageIndex: page.pageIndex,
                  width: page.width,
                  height: page.height,
                  type: page.image.type,
                  bytes: new Uint8Array(buffer),
                })),
              ),
            ),
          ),
        ),
    });
  }),
).pipe(Layer.provide(pdfPageRendererLayer));

type RenderWorker = {
  readonly client: RpcClient.FromGroup<typeof PdfRenderRequests, RpcClientError>;
  readonly scope: Scope.Closeable;
};

const startRenderWorker = (create: () => Worker): Effect.Effect<RenderWorker, PdfError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const worker = yield* Effect.try({
        try: create,
        catch: () =>
          new PdfError({
            code: PdfErrorCodeValue.pdfLoadFailed,
            retryable: false,
            operation: PdfOperationValue.renderPages,
            reason: "PDF render worker failed to start.",
          }),
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => worker.terminate()),
      );
      const client = yield* restore(
        Layer.buildWithScope(
          RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
            Layer.provide(BrowserWorker.layer(() => worker)),
          ),
          scope,
        ).pipe(
          Effect.catchTag("WorkerError", () =>
            Effect.fail(
              new PdfError({
                code: PdfErrorCodeValue.pdfLoadFailed,
                retryable: false,
                operation: PdfOperationValue.renderPages,
                reason: "PDF render worker transport failed to start.",
              }),
            ),
          ),
          Effect.flatMap((context) =>
            RpcClient.make(PdfRenderRequests).pipe(
              Effect.provideContext(context),
              Scope.provide(scope),
            ),
          ),
        ),
      ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      return { client, scope };
    }),
  );

export const pdfPageRendererWorkerLayer = (
  rawOptions: PdfPageRendererWorkerOptions = {},
  create: () => Worker = () =>
    new Worker(new URL("./render.worker.js", import.meta.url), { type: "module" }),
): Layer.Layer<PdfPageRenderer, PdfError> =>
  Layer.effect(
    PdfPageRenderer,
    Effect.gen(function* () {
      const options = yield* Schema.decodeUnknownEffect(PdfPageRendererWorkerOptionsSchema)(
        rawOptions,
      ).pipe(
        Effect.mapError(
          (issue) =>
            new PdfError({
              code: PdfErrorCodeValue.invalidPdf,
              retryable: false,
              operation: PdfOperationValue.renderPages,
              schemaName: PdfSchemaNameValue.pdfPageRendererWorkerOptions,
              reason: "Invalid PDF page renderer worker options.",
              issueMessage: String(issue),
            }),
        ),
      );
      const timeoutMillis = options.timeoutMillis ?? DEFAULT_PDF_RENDER_TIMEOUT_MILLIS;
      const limit = Duration.millis(timeoutMillis);
      const lock = yield* Semaphore.make(1);
      const current = yield* Ref.make(Option.none<RenderWorker>());
      const discard = Ref.getAndSet(current, Option.none()).pipe(
        Effect.flatMap((active) =>
          Option.isSome(active) ? Scope.close(active.value.scope, Exit.void) : Effect.void,
        ),
      );
      yield* Effect.addFinalizer(() => discard);
      const acquire = Ref.get(current).pipe(
        Effect.flatMap((active) =>
          Option.isSome(active)
            ? Effect.succeed(active.value)
            : startRenderWorker(create).pipe(
                Effect.tap((worker) => Ref.set(current, Option.some(worker))),
              ),
        ),
      );
      const request = <A>(
        send: (worker: RenderWorker) => Effect.Effect<A, PdfError | RpcClientError>,
      ): Effect.Effect<A, PdfError> =>
        Semaphore.withPermit(lock)(
          Effect.flatMap(acquire, send).pipe(
            Effect.timeoutOrElse({
              duration: limit,
              orElse: () =>
                discard.pipe(
                  Effect.andThen(
                    Effect.fail(
                      new PdfError({
                        code: PdfErrorCodeValue.renderTimeout,
                        retryable: true,
                        operation: PdfOperationValue.renderPages,
                        reason: `PDF page rendering stopped after ${timeoutMillis} ms.`,
                      }),
                    ),
                  ),
                ),
            }),
            Effect.catchTag("RpcClientError", () =>
              discard.pipe(
                Effect.andThen(
                  Effect.fail(
                    new PdfError({
                      code: PdfErrorCodeValue.pdfLoadFailed,
                      retryable: true,
                      operation: PdfOperationValue.renderPages,
                      reason: "PDF render worker communication failed.",
                    }),
                  ),
                ),
              ),
            ),
            Effect.onInterrupt(() => discard),
          ),
        );
      return {
        render: (pdf, rawRenderOptions = {}) =>
          Effect.gen(function* () {
            const renderOptions = yield* Schema.decodeUnknownEffect(PdfPageRenderOptionsSchema)(
              rawRenderOptions,
            ).pipe(
              Effect.mapError(
                (issue) =>
                  new PdfError({
                    code: PdfErrorCodeValue.invalidPdf,
                    retryable: false,
                    operation: PdfOperationValue.renderPages,
                    schemaName: PdfSchemaNameValue.pdfPageRenderOptions,
                    reason: "Invalid PDF page render options.",
                    issueMessage: String(issue),
                  }),
              ),
            );
            const pageIndexes =
              renderOptions.pageIndexes ??
              Array.from(
                { length: yield* request((worker) => worker.client.Pages({ pdf })) },
                (_, index) => index,
              );
            const rendered = yield* Effect.forEach(batches(pageIndexes), (batch) =>
              request((worker) =>
                worker.client.Render({
                  pdf,
                  options: {
                    pageIndexes: batch,
                    ...(renderOptions.scale === undefined ? {} : { scale: renderOptions.scale }),
                  },
                }),
              ),
            );
            return rendered.flat().map((page) => ({
              pageIndex: page.pageIndex,
              width: page.width,
              height: page.height,
              image: new Blob([page.bytes], { type: page.type }),
            }));
          }),
      } satisfies PdfPageRenderer["Service"];
    }),
  );

export class PdfHandwriting extends Context.Service<
  PdfHandwriting,
  { readonly render: (text: string) => Effect.Effect<Uint8Array, PdfError> }
>()("@signature-kit/pdf/PdfHandwriting") {}

export const pdfHandwritingBrowserLayer = (font: string) =>
  Layer.succeed(PdfHandwriting, {
    render: (text) =>
      Effect.gen(function* () {
        const value = yield* Schema.decodeUnknownEffect(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
        )(text.trim()).pipe(
          Effect.mapError(
            (issue) =>
              new PdfError({
                code: PdfErrorCodeValue.stampFailed,
                retryable: false,
                operation: PdfOperationValue.stamp,
                reason: "Handwritten signature text is invalid.",
                issueMessage: String(issue),
              }),
          ),
        );
        yield* Effect.tryPromise({
          try: () => document.fonts.load(font, value),
          catch: () =>
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: "Handwriting font could not be loaded.",
            }),
        }).pipe(
          Effect.filterOrFail(
            (faces) => faces.length > 0,
            () =>
              new PdfError({
                code: PdfErrorCodeValue.stampFailed,
                retryable: false,
                operation: PdfOperationValue.stamp,
                reason: "Handwriting font is unavailable.",
              }),
          ),
        );
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context === null)
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Handwriting canvas is unavailable.",
          });
        context.font = font;
        const metrics = context.measureText(value);
        canvas.width = Math.ceil(Math.min(4096, Math.max(64, metrics.width + 48)) * 2);
        canvas.height = 200;
        context.scale(2, 2);
        context.font = font;
        context.fillStyle = "#111111";
        context.textBaseline = "middle";
        context.fillText(value, 24, 50, 2000);
        const dataUrl = yield* Effect.try({
          try: () => canvas.toDataURL("image/png"),
          catch: () =>
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: "Handwriting PNG could not be generated.",
            }),
        });
        const prefix = "data:image/png;base64,";
        if (!dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Handwriting canvas returned no PNG data.",
          });
        }
        return yield* Effect.try({
          try: () =>
            Uint8Array.from(atob(dataUrl.slice(prefix.length)), (character) =>
              character.charCodeAt(0),
            ),
          catch: () =>
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: "Handwriting PNG could not be decoded.",
            }),
        });
      }),
  });
