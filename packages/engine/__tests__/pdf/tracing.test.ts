import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { PdfCoreOperationValue } from "../../dist/wasm/config.js";
import { makePdfCore, pdfCoreBytesSource } from "../../dist/wasm/pdf-core.js";
import { childSpans, recordSpans, spanNamed } from "../../../../tooling/testing/tracing.ts";
import { PDF_CORE_FIXTURES_DIR } from "./corpus.ts";

const wasm = readFileSync(new URL("../../dist/wasm/signature-kit.wasm", import.meta.url));
const pdf = new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, "habilitacao-150.pdf")));
const compile = Effect.promise(() => WebAssembly.compile(wasm));

describe("PdfCore tracing", () => {
  it.effect("records load, public operation, and per-phase spans for Markdown", () =>
    Effect.gen(function* () {
      const module = yield* compile;
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const core = yield* makePdfCore(module);
          return yield* core.text(pdf, { format: "markdown" });
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const pages = Exit.isSuccess(exit) ? exit.value : [];

      const load = spanNamed(spans, PdfCoreOperationValue.load);
      expect(load?.attributes["signature_kit.wasm.memory_bytes"]).toBeGreaterThan(0);
      expect(childSpans(spans, load).map((span) => span.name)).toContain(
        "pdfCore.wasm.instantiate",
      );

      const text = spanNamed(spans, PdfCoreOperationValue.text);
      expect(text?.attributes).toMatchObject({
        "signature_kit.pdf.bytes": pdf.byteLength,
        "signature_kit.pdf.output_format": "markdown",
        "signature_kit.pdf.page_count": pages.length,
        "signature_kit.pdf.merge_across_pages": false,
      });
      const phases = childSpans(spans, text).map((span) => span.name);
      expect(phases).toEqual(["pdfCore.wasm.copyIn", "pdfCore.wasm.run", "pdfCore.wasm.decode"]);
      expect(spanNamed(spans, "pdfCore.wasm.copyIn")?.attributes).toMatchObject({
        "signature_kit.wasm.input_bytes": pdf.byteLength,
      });
      expect(spanNamed(spans, "pdfCore.wasm.run")?.attributes).toMatchObject({
        "signature_kit.pdf_core.operation": PdfCoreOperationValue.text,
      });

      const words = new Set(
        pages
          .join(" ")
          .split(/\s+/)
          .filter((word) => word.length >= 6),
      );
      for (const span of spans) {
        for (const value of Object.values(span.attributes)) {
          if (typeof value === "string" && span.name !== "pdfCore.wasm.decode") {
            expect(words.has(value)).toBe(false);
          }
        }
      }
    }),
  );

  it.effect("records the failure on the operation span", () =>
    Effect.gen(function* () {
      const module = yield* compile;
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const core = yield* makePdfCore(module);
          return yield* core.text(new TextEncoder().encode("not a pdf"));
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const text = spanNamed(spans, PdfCoreOperationValue.text);
      expect(text?.status.code).toBe(2);
      expect(text?.events.some((event) => event.name === "exception")).toBe(true);
    }),
  );

  it.effect("records lazy planning and range rounds", () =>
    Effect.gen(function* () {
      const module = yield* compile;
      const { exit, spans } = yield* recordSpans(
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makePdfCore(module);
            const document = yield* core.openLazy(pdfCoreBytesSource(pdf));
            return yield* document.text({ pageIndexes: [0], format: "markdown" });
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(spanNamed(spans, PdfCoreOperationValue.openLazy)?.attributes).toMatchObject({
        "signature_kit.pdf.bytes": pdf.byteLength,
      });
      const text = spanNamed(spans, PdfCoreOperationValue.text);
      expect(text?.attributes).toMatchObject({
        "signature_kit.pdf.lazy": true,
        "signature_kit.pdf.requested_pages": 1,
        "signature_kit.pdf.page_count": 1,
      });
      expect(text?.attributes["signature_kit.pdf.lazy_rounds"]).toBeGreaterThan(0);
      const children = childSpans(spans, text).map((span) => span.name);
      expect(children).toContain("pdfCore.lazy.plan");
      expect(children).toContain("pdfCore.lazy.supply");
      expect(children).toContain("pdfCore.wasm.decode");
    }),
  );

  it.effect("keeps results identical without a registered tracer", () =>
    Effect.gen(function* () {
      const module = yield* compile;
      const core = yield* makePdfCore(module);
      const untraced = yield* core.text(pdf, { format: "markdown" });
      const { exit } = yield* recordSpans(core.text(pdf, { format: "markdown" }));
      expect(exit).toStrictEqual(Exit.succeed(untraced));
    }),
  );
});
