import { Effect, Layer, Option, Schema } from "effect";
import type { KeyValueStoreError } from "effect/persistence/KeyValueStore";
import { KeyValueStore, toSchemaStore } from "effect/persistence/KeyValueStore";
import { BatchPlan, BatchStorage, StoredBatchItem } from "@signature-kit/engine/batch-storage";
import { LocalError } from "@signature-kit/engine/rpc";

export const batchDatabase = "signature-kit-batches";
const prefix = (id: string) => `batch/${id}/`;
const itemKey = (id: string, itemId: string) => `${prefix(id)}item/${itemId}`;
const outputKey = (id: string, itemId: string) => `${prefix(id)}output/${itemId}`;
const QuotaExceeded = Schema.Struct({ name: Schema.Literal("QuotaExceededError") });
const isQuotaExceeded = Schema.is(QuotaExceeded);

const storageCode = (cause: KeyValueStoreError) =>
  isQuotaExceeded(cause.cause) ? "batchStorageQuota" : "batchStorageFailed";

export const indexedDbBatchStorageLayer = Layer.effect(
  BatchStorage,
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const plans = toSchemaStore(kv, BatchPlan);
    const items = toSchemaStore(kv, StoredBatchItem);
    return BatchStorage.of({
      lock: (id) =>
        Effect.acquireRelease(
          Effect.callback<() => Promise<void>, LocalError>((resume) => {
            const hold = Promise.withResolvers<void>();
            const lease = navigator.locks
              .request(`${batchDatabase}/${id}`, { ifAvailable: true }, (lock) => {
                if (lock === null) {
                  resume(Effect.fail(new LocalError({ code: "batchLocked" })));
                  return;
                }
                resume(
                  Effect.succeed(() => {
                    hold.resolve(undefined);
                    return lease;
                  }),
                );
                return hold.promise;
              })
              .catch(() => resume(Effect.fail(new LocalError({ code: "batchStorageFailed" }))));
          }),
          (unlock) => Effect.promise(unlock),
        ).pipe(Effect.asVoid),
      readPlan: (id) =>
        plans.get(`${prefix(id)}plan`).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new LocalError({
                code: cause._tag === "SchemaError" ? "batchStorageCorrupt" : storageCode(cause),
              }),
          ),
        ),
      writePlan: (id, plan) =>
        plans.set(`${prefix(id)}plan`, plan).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                code: cause._tag === "SchemaError" ? "batchStorageCorrupt" : storageCode(cause),
              }),
          ),
        ),
      readItem: (id, itemId) =>
        items.get(itemKey(id, itemId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new LocalError({
                code: cause._tag === "SchemaError" ? "batchStorageCorrupt" : storageCode(cause),
              }),
          ),
        ),
      writeItem: (id, item) =>
        items.set(itemKey(id, item.itemId), item).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                code: cause._tag === "SchemaError" ? "batchStorageCorrupt" : storageCode(cause),
              }),
          ),
        ),
      readOutput: (id, itemId) =>
        kv
          .getUint8Array(outputKey(id, itemId))
          .pipe(Effect.mapError((cause) => new LocalError({ code: storageCode(cause) }))),
      writeOutput: (id, itemId, bytes) =>
        kv
          .set(outputKey(id, itemId), bytes)
          .pipe(Effect.mapError((cause) => new LocalError({ code: storageCode(cause) }))),
      delete: (id) =>
        kv
          .clearPrefix(prefix(id))
          .pipe(Effect.mapError((cause) => new LocalError({ code: storageCode(cause) }))),
    });
  }),
);
