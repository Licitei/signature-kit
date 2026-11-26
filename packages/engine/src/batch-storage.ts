import { Context, Schema } from "effect";
import type { Effect, Scope } from "effect";
import { BatchDocument, BatchItem, BatchTemplate, Sha256 } from "./rpc.js";
import type { LocalError } from "./rpc.js";

export const BatchPlan = Schema.Struct({
  version: Schema.Literal(1),
  template: BatchTemplate,
  documents: Schema.Array(
    Schema.Struct({
      itemId: BatchItem.fields.itemId,
      digest: Sha256,
      anchors: BatchDocument.fields.anchors,
    }),
  ),
});
export type BatchPlan = typeof BatchPlan.Type;

export const StoredBatchItem = Schema.Struct({
  version: Schema.Literal(1),
  ...BatchItem.mapFields(({ preparation: _preparation, ...fields }) => fields).fields,
  outputDigest: Schema.optional(Sha256),
});
export type StoredBatchItem = typeof StoredBatchItem.Type;

export class BatchStorage extends Context.Service<
  BatchStorage,
  {
    readonly lock: (id: string) => Effect.Effect<void, LocalError, Scope.Scope>;
    readonly readPlan: (id: string) => Effect.Effect<BatchPlan | undefined, LocalError>;
    readonly writePlan: (id: string, plan: BatchPlan) => Effect.Effect<void, LocalError>;
    readonly readItem: (
      id: string,
      itemId: string,
    ) => Effect.Effect<StoredBatchItem | undefined, LocalError>;
    readonly writeItem: (id: string, item: StoredBatchItem) => Effect.Effect<void, LocalError>;
    readonly readOutput: (
      id: string,
      itemId: string,
    ) => Effect.Effect<Uint8Array | undefined, LocalError>;
    readonly writeOutput: (
      id: string,
      itemId: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, LocalError>;
    readonly delete: (id: string) => Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/engine/BatchStorage") {}
