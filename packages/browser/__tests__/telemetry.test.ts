import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Layer, Option, Tracer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { Documents, localRuntimeLayer } from "@signature-kit/engine/engine";
import { LocalTelemetry } from "@signature-kit/engine/rpc";
import { localTelemetryLayer } from "@signature-kit/engine/telemetry";
import { LocalTelemetryExportError, localTelemetryExportLayer } from "../src/telemetry-otlp.js";

const openSpan = "local.documents.open";

it.effect("exports only allowlisted attributes and strips event data and failure payloads", () =>
  Effect.gen(function* () {
    const telemetry = yield* LocalTelemetry;
    yield* Effect.useSpan(openSpan, (span) =>
      Effect.sync(() => {
        span.attribute("byteLength", 17);
        span.attribute("holderKind", "e-cpf");
        span.attribute("rpc.method", "DocumentsOpen");
        span.attribute("signature_kit.wasm.input_bytes", Infinity);
        span.attribute("holderKind", "111.444.777-35");
        span.attribute("document", new Uint8Array([1, 2, 3]));
        span.attribute("filename", "confidential.pdf");
        span.attribute("cpf", "111.444.777-35");
        span.attribute("subjectName", "Synthetic Person");
        span.attribute("fingerprint", "abcdef");
        span.attribute("pfx", "raw PKCS#12");
        span.attribute("password", "example-password");
        span.event("Synthetic Person", 0n, { password: "example-password" });
      }).pipe(Effect.andThen(Effect.fail("confidential.pdf")), Effect.withParentSpan(span)),
    ).pipe(Effect.ignore);
    yield* Effect.void.pipe(Effect.withSpan("confidential.pdf"));
    const batch = yield* telemetry.drain;
    expect(batch).toMatchObject({
      droppedAttributes: 10,
      droppedSpans: 1,
      spans: [
        {
          name: openSpan,
          outcome: "failure",
          attributes: [
            ["byteLength", 17],
            ["holderKind", "e-cpf"],
            ["rpc.method", "DocumentsOpen"],
          ],
        },
      ],
    });
    for (const secret of [
      "111.444.777-35",
      "confidential.pdf",
      "Synthetic Person",
      "example-password",
    ]) {
      expect(JSON.stringify(batch)).not.toContain(secret);
    }
    expect(yield* telemetry.snapshot).toEqual({
      spans: [],
      bytes: 0,
      droppedAttributes: 0,
      droppedSpans: 0,
    });
  }).pipe(Effect.provide(localTelemetryLayer())),
);

const makeSpan = (byteLength: number) =>
  Effect.void.pipe(Effect.withSpan(openSpan, { attributes: { byteLength } }));

it.effect("evicts the oldest finished spans under both budgets", () =>
  Effect.gen(function* () {
    const telemetry = yield* LocalTelemetry;
    yield* makeSpan(1);
    yield* makeSpan(2);
    yield* makeSpan(3);
    const batch = yield* telemetry.snapshot;
    expect(batch.droppedSpans).toBe(1);
    expect(batch.spans.flatMap((span) => span.attributes)).toEqual([
      ["byteLength", 2],
      ["byteLength", 3],
    ]);

    yield* Effect.gen(function* () {
      const smaller = yield* LocalTelemetry;
      yield* smaller.receive(batch);
      const result = yield* smaller.snapshot;
      expect(result.bytes).toBeLessThanOrEqual(batch.bytes - 1);
      expect(result.droppedSpans).toBe(2);
      expect(result.spans).toEqual(batch.spans.slice(-1));
    }).pipe(Effect.provide(localTelemetryLayer({ maxSpans: 8, maxBytes: batch.bytes - 1 })));
  }).pipe(Effect.provide(localTelemetryLayer({ maxSpans: 2 }))),
);

it.effect("runs the default engine without an installed telemetry tracer or buffer", () =>
  Effect.gen(function* () {
    expect(yield* Effect.tracer).toBe(Tracer.nativeTracer);
    expect(Option.isNone(yield* Effect.serviceOption(LocalTelemetry))).toBe(true);
    const documents = yield* Documents;
    expect((yield* documents.open(new Uint8Array([1, 2, 3]))).byteLength).toBe(3);
  }).pipe(Effect.provide(localRuntimeLayer())),
);

it.effect("keeps engine operations independent of timeouts and classified exporter failures", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const retried = yield* Deferred.make<void>();
    const timeout = Duration.seconds(2);
    const exporter = localTelemetryExportLayer(
      () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.flatMap((first) =>
            first
              ? Effect.never
              : Deferred.succeed(retried, undefined).pipe(
                  Effect.andThen(new LocalTelemetryExportError({ code: "unavailable" })),
                ),
          ),
        ),
      { timeout, interval: Duration.minutes(1) },
    );
    const telemetry = yield* LocalTelemetry;
    yield* makeSpan(1);
    const documents = yield* Documents;
    const operation = documents
      .open(new Uint8Array([1, 2, 3]))
      .pipe(Effect.timeout(Duration.millis(10)));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(exporter);
        yield* Deferred.await(started);
        expect((yield* operation).byteLength).toBe(3);
        expect(yield* Deferred.isDone(retried)).toBe(false);

        yield* TestClock.adjust(Duration.sum(timeout, Duration.millis(250)));
        yield* Deferred.await(retried);
        expect((yield* operation).byteLength).toBe(3);
      }),
    );
    expect((yield* telemetry.snapshot).spans.flatMap((span) => span.attributes)).toContainEqual([
      "byteLength",
      1,
    ]);
  }).pipe(Effect.provide(localRuntimeLayer().pipe(Layer.provideMerge(localTelemetryLayer())))),
);
