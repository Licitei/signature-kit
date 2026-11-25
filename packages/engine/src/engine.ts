import { CryptoErrorCodeValue } from "@signature-kit/crypto/config";
import { parsePkcs12 } from "@signature-kit/crypto/pkcs12";
import { displayListViewport } from "@signature-kit/pdf-core/canvas";
import type { PdfCoreDisplayList } from "@signature-kit/pdf-core/config";
import { PdfCore, pdfCoreBytesSource } from "@signature-kit/pdf-core/pdf-core";
import {
  Context,
  Effect,
  HashMap,
  Function,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  ScopedCache,
  Semaphore,
} from "effect";
import { A1Hash, a1Profile, importA1SigningKey, sha256Hex } from "./a1-certificate.js";
import { Handle, LocalError } from "./protocol.js";
import type {
  A1OpenInput,
  A1SessionInfo,
  InstanceId,
  PdfInspection,
  PdfRenderInput,
  PdfViewport,
  RevisionRef,
} from "./protocol.js";
import { LocalTelemetry, withQueueTiming } from "./telemetry.js";

export class Documents extends Context.Service<
  Documents,
  {
    readonly open: (bytes: Uint8Array) => Effect.Effect<RevisionRef, LocalError>;
    readonly export: (handle: Handle) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
    readonly release: (handle: Handle) => Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/local/Documents") {}

export class A1Sessions extends Context.Service<
  A1Sessions,
  {
    readonly open: (input: A1OpenInput) => Effect.Effect<A1SessionInfo, LocalError>;
    readonly close: () => Effect.Effect<void, LocalError>;
    readonly sign: (
      sessionId: string,
      generation: number,
      data: Uint8Array,
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
  }
>()("@signature-kit/local/A1Sessions") {}

export const RuntimeOptionsSchema = Schema.Struct({
  a1Hash: Schema.optional(A1Hash),
});
export type RuntimeOptions = (typeof RuntimeOptionsSchema)["Type"];

export class LocalRuntime extends Context.Service<
  LocalRuntime,
  { readonly instanceId: InstanceId }
>()("@signature-kit/local/LocalRuntime") {}

const documentsLayer = (instanceId: InstanceId) =>
  Layer.effect(
    Documents,
    Effect.gen(function* () {
      const telemetry = Option.isSome(yield* Effect.serviceOption(LocalTelemetry));
      const digest: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E> = telemetry
        ? Effect.withSpan("local.crypto.digest", undefined, { captureStackTrace: false })
        : Function.identity;
      const prefix = `${instanceId}/`;
      const documents = yield* Ref.make<
        HashMap.HashMap<Handle, Uint8Array<ArrayBuffer>> | undefined
      >(HashMap.empty());
      yield* Effect.addFinalizer(() => Ref.set(documents, undefined));

      return Documents.of({
        open: Effect.fn(
          function* (bytes) {
            const owned = new Uint8Array(bytes);
            const fingerprint = yield* sha256Hex(owned).pipe(digest);
            const handle = Handle.make(`${prefix}${crypto.randomUUID()}`);
            const stored = yield* Ref.modify(documents, (current) =>
              current === undefined
                ? [false, current]
                : [true, HashMap.set(current, handle, owned)],
            );
            if (!stored) return yield* new LocalError({ code: "runtimeClosed" });
            return { handle, digest: fingerprint, byteLength: owned.byteLength };
          },
          (effect, bytes) =>
            effect.pipe(
              Effect.withSpan("local.documents.open", {
                attributes: { byteLength: bytes.byteLength },
              }),
            ),
        ),
        export: Effect.fn("local.documents.export")(function* (handle) {
          if (!handle.startsWith(prefix)) return yield* new LocalError({ code: "staleHandle" });
          const current = yield* Ref.get(documents);
          if (current === undefined) return yield* new LocalError({ code: "runtimeClosed" });
          const stored = HashMap.get(current, handle);
          if (stored._tag === "None") return yield* new LocalError({ code: "unknownHandle" });
          yield* Effect.annotateCurrentSpan("byteLength", stored.value.byteLength);
          return new Uint8Array(stored.value);
        }),
        release: Effect.fn("local.documents.release")(function* (handle) {
          if (!handle.startsWith(prefix)) return yield* new LocalError({ code: "staleHandle" });
          yield* Ref.update(documents, (current) =>
            current === undefined ? current : HashMap.remove(current, handle),
          );
        }),
      });
    }),
  );

type ActiveSession = {
  readonly id: string;
  readonly key: CryptoKey;
};

type SessionState = {
  readonly generation: number;
  readonly active?: ActiveSession;
};

const parseA1Pkcs12 = (bytes: Uint8Array<ArrayBuffer>, password: Redacted.Redacted<string>) =>
  parsePkcs12(bytes, password).pipe(
    Effect.withTracerEnabled(false),
    Effect.ensuring(Effect.sync(() => bytes.fill(0))),
    Effect.mapError(
      (error) =>
        new LocalError({
          code:
            error.code === CryptoErrorCodeValue.wrongPassword ? "wrongPassword" : "invalidPkcs12",
        }),
    ),
    Effect.tap(({ chain }) => Effect.annotateCurrentSpan("certificateCount", chain.length + 1)),
    Effect.withSpan("local.a1.parsePkcs12"),
  );

const a1SessionsLayer = (hash: A1Hash) =>
  Layer.effect(
    A1Sessions,
    Effect.gen(function* () {
      const telemetry = Option.isSome(yield* Effect.serviceOption(LocalTelemetry));
      const trace = (
        name: "local.crypto.importKey" | "local.crypto.sign",
      ): (<A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>) =>
        telemetry
          ? Effect.withSpan(name, undefined, { captureStackTrace: false })
          : Function.identity;
      const importKey = trace("local.crypto.importKey");
      const sign = trace("local.crypto.sign");
      const state = yield* Ref.make<SessionState | undefined>({ generation: 0 });
      yield* Effect.addFinalizer(() => Ref.set(state, undefined));

      const advance = Ref.updateAndGet(state, (current) =>
        current === undefined ? current : { generation: current.generation + 1 },
      ).pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.fail(new LocalError({ code: "runtimeClosed" }))
            : Effect.succeed(next.generation),
        ),
      );

      const activeSession = Effect.fn(function* (sessionId: string, generation: number) {
        const current = yield* Ref.get(state);
        if (current === undefined) return yield* new LocalError({ code: "runtimeClosed" });
        if (generation !== current.generation)
          return yield* new LocalError({ code: "staleGeneration" });
        if (current.active?.id !== sessionId)
          return yield* new LocalError({ code: "sessionClosed" });
        return current.active;
      });

      return A1Sessions.of({
        open: Effect.fn("local.a1.open")(function* ({ pfx, password }) {
          const generation = yield* advance;
          const owned = new Uint8Array(Redacted.value(pfx));

          const { certificate, privateKey } = yield* parseA1Pkcs12(owned, password);
          const key = yield* importA1SigningKey(privateKey, hash).pipe(
            importKey,
            Effect.ensuring(Effect.sync(() => privateKey.fill(0))),
          );
          const profile = yield* a1Profile(certificate);
          const sessionId = crypto.randomUUID();

          const installed = yield* Ref.modify(state, (current) =>
            current?.generation === generation
              ? [true, { generation, active: { id: sessionId, key } }]
              : [false, current],
          );
          if (!installed) return yield* new LocalError({ code: "staleGeneration" });

          yield* Effect.annotateCurrentSpan("holderKind", profile.holderKind);
          return { sessionId, generation, profile };
        }),
        close: () => advance.pipe(Effect.asVoid, Effect.withSpan("local.a1.close")),
        sign: Effect.fn("local.a1.sign")(function* (sessionId, generation, data) {
          const { key } = yield* activeSession(sessionId, generation);
          const signature = yield* Effect.tryPromise({
            try: () => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new Uint8Array(data)),
            catch: () => new LocalError({ code: "signFailed" }),
          }).pipe(sign);
          yield* activeSession(sessionId, generation);
          return new Uint8Array(signature);
        }),
      });
    }),
  );

export const localRuntimeLayer = (options: RuntimeOptions = {}) =>
  Layer.unwrap(
    Effect.sync(() => {
      const instanceId = crypto.randomUUID();
      return Layer.mergeAll(
        Layer.succeed(LocalRuntime, { instanceId }),
        documentsLayer(instanceId),
        a1SessionsLayer(options.a1Hash ?? "SHA-256"),
      );
    }),
  );

export class PdfEngine extends Context.Service<
  PdfEngine,
  {
    readonly inspect: (handle: Handle) => Effect.Effect<PdfInspection, LocalError>;
    readonly renderPage: (
      input: PdfRenderInput,
    ) => Effect.Effect<
      { readonly list: PdfCoreDisplayList; readonly viewport: PdfViewport },
      LocalError
    >;
  }
>()("@signature-kit/local/PdfEngine") {}

export const pdfEngineLayer = Layer.effectContext(
  Effect.gen(function* () {
    const documents = yield* Documents;
    const core = yield* PdfCore;
    const telemetry = Option.isSome(yield* Effect.serviceOption(LocalTelemetry));
    const lock = withQueueTiming(yield* Semaphore.make(1), telemetry, "local.queue.pdf");
    const cache = yield* ScopedCache.makeWith({
      capacity: Infinity,
      lookup: Effect.fn("local.pdf.open")(function* (handle: Handle) {
        const bytes = yield* documents.export(handle);
        const { pages } = yield* core
          .inspect(bytes, { links: false, text: false })
          .pipe(
            Effect.mapError(
              ({ code }) => new LocalError({ code: "pdfInspectFailed", pdfCode: code }),
            ),
          );
        const pdf = yield* core
          .openLazy(pdfCoreBytesSource(bytes))
          .pipe(
            Effect.mapError(
              ({ code }) => new LocalError({ code: "pdfRenderFailed", pdfCode: code }),
            ),
          );
        return { inspection: { pageCount: pages.length, pages }, pdf };
      }),
    });

    const getDocument = (handle: Handle) =>
      ScopedCache.get(cache, handle).pipe(
        Effect.onError(() => ScopedCache.invalidate(cache, handle)),
      );

    return Context.make(
      PdfEngine,
      PdfEngine.of({
        inspect: (handle) =>
          lock(getDocument(handle)).pipe(
            Effect.map(({ inspection }) => inspection),
            Effect.withSpan("local.pdf.inspect"),
          ),
        renderPage: Effect.fn(
          function* ({ handle, pageIndex, scale, rotation = 0 }) {
            const { pdf, inspection } = yield* getDocument(handle);
            if (inspection.pages[pageIndex] === undefined) {
              return yield* new LocalError({ code: "invalidPageIndex" });
            }
            const [rendered] = yield* pdf
              .renderPages({ pageIndexes: [pageIndex], scale })
              .pipe(
                Effect.mapError(
                  ({ code }) => new LocalError({ code: "pdfRenderFailed", pdfCode: code }),
                ),
              );
            if (rendered === undefined) return yield* Effect.die("The PDF core omitted a page.");

            const list = { ...rendered, rotate: rendered.rotate + rotation };
            return { list, viewport: displayListViewport(list) };
          },
          (effect) => lock(effect).pipe(Effect.withSpan("local.pdf.renderPage")),
        ),
      }),
    ).pipe(
      Context.add(
        Documents,
        Documents.of({
          ...documents,
          release: (handle) =>
            lock(
              documents
                .release(handle)
                .pipe(
                  Effect.andThen(ScopedCache.invalidate(cache, handle)),
                  Effect.uninterruptible,
                ),
            ),
        }),
      ),
    );
  }),
);
