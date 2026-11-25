import { Resource } from "@effect/opentelemetry";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { HrTime } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Cause, Duration, Effect, Layer, Match, Option, Schedule, Schema } from "effect";
import { LocalClient } from "./client.js";
import { LocalTelemetry, TelemetryBatch } from "./telemetry.js";
import type { TelemetrySpan } from "./telemetry.js";

export class LocalTelemetryExportError extends Schema.TaggedError<
  LocalTelemetryExportError,
  { readonly brand: unique symbol }
>()("LocalTelemetryExportError", {
  code: Schema.Literals(["timeout", "unavailable", "rejected"]),
}) {}

const ExportDuration = Schema.Duration.check(
  Schema.makeFilter(
    (value) =>
      Duration.isFinite(value) && Duration.isGreaterThanOrEqualTo(value, Duration.millis(1)),
  ),
);
const ExportOptionsSchema = Schema.Struct({
  interval: Schema.optional(ExportDuration),
  timeout: Schema.optional(ExportDuration),
});
type ExportOptions = (typeof ExportOptionsSchema)["Type"];

export const localTelemetryExportLayer = (
  exportBatch: (
    spans: ReadonlyArray<TelemetrySpan>,
  ) => Effect.Effect<void, LocalTelemetryExportError>,
  options: ExportOptions = {},
  collect: Effect.Effect<void> = Effect.void,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const telemetry = yield* LocalTelemetry;
      const { interval = Duration.seconds(5), timeout = Duration.seconds(2) } =
        yield* Schema.decodeUnknownEffect(ExportOptionsSchema)(options).pipe(Effect.orDie);
      const flush = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const batch = yield* telemetry.drain;
          if (batch.spans.length === 0 && batch.droppedAttributes === 0 && batch.droppedSpans === 0)
            return;

          yield* restore(
            Schema.decodeUnknownEffect(TelemetryBatch, { onExcessProperty: "error" })(batch).pipe(
              Effect.mapError(() => new LocalTelemetryExportError({ code: "rejected" })),
              Effect.flatMap(({ spans }) =>
                spans.length === 0 ? Effect.void : exportBatch(spans),
              ),
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () => new LocalTelemetryExportError({ code: "timeout" }),
              }),
              Effect.retry({
                schedule: Schedule.min([Schedule.spaced(Duration.millis(250)), Schedule.recurs(1)]),
                while: ({ code }) => code === "timeout" || code === "unavailable",
              }),
            ),
          ).pipe(
            Effect.onError((cause) => {
              const error = Option.getOrUndefined(Cause.findErrorOption(cause));
              return telemetry.restore(
                error?.code === "rejected"
                  ? {
                      ...batch,
                      spans: [],
                      bytes: 0,
                      droppedSpans: batch.droppedSpans + batch.spans.length,
                    }
                  : batch,
              );
            }),
          );
        }),
      );

      yield* collect.pipe(
        Effect.timeout(timeout),
        Effect.ignore,
        Effect.andThen(flush),
        Effect.ignore,
        Effect.repeat(Schedule.spaced(interval)),
        Effect.forkScoped,
      );
    }),
  );

const hrTime = (nanos: bigint): HrTime => {
  const second = 1_000_000_000n;
  return [Number(nanos / second), Number(nanos % second)];
};

const toKind = Match.type<TelemetrySpan["kind"]>().pipe(
  Match.when("internal", () => SpanKind.INTERNAL),
  Match.when("client", () => SpanKind.CLIENT),
  Match.when("server", () => SpanKind.SERVER),
  Match.when("producer", () => SpanKind.PRODUCER),
  Match.when("consumer", () => SpanKind.CONSUMER),
  Match.exhaustive,
);

const OtlpFailure = Schema.Struct({ code: Schema.optional(Schema.Int) });
const decodeFailure = Schema.decodeUnknownOption(OtlpFailure);

export const localTelemetryOtlpLayer = (url: string, options: ExportOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const resource = yield* Resource.Resource;
      const client = yield* LocalClient;
      const { timeout = Duration.seconds(2) } = yield* Schema.decodeUnknownEffect(
        ExportOptionsSchema,
      )(options).pipe(Effect.orDie);
      const exporter = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new OTLPTraceExporter({
              url,
              timeoutMillis: Duration.toMillis(timeout),
              concurrencyLimit: 1,
            }),
        ),
        (exporter) =>
          Effect.promise(() => exporter.shutdown()).pipe(
            Effect.interruptible,
            Effect.timeout(timeout),
            Effect.ignore,
          ),
      );
      return localTelemetryExportLayer(
        (spans) =>
          Effect.callback<void, LocalTelemetryExportError>((resume) => {
            exporter.export(
              spans.map((span) => {
                const start = BigInt(span.startTime);
                const end = BigInt(span.endTime);
                return {
                  name: span.name,
                  kind: toKind(span.kind),
                  spanContext: () => ({
                    traceId: span.traceId,
                    spanId: span.spanId,
                    traceFlags: TraceFlags.SAMPLED,
                  }),
                  ...(span.parentSpanId === undefined
                    ? {}
                    : {
                        parentSpanContext: {
                          traceId: span.traceId,
                          spanId: span.parentSpanId,
                          traceFlags: TraceFlags.SAMPLED,
                        },
                      }),
                  startTime: hrTime(start),
                  endTime: hrTime(end),
                  duration: hrTime(end >= start ? end - start : 0n),
                  status: {
                    code: span.outcome === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
                  },
                  attributes: Object.fromEntries(span.attributes),
                  links: [],
                  events: [],
                  ended: true,
                  resource,
                  instrumentationScope: { name: "@signature-kit/local" },
                  droppedAttributesCount: span.droppedAttributes,
                  droppedEventsCount: 0,
                  droppedLinksCount: 0,
                };
              }),
              (result) => {
                if (result.code === 0) {
                  resume(Effect.void);
                  return;
                }
                const code = Option.getOrUndefined(decodeFailure(result.error))?.code;
                resume(
                  new LocalTelemetryExportError({
                    code:
                      code === undefined ||
                      code === 0 ||
                      code === 408 ||
                      code === 429 ||
                      code === 502 ||
                      code === 503 ||
                      code === 504
                        ? "unavailable"
                        : "rejected",
                  }),
                );
              },
            );
          }),
        options,
        client.collectTelemetry().pipe(Effect.ignore),
      );
    }),
  ).pipe(Layer.provide(Resource.layer({ serviceName: "signature-kit.local" })));
