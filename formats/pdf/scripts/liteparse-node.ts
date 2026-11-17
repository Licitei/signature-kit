import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PDFDocument } from "@cantoo/pdf-lib";
import initLiteParseWasm, { LiteParse } from "@llamaindex/liteparse-wasm";
import { Effect, Schema } from "effect";

import type { PdfSignaturePage, PdfTextBox } from "../src/config.ts";

export const LiteParseTextResultSchema = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      pageNum: Schema.Int,
      width: Schema.optional(Schema.Finite),
      height: Schema.optional(Schema.Finite),
      textItems: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          x: Schema.Finite,
          y: Schema.Finite,
          width: Schema.Finite,
          height: Schema.Finite,
        }),
      ),
    }),
  ),
});
export type LiteParseTextResult = (typeof LiteParseTextResultSchema)["Type"];

const liteParseWasmBytes = (): Uint8Array =>
  new Uint8Array(
    readFileSync(
      createRequire(import.meta.url).resolve("@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm"),
    ),
  );

export const makeLiteParseText = Effect.gen(function* () {
  yield* Effect.tryPromise(() => initLiteParseWasm({ module_or_path: liteParseWasmBytes() }));
  return (pdf: Uint8Array) =>
    Effect.gen(function* () {
      const document = yield* Effect.tryPromise(() =>
        PDFDocument.load(pdf, { ignoreEncryption: true }),
      );
      const parsed = yield* Effect.scoped(
        Effect.gen(function* () {
          const parser = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new LiteParse({
                  ocrEnabled: false,
                  maxPages: document.getPageCount(),
                  outputFormat: "json",
                  preserveVerySmallText: true,
                  quiet: true,
                }),
            ),
            (current) => Effect.sync(() => current.free()),
          );
          return yield* Effect.tryPromise(() => parser.parse(pdf));
        }),
      );
      return yield* Schema.decodeUnknownEffect(LiteParseTextResultSchema)(parsed);
    });
});

export const liteParseTextBoxes = (
  parsed: LiteParseTextResult,
): ReadonlyArray<ReadonlyArray<PdfTextBox>> =>
  [...parsed.pages]
    .sort((left, right) => left.pageNum - right.pageNum)
    .map((page) =>
      page.textItems.flatMap((item) =>
        item.text.trim().length === 0
          ? []
          : [{ x: item.x, y: item.y, width: item.width, height: item.height, text: item.text }],
      ),
    );

export const liteParsePages = (parsed: LiteParseTextResult): ReadonlyArray<PdfSignaturePage> =>
  [...parsed.pages]
    .sort((left, right) => left.pageNum - right.pageNum)
    .map((page) => ({
      index: page.pageNum - 1,
      width: page.width ?? 612,
      height: page.height ?? 792,
    }));
