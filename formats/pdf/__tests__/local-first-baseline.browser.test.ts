import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { parseCertificate } from "@signature-kit/certificates";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { signPdf } from "@signature-kit/pdf/sign";
import { verifyPdf } from "@signature-kit/pdf/verify";
import { preparePdfVisualPreview } from "@signature-kit/pdf/workflow";
import { Effect, Redacted, Result, Schema, Tracer } from "effect";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { readA1FixtureFromBrowser } from "../../../tooling/testing/fixtures.browser";
import { createFixturePdf } from "./pdf-fixtures";

const pages = [1, 20, 200];
const warmups = 3;
const iterations = 21;
const parseSpan = "certificates.parseCertificate";
const prepareSpan = "pdf.workflow.prepare-preview";
const stampSpan = "pdf.stamp.visible";
const coldSignSpan = "localFirst.pdf.signWithA1";
const signSpan = "pdf.sign";
const verifySpan = "pdf.verify";
const operations = new Set([parseSpan, prepareSpan, stampSpan, coldSignSpan, signSpan, verifySpan]);
const numericAttributes = new Set([
  "signature_kit.pkcs12.bytes",
  "signature_kit.certificate_count",
  "signature_kit.pdf.bytes",
  "signature_kit.pdf.output_bytes",
  "signature_kit.pdf.stamp_count",
  "signature_kit.pdf.signature_count",
  "signature_kit.pdf.valid_signatures",
]);

class BaselineSpan extends Tracer.NativeSpan {
  override attribute(key: string, value: unknown): void {
    if (numericAttributes.has(key) && typeof value === "number" && Number.isFinite(value)) {
      super.attribute(key, value);
    }
  }

  override event(): void {}
}

const collect = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new BaselineSpan(options);
        if (operations.has(span.name)) spans.push(span);
        return span;
      },
    });
    return operation.pipe(
      Effect.withTracer(tracer),
      Effect.map(() =>
        spans.flatMap(({ name, status, attributes }) =>
          status._tag === "Ended"
            ? [
                {
                  name,
                  milliseconds: Number(status.endTime - status.startTime) / 1e6,
                  attributes: Object.fromEntries(attributes),
                },
              ]
            : [],
        ),
      ),
    );
  });

const measure = <A, E, R>(operation: Effect.Effect<A, E, R>, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Effect.repeat(operation, { times: warmups - 1 });
    const runs = yield* Effect.forEach(Array.from({ length: iterations }), () =>
      collect(operation),
    );
    return names.map((name) => {
      const spans = runs.flatMap((run) => {
        const matching = run.filter((span) => span.name === name);
        expect(matching).toHaveLength(1);
        return matching;
      });
      const samplesMs = spans.map((span) => span.milliseconds);
      const sorted = [...samplesMs].sort((left, right) => left - right);
      expect(sorted[0]).toBeGreaterThanOrEqual(0);
      return {
        name,
        medianMs: sorted[(iterations - 1) / 2],
        p95Ms: sorted[Math.ceil(iterations * 0.95) - 1],
        samplesMs,
        attributes: spans[0]?.attributes,
      };
    });
  });

const UserAgentMemory = Schema.Struct({ bytes: Schema.Finite });
const ChromiumHeap = Schema.Struct({ usedJSHeapSize: Schema.Finite });

const memory = Effect.gen(function* () {
  if (
    crossOriginIsolated &&
    "measureUserAgentSpecificMemory" in performance &&
    typeof performance.measureUserAgentSpecificMemory === "function"
  ) {
    const measure = performance.measureUserAgentSpecificMemory.bind(performance);
    const result: unknown = yield* Effect.promise(() => measure());
    const { bytes } = yield* Schema.decodeUnknownEffect(UserAgentMemory)(result);
    return { source: "measureUserAgentSpecificMemory", bytes };
  }
  if ("memory" in performance) {
    const result = yield* Effect.result(
      Schema.decodeUnknownEffect(ChromiumHeap)(performance.memory),
    );
    if (Result.isSuccess(result)) {
      return { source: "performance.memory.usedJSHeapSize", bytes: result.success.usedJSHeapSize };
    }
  }
  return { source: "unavailable", bytes: null };
});

it("records the Chromium local signing baseline from Effect spans", async () => {
  const measurements = await Effect.runPromise(
    Effect.gen(function* () {
      const before = yield* memory;
      const password = Redacted.make("changeit");
      const a1 = { pfx: yield* readA1FixtureFromBrowser("ecpf"), password };
      const companyPfx = yield* readA1FixtureFromBrowser("ecnpj");
      const pkcs12 = {
        ecpf: yield* measure(parseCertificate(a1.pfx, password), [parseSpan]),
        ecnpj: yield* measure(parseCertificate(companyPfx, password), [parseSpan]),
      };
      const corpus = yield* Effect.forEach(pages, (pageCount) =>
        Effect.gen(function* () {
          const pdf = yield* createFixturePdf(
            Array.from({ length: pageCount }, (_, page) => ({
              text: [{ x: 32, y: 118, size: 14, text: `Synthetic contract | Page ${page + 1}` }],
            })),
          );
          const work = Effect.gen(function* () {
            const stamped = yield* preparePdfVisualPreview({
              pdf,
              stampRects: [{ pageIndex: 0, x: 32, y: 28, width: 216, height: 44 }],
              lines: ["Signed locally"],
              signing: {},
            });
            expect(stamped.byteLength).toBeGreaterThan(pdf.byteLength);
            const signed = yield* signPdf({
              pdf: stamped,
              signatureLength: 16384,
            }).pipe(Effect.provide(a1SignaturesLayer(a1)), Effect.withSpan(coldSignSpan));
            const verified = yield* verifyPdf({ pdf: signed });
            expect(verified.valid).toBe(true);
            expect(verified.signatureCount).toBe(1);
          });
          const timings = yield* measure(work, [
            prepareSpan,
            stampSpan,
            coldSignSpan,
            signSpan,
            verifySpan,
          ]);
          return { pageCount, inputBytes: pdf.byteLength, timings };
        }),
      );
      return { warmups, iterations, memory: { before, after: yield* memory }, pkcs12, corpus };
    }).pipe(Effect.provide(pdfCoreBrowserLayer)),
  );
  const path = await commands.writeLocalFirstBaseline(measurements);
  console.info(`Chromium local-first baseline: ${path}`);
}, 90_000);
