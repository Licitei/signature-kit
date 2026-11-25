import { PdfCoreOperationSchema } from "@signature-kit/pdf-core/config";
import { Clock, Context, Effect, Exit, Layer, Option, Schema, Tracer } from "effect";
import type { Semaphore } from "effect";

const RpcMethod = Schema.Literals([
  "Hello",
  "DocumentsOpen",
  "DocumentsExport",
  "DocumentsRelease",
  "PdfInspect",
  "PdfRenderPage",
  "A1Open",
  "A1Close",
]);
const SpanName = Schema.Union([
  Schema.TemplateLiteral([Schema.Literals(["local.client.", "local.worker."]), RpcMethod]),
  PdfCoreOperationSchema,
  Schema.Literals([
    "local.hello",
    "local.documents.open",
    "local.documents.export",
    "local.documents.release",
    "local.pdf.open",
    "local.pdf.inspect",
    "local.pdf.renderPage",
    "local.viewer.paintPage",
    "local.queue.pdf",
    "local.queue.raster",
    "local.a1.open",
    "local.a1.close",
    "local.a1.sign",
    "local.a1.parsePkcs12",
    "local.crypto.digest",
    "local.crypto.importKey",
    "local.crypto.sign",
    "pdfCore.wasm.instantiate",
    "pdfCore.wasm.run",
    "pdfCore.wasm.decode",
    "pdfCore.wasm.copyIn",
    "pdfCore.lazy.supply",
    "pdfCore.lazy.plan",
  ]),
]);
const Attribute = Schema.Union([
  Schema.Tuple([
    Schema.Literals([
      "byteLength",
      "certificateCount",
      "signature_kit.wasm.input_bytes",
      "signature_kit.wasm.output_bytes",
      "signature_kit.wasm.result_bytes",
      "signature_kit.wasm.memory_bytes",
      "signature_kit.pdf.requested_pages",
    ]),
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ]),
  Schema.Tuple([Schema.Literal("holderKind"), Schema.Literals(["e-cpf", "e-cnpj", "other"])]),
  Schema.Tuple([Schema.Literal("rpc.system.name"), Schema.Literal("effect_rpc")]),
  Schema.Tuple([Schema.Literal("rpc.method"), RpcMethod]),
  Schema.Tuple([Schema.Literal("signature_kit.pdf_core.operation"), PdfCoreOperationSchema]),
]);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SpanId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/));
const Nanoseconds = Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/));
const Outcome = Schema.Literals(["success", "failure", "interrupted"]);
const TelemetrySpan = Schema.Struct({
  name: SpanName,
  traceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  spanId: SpanId,
  parentSpanId: Schema.optional(SpanId),
  kind: Schema.Literals(["internal", "server", "client", "producer", "consumer"]),
  startTime: Nanoseconds,
  endTime: Nanoseconds,
  outcome: Outcome,
  attributes: Schema.Array(Attribute).check(Schema.isMaxLength(32)),
  droppedAttributes: Count,
});
export type TelemetrySpan = (typeof TelemetrySpan)["Type"];

const MAX_SPANS = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
export const TelemetryBatch = Schema.Struct({
  spans: Schema.Array(TelemetrySpan).check(Schema.isMaxLength(MAX_SPANS)),
  bytes: Count,
  droppedSpans: Count,
  droppedAttributes: Count,
});
export type TelemetryBatch = (typeof TelemetryBatch)["Type"];

export const TelemetryOptionsSchema = Schema.Struct({
  maxSpans: Schema.optional(Count.check(Schema.isLessThanOrEqualTo(MAX_SPANS))),
  maxBytes: Schema.optional(Count.check(Schema.isLessThanOrEqualTo(MAX_BYTES))),
});
export type TelemetryOptions = (typeof TelemetryOptionsSchema)["Type"];

export class LocalTelemetry extends Context.Service<
  LocalTelemetry,
  {
    readonly snapshot: Effect.Effect<TelemetryBatch>;
    readonly drain: Effect.Effect<TelemetryBatch>;
    readonly receive: (batch: TelemetryBatch) => Effect.Effect<void>;
    readonly restore: (batch: TelemetryBatch) => Effect.Effect<void>;
  }
>()("@signature-kit/local/LocalTelemetry") {}

const isAttribute = Schema.is(Attribute);
const isSpan = Schema.is(TelemetrySpan);

class BufferedSpan extends Tracer.NativeSpan {
  private droppedAttributes = 0;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    private readonly record: (span: unknown, droppedAttributes: number) => void,
  ) {
    super(options);
  }

  override attribute(key: string, value: unknown) {
    if (isAttribute([key, value])) super.attribute(key, value);
    else this.droppedAttributes += 1;
  }

  override event(_name: string, _start: bigint, attributes?: Record<string, unknown>) {
    if (attributes !== undefined) this.droppedAttributes += Object.keys(attributes).length;
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === "Ended") return;
    super.end(endTime, Exit.void);
    if (!this.sampled || this.name === "local.worker.TelemetryDrain") return;
    const attributes = [...this.attributes].filter(isAttribute);
    const dropped = this.droppedAttributes + this.attributes.size - attributes.length;
    this.record(
      {
        name: this.name,
        traceId: this.traceId,
        spanId: this.spanId,
        parentSpanId: Option.getOrUndefined(this.parent)?.spanId,
        kind: this.kind,
        startTime: String(this.startTime),
        endTime: String(endTime),
        outcome: Exit.isSuccess(exit)
          ? "success"
          : Exit.hasInterrupts(exit)
            ? "interrupted"
            : "failure",
        attributes,
        droppedAttributes: dropped,
      },
      dropped,
    );
  }
}

type Entry = { readonly span: TelemetrySpan; readonly bytes: number };

export const localTelemetryLayer = (options: TelemetryOptions = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { maxSpans = 512, maxBytes = 256 * 1024 } = yield* Schema.decodeUnknownEffect(
        TelemetryOptionsSchema,
      )(options).pipe(Effect.orDie);
      const entries = Array.from<Entry | undefined>({ length: maxSpans });
      let head = 0;
      let size = 0;
      let bytes = 0;
      let droppedSpans = 0;
      let droppedAttributes = 0;

      const push = (span: TelemetrySpan) => {
        const cost = JSON.stringify(span).length;
        if (maxSpans === 0 || cost > maxBytes) {
          droppedSpans += 1;
          return;
        }
        while (size === maxSpans || bytes + cost > maxBytes) {
          bytes -= entries[head]?.bytes ?? 0;
          entries[head] = undefined;
          head = (head + 1) % maxSpans;
          size -= 1;
          droppedSpans += 1;
        }
        entries[(head + size) % maxSpans] = { span, bytes: cost };
        size += 1;
        bytes += cost;
      };
      const spans = () =>
        Array.from({ length: size }, (_, index) => entries[(head + index) % maxSpans]).flatMap(
          (entry) => (entry === undefined ? [] : [entry.span]),
        );
      const snapshot = (records: ReadonlyArray<TelemetrySpan>) => ({
        spans: records,
        bytes,
        droppedSpans,
        droppedAttributes,
      });
      const clear = () => {
        entries.fill(undefined);
        head = 0;
        size = 0;
        bytes = 0;
      };
      const decodeBatch = Schema.decodeUnknownOption(TelemetryBatch, { onExcessProperty: "error" });
      const receive = (value: TelemetryBatch) => {
        const result = decodeBatch(value);
        if (Option.isNone(result)) return;
        const batch = result.value;
        droppedSpans += batch.droppedSpans;
        droppedAttributes += batch.droppedAttributes;
        batch.spans.forEach(push);
      };

      return Context.make(
        LocalTelemetry,
        LocalTelemetry.of({
          snapshot: Effect.sync(() => snapshot(structuredClone(spans()))),
          drain: Effect.sync(() => {
            const batch = snapshot(spans());
            clear();
            droppedSpans = 0;
            droppedAttributes = 0;
            return batch;
          }),
          receive: (batch) => Effect.sync(() => receive(batch)),
          restore: (batch) =>
            Effect.sync(() => {
              const newer = spans();
              clear();
              receive(batch);
              newer.forEach(push);
            }),
        }),
      ).pipe(
        Context.add(
          Tracer.Tracer,
          Tracer.make({
            span: (options) =>
              new BufferedSpan(options, (span, dropped) => {
                droppedAttributes += dropped;
                if (isSpan(span)) push(span);
                else droppedSpans += 1;
              }),
          }),
        ),
      );
    }),
  );

export const withQueueTiming = (
  semaphore: Semaphore.Semaphore,
  enabled: boolean,
  name: "local.queue.pdf" | "local.queue.raster",
) => {
  const acquire = semaphore.withPermits(1);
  if (!enabled) return acquire;
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.useSpan(name, (span) =>
      acquire(
        Clock.currentTimeNanos.pipe(
          Effect.tap((time) => Effect.sync(() => span.end(time, Exit.void))),
          Effect.andThen(effect),
        ),
      ),
    );
};

const isRpcMethod = Schema.is(RpcMethod);

export const summarizeTelemetry = (spans: ReadonlyArray<TelemetrySpan>) => {
  const byId = new Map(spans.map((span) => [`${span.traceId}/${span.spanId}`, span]));
  const methods = new Map(
    RpcMethod.literals.map((method) => [
      method,
      {
        success: 0,
        failure: 0,
        interrupted: 0,
        rpcWaitMs: 0,
        workerMs: 0,
        matchedRoundTrips: 0,
        queueWaitMs: 0,
        wasmMs: 0,
        cryptoMs: 0,
        bytesToWasm: 0,
        bytesFromWasm: 0,
      },
    ]),
  );
  const parentOf = (span: TelemetrySpan) => byId.get(`${span.traceId}/${span.parentSpanId}`);
  const duration = (span: TelemetrySpan) =>
    Math.max(0, Number(BigInt(span.endTime) - BigInt(span.startTime)) / 1_000_000);
  const workerFor = (span: TelemetrySpan) => {
    let current: TelemetrySpan | undefined = span;
    for (let hops = 0; current !== undefined && hops < byId.size; hops += 1) {
      if (current.kind === "server" && current.name.startsWith("local.worker.")) return current;
      current = parentOf(current);
    }
    return undefined;
  };
  for (const span of spans) {
    const worker = workerFor(span);
    if (worker === undefined) continue;
    const method = worker.name.slice("local.worker.".length);
    if (!isRpcMethod(method)) continue;
    const metric = methods.get(method);
    if (metric === undefined) continue;

    const elapsed = duration(span);
    if (span === worker) {
      metric.workerMs += elapsed;
      metric[span.outcome] += 1;
      const client = parentOf(span);
      if (client?.name === `local.client.${method}`) {
        metric.matchedRoundTrips += 1;
        metric.rpcWaitMs += Math.max(0, duration(client) - elapsed);
      }
    }
    if (span.name.startsWith("local.queue.")) metric.queueWaitMs += elapsed;
    if (span.name === "pdfCore.wasm.run") metric.wasmMs += elapsed;
    if (span.name.startsWith("local.crypto.") || span.name === "local.a1.parsePkcs12") {
      metric.cryptoMs += elapsed;
    }

    for (const [key, value] of span.attributes) {
      if (key === "signature_kit.wasm.input_bytes") metric.bytesToWasm += value;
      if (key === "signature_kit.wasm.output_bytes") metric.bytesFromWasm += value;
    }
  }
  return new Map(
    Array.from(methods, ([method, metric]) => [
      method,
      { ...metric, executionMs: Math.max(0, metric.workerMs - metric.queueWaitMs) },
    ]),
  );
};
