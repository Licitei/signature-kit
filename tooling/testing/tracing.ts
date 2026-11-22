import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Effect } from "effect";
import type { Exit } from "effect";

export type RecordedSpans<A, E> = {
  readonly exit: Exit.Exit<A, E>;
  readonly spans: ReadonlyArray<ReadableSpan>;
};

export const recordSpans = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<RecordedSpans<A, E>, never, R> =>
  Effect.suspend(() => {
    const exporter = new InMemorySpanExporter();
    return effect.pipe(
      Effect.exit,
      Effect.map((exit) => ({ exit, spans: exporter.getFinishedSpans() })),
      Effect.provide(
        NodeSdk.layer(() => ({
          resource: { serviceName: "signature-kit-test" },
          spanProcessor: new SimpleSpanProcessor(exporter),
        })),
      ),
    );
  });

export const spanNamed = (
  spans: ReadonlyArray<ReadableSpan>,
  name: string,
): ReadableSpan | undefined => spans.find((span) => span.name === name);

export const childSpans = (
  spans: ReadonlyArray<ReadableSpan>,
  parent: ReadableSpan | undefined,
): ReadonlyArray<ReadableSpan> =>
  parent === undefined
    ? []
    : spans.filter((span) => span.parentSpanContext?.spanId === parent.spanContext().spanId);
