import { Effect, Ref, Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Transferable from "effect/workers/Transferable";
import { A1Sessions, Documents, PdfEngine, SharedA1SessionSchema } from "./engine.js";
import { PdfSignatures } from "./pdf-signatures.js";
import { LocalError } from "./rpc.js";
import type { RevisionRef } from "./rpc.js";
import {
  PrepareComputeInputSchema,
  PreparedComputeSchema,
  HelperSignComputeInputSchema,
  makeLocalCompute,
} from "./signature-compute.js";

const DocumentKey = Schema.String.check(Schema.isMinLength(1));

export const SigningHelperRpcs = RpcGroup.make(
  Rpc.make("HelperReady"),
  Rpc.make("HelperAdopt", { payload: SharedA1SessionSchema, error: LocalError }),
  Rpc.make("HelperPrepare", {
    payload: {
      key: DocumentKey,
      bytes: Schema.optional(Transferable.Uint8Array),
      input: PrepareComputeInputSchema,
    },
    success: PreparedComputeSchema,
    error: LocalError,
  }),
  Rpc.make("HelperSign", {
    payload: {
      key: DocumentKey,
      bytes: Schema.optional(Transferable.Uint8Array),
      input: HelperSignComputeInputSchema,
    },
    success: Transferable.Uint8Array,
    error: LocalError,
  }),
  Rpc.make("HelperRelease", { payload: { key: DocumentKey } }),
  Rpc.make("HelperPrewarm", { error: LocalError }),
);

export const signingHelperHandlersLayer = SigningHelperRpcs.toLayer(
  Effect.gen(function* () {
    const documents = yield* Documents;
    const engine = yield* PdfEngine;
    const a1 = yield* A1Sessions;
    const signatures = yield* PdfSignatures;
    const compute = makeLocalCompute(a1);
    const opened = yield* Ref.make(new Map<string, RevisionRef>());
    const preparedUpdates = yield* Ref.make(
      new Map<string, Effect.Success<ReturnType<typeof compute.prepare>>["prepared"]>(),
    );
    const load = Effect.fnUntraced(function* (key: string, bytes: Uint8Array | undefined) {
      const existing = (yield* Ref.get(opened)).get(key);
      if (existing !== undefined) return existing;
      if (bytes === undefined) return yield* new LocalError({ code: "unknownHandle" });
      const revision = yield* documents.open(bytes);
      yield* Ref.update(opened, (current) => new Map(current).set(key, revision));
      return revision;
    });
    const release = Effect.fnUntraced(function* (key: string) {
      yield* Ref.update(preparedUpdates, (current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      const revision = (yield* Ref.get(opened)).get(key);
      if (revision === undefined) return;
      yield* Ref.update(opened, (current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      yield* documents.release(revision.handle).pipe(Effect.ignore);
    });
    return SigningHelperRpcs.of({
      HelperReady: () => Effect.void,
      HelperAdopt: a1.adopt,
      HelperPrepare: ({ key, bytes, input }) =>
        load(key, bytes).pipe(
          Effect.flatMap((revision) =>
            engine.withRevision(revision, (source) =>
              compute
                .prepare({ key, revision: source }, input)
                .pipe(
                  Effect.tap(({ prepared }) =>
                    Ref.update(preparedUpdates, (current) => new Map(current).set(key, prepared)),
                  ),
                ),
            ),
          ),
        ),
      HelperSign: ({ key, bytes, input }) =>
        load(key, bytes).pipe(
          Effect.flatMap((revision) =>
            engine.withRevision(revision, (source) =>
              Effect.gen(function* () {
                const prepared = input.prepared ?? (yield* Ref.get(preparedUpdates)).get(key);
                if (prepared === undefined) return yield* new LocalError({ code: "unknownHandle" });
                return yield* compute.sign({ key, revision: source }, { ...input, prepared });
              }),
            ),
          ),
          Effect.tap(() => release(key)),
        ),
      HelperRelease: ({ key }) => release(key),
      HelperPrewarm: () => signatures.prewarm,
    });
  }),
);
