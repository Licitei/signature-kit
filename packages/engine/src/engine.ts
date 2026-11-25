import { makeDetachedSigner } from "./cms/detached.js";
import { CryptoErrorCodeValue } from "./crypto/config.js";
import { parsePkcs12 } from "./crypto/pkcs12.js";
import { sha256Prefix } from "./crypto/primitives/sha256.js";
import { displayListViewport } from "./wasm/canvas.js";
import type { PdfCoreDisplayList, PdfCoreSignatureFields } from "./wasm/config.js";
import { PdfCore, pdfCoreBytesSource } from "./wasm/pdf-core.js";
import type { PdfCoreSigningSession } from "./wasm/pdf-core.js";
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
  Scope,
  ScopedCache,
  Semaphore,
} from "effect";
import { A1Hash, a1Profile, importA1SigningKey } from "./a1-certificate.js";
import { LocalTelemetry, Handle, LocalError } from "./rpc.js";
import type {
  A1OpenInput,
  A1Profile,
  A1SessionBinding,
  A1SessionInfo,
  InstanceId,
  PdfInspection,
  PdfRenderInput,
  PdfViewport,
  RevisionRef,
} from "./rpc.js";
import { withQueueTiming } from "./telemetry.js";

const cmsHash = {
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
} satisfies Record<A1Hash, "sha256" | "sha384" | "sha512">;

type DetachedSigner = Effect.Success<ReturnType<typeof makeDetachedSigner>>;
const storeRevision = Symbol();
const loadRevision = Symbol();
type RevisionBytes = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly digest: string;
  readonly prefix: ReturnType<typeof sha256Prefix>;
};

export class Documents extends Context.Service<
  Documents,
  {
    readonly open: (bytes: Uint8Array) => Effect.Effect<RevisionRef, LocalError>;
    readonly [storeRevision]: (
      bytes: Uint8Array<ArrayBuffer>,
      prefix: RevisionBytes["prefix"],
    ) => Effect.Effect<RevisionRef, LocalError>;
    readonly [loadRevision]: (handle: Handle) => Effect.Effect<RevisionBytes, LocalError>;
    readonly read: (revision: RevisionRef) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
    readonly validate: (revision: RevisionRef) => Effect.Effect<void, LocalError>;
    readonly export: (handle: Handle) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
    readonly release: (handle: Handle) => Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/engine/Documents") {}

export class A1Sessions extends Context.Service<
  A1Sessions,
  {
    readonly open: (input: A1OpenInput) => Effect.Effect<A1SessionInfo, LocalError>;
    readonly close: () => Effect.Effect<void, LocalError>;
    readonly validate: (session: A1SessionBinding) => Effect.Effect<void, LocalError>;
    readonly certificate: (
      session: A1SessionBinding,
    ) => Effect.Effect<SessionCertificate, LocalError>;
    readonly sign: (
      sessionId: string,
      generation: number,
      data: Uint8Array,
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
  }
>()("@signature-kit/engine/A1Sessions") {}

export const RuntimeOptionsSchema = Schema.Struct({
  a1Hash: Schema.optional(A1Hash),
});
export type RuntimeOptions = (typeof RuntimeOptionsSchema)["Type"];

export class LocalRuntime extends Context.Service<
  LocalRuntime,
  { readonly instanceId: InstanceId }
>()("@signature-kit/engine/LocalRuntime") {}

const documentsLayer = (instanceId: InstanceId) =>
  Layer.effect(
    Documents,
    Effect.gen(function* () {
      const telemetry = Option.isSome(yield* Effect.serviceOption(LocalTelemetry));
      const digest: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E> = telemetry
        ? Effect.withSpan("local.crypto.digestPrefix", undefined, { captureStackTrace: false })
        : Function.identity;
      const prefix = `${instanceId}/`;
      const documents = yield* Ref.make<HashMap.HashMap<Handle, RevisionBytes> | undefined>(
        HashMap.empty(),
      );
      yield* Effect.addFinalizer(() => Ref.set(documents, undefined));

      const load = Effect.fnUntraced(function* (handle: Handle) {
        if (!handle.startsWith(prefix)) return yield* new LocalError({ code: "staleHandle" });
        const current = yield* Ref.get(documents);
        if (current === undefined) return yield* new LocalError({ code: "runtimeClosed" });
        const stored = HashMap.get(current, handle);
        if (stored._tag === "None") return yield* new LocalError({ code: "unknownHandle" });
        return stored.value;
      });

      const store = Effect.fnUntraced(function* (
        owned: Uint8Array<ArrayBuffer>,
        checkpoint: RevisionBytes["prefix"],
      ) {
        const digest = Array.from(checkpoint.digest(), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const handle = Handle.make(`${prefix}${crypto.randomUUID()}`);
        const stored = yield* Ref.modify(documents, (current) =>
          current === undefined
            ? [false, current]
            : [true, HashMap.set(current, handle, { digest, bytes: owned, prefix: checkpoint })],
        );
        if (!stored) return yield* new LocalError({ code: "runtimeClosed" });
        return { handle, digest, byteLength: owned.byteLength };
      });

      const readRevision = Effect.fnUntraced(function* (revision: RevisionRef) {
        const { digest, bytes } = yield* load(revision.handle);
        if (revision.digest !== digest || revision.byteLength !== bytes.byteLength) {
          return yield* new LocalError({ code: "preparationStale" });
        }
        return bytes;
      });

      return Documents.of({
        [storeRevision]: store,
        [loadRevision]: load,
        open: Effect.fn(
          function* (bytes) {
            const owned = new Uint8Array(bytes);
            const checkpoint = yield* Effect.sync(() => sha256Prefix(owned)).pipe(digest);
            return yield* store(owned, checkpoint);
          },
          (effect, bytes) =>
            effect.pipe(
              Effect.withSpan("local.documents.open", {
                attributes: { byteLength: bytes.byteLength },
              }),
            ),
        ),
        read: (revision) =>
          readRevision(revision).pipe(Effect.map((bytes) => new Uint8Array(bytes))),
        validate: (revision) => readRevision(revision).pipe(Effect.asVoid),
        export: Effect.fn("local.documents.export")(function* (handle) {
          const { bytes } = yield* load(handle);
          yield* Effect.annotateCurrentSpan("byteLength", bytes.byteLength);
          return new Uint8Array(bytes);
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

type SessionCertificate = {
  readonly certificateDer: Uint8Array;
  readonly chainDer: readonly Uint8Array[];
  readonly profile: A1Profile;
  readonly signatureBytes: number;
  readonly cms: Effect.Effect<DetachedSigner, LocalError>;
  readonly hash: A1Hash;
};

type ActiveSession = SessionCertificate & {
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

          const { certificate, chain, privateKey } = yield* parseA1Pkcs12(owned, password);
          const key = yield* importA1SigningKey(privateKey, hash).pipe(
            importKey,
            Effect.ensuring(Effect.sync(() => privateKey.fill(0))),
          );
          const profile = yield* a1Profile(certificate);
          const sessionId = crypto.randomUUID();
          const { algorithm } = key;
          if (!("modulusLength" in algorithm) || typeof algorithm.modulusLength !== "number") {
            return yield* new LocalError({ code: "keyImportFailed" });
          }
          const cms = yield* Effect.cached(
            makeDetachedSigner({
              certificateDer: certificate,
              chainDer: chain,
              hashAlgorithm: cmsHash[hash],
            }).pipe(Effect.mapError(() => new LocalError({ code: "signFailed" }))),
          );
          const active = {
            id: sessionId,
            cms,
            key,
            hash,
            profile: {
              ...profile,
              notBefore: new Date(profile.notBefore),
              notAfter: new Date(profile.notAfter),
            },
            certificateDer: certificate,
            chainDer: chain,
            signatureBytes: Math.ceil(algorithm.modulusLength / 8),
          };

          const installed = yield* Ref.modify(state, (current) =>
            current?.generation === generation ? [true, { generation, active }] : [false, current],
          );
          if (!installed) return yield* new LocalError({ code: "staleGeneration" });

          yield* Effect.annotateCurrentSpan("holderKind", profile.holderKind);
          return { sessionId, generation, profile };
        }),
        close: () => advance.pipe(Effect.asVoid, Effect.withSpan("local.a1.close")),
        validate: ({ sessionId, generation }) =>
          activeSession(sessionId, generation).pipe(Effect.asVoid),
        certificate: Effect.fn(function* ({ sessionId, generation }) {
          const { certificateDer, chainDer, profile, signatureBytes, hash, cms } =
            yield* activeSession(sessionId, generation);
          return {
            certificateDer: new Uint8Array(certificateDer),
            chainDer: chainDer.map((der) => new Uint8Array(der)),
            profile: {
              ...profile,
              notBefore: new Date(profile.notBefore),
              notAfter: new Date(profile.notAfter),
            },
            signatureBytes,
            hash,
            cms,
          };
        }),
        sign: Effect.fn("local.a1.sign")(function* (sessionId, generation, data) {
          yield* Effect.annotateCurrentSpan("byteLength", data.byteLength);
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

type PdfRevision = {
  readonly byteLength: number;
  readonly digest: (
    hash: A1Hash,
    before: Uint8Array,
    after: Uint8Array,
  ) => Effect.Effect<Uint8Array, LocalError>;
  readonly fields: Effect.Effect<PdfCoreSignatureFields, LocalError>;
  readonly signing: Effect.Effect<PdfCoreSigningSession, LocalError>;
  readonly append: (
    appendix: Uint8Array,
    validate?: (document: PdfCoreSigningSession) => Effect.Effect<void, LocalError>,
  ) => Effect.Effect<RevisionRef, LocalError>;
};

export class PdfEngine extends Context.Service<
  PdfEngine,
  {
    readonly withRevision: <A, E, R>(
      revision: RevisionRef,
      use: (revision: PdfRevision) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | LocalError, R>;
    readonly inspect: (handle: Handle) => Effect.Effect<PdfInspection, LocalError>;
    readonly renderPage: (
      input: PdfRenderInput,
    ) => Effect.Effect<
      { readonly list: PdfCoreDisplayList; readonly viewport: PdfViewport },
      LocalError
    >;
  }
>()("@signature-kit/engine/PdfEngine") {}

export const pdfEngineLayer = Layer.effectContext(
  Effect.gen(function* () {
    const documents = yield* Documents;
    const core = yield* PdfCore;
    const telemetry = Option.isSome(yield* Effect.serviceOption(LocalTelemetry));
    const lock = withQueueTiming(yield* Semaphore.make(1), telemetry, "local.queue.pdf");
    const cache = yield* ScopedCache.makeWith({
      capacity: Infinity,
      lookup: Effect.fn("local.pdf.open")(function* (handle: Handle) {
        const { bytes, prefix } = yield* documents[loadRevision](handle);
        const scope = yield* Effect.scope;
        const view = yield* Effect.cached(
          Effect.gen(function* () {
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
          }).pipe(Scope.provide(scope)),
        );
        const signing = yield* Effect.cached(
          core.openSigningDocument(bytes).pipe(
            Scope.provide(scope),
            Effect.mapError(({ code }) => new LocalError({ code: "pdfReadFailed", pdfCode: code })),
          ),
        );
        const fields = yield* Effect.cached(
          signing.pipe(
            Effect.flatMap(({ fields }) =>
              fields.pipe(Effect.mapError(() => new LocalError({ code: "pdfReadFailed" }))),
            ),
          ),
        );
        const digest: PdfRevision["digest"] = Effect.fn("local.crypto.digest")(
          function* (hash, before, after) {
            if (hash === "SHA-256") return prefix.digest([before, after]);
            return yield* Effect.tryPromise({
              try: () => {
                const content = new Uint8Array(bytes.length + before.length + after.length);
                content.set(bytes);
                content.set(before, bytes.length);
                content.set(after, bytes.length + before.length);
                return crypto.subtle.digest(hash, content);
              },
              catch: () => new LocalError({ code: "digestFailed" }),
            }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));
          },
        );
        const append: PdfRevision["append"] = Effect.fnUntraced(function* (appendix, validate) {
          const result = new Uint8Array(bytes.length + appendix.length);
          result.set(bytes);
          result.set(appendix, bytes.length);
          if (validate !== undefined) {
            yield* core.openSigningDocument(result).pipe(
              Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })),
              Effect.flatMap(validate),
              Effect.scoped,
            );
          }
          return yield* documents[storeRevision](result, prefix.append(appendix));
        });

        return { byteLength: bytes.length, view, signing, fields, digest, append };
      }),
    });

    const getDocument = (handle: Handle) =>
      ScopedCache.get(cache, handle).pipe(
        Effect.onError(() => ScopedCache.invalidate(cache, handle)),
      );

    const getView = (handle: Handle) =>
      getDocument(handle).pipe(
        Effect.flatMap(({ view }) => view),
        Effect.onError(() => ScopedCache.invalidate(cache, handle)),
      );

    return Context.make(
      PdfEngine,
      PdfEngine.of({
        withRevision: (revision, use) =>
          lock(
            documents.validate(revision).pipe(Effect.andThen(getDocument(revision.handle))),
          ).pipe(Effect.flatMap(use)),
        inspect: (handle) =>
          lock(getView(handle)).pipe(
            Effect.map(({ inspection }) => inspection),
            Effect.withSpan("local.pdf.inspect"),
          ),
        renderPage: Effect.fn(
          function* ({ handle, pageIndex, scale, rotation = 0 }) {
            const { pdf, inspection } = yield* getView(handle);
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
