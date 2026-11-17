import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { pdfCoreLayer } from "@signature-kit/pdf-core/pdf-core";
import { Effect } from "effect";

import {
  CORPUS_FIXTURES_DIRECTORY,
  CORPUS_STAMP_SIZE,
  corpusAnchorMatchers,
  corpusFixtureNames,
} from "../__tests__/text-anchors-corpus.ts";
import { findPdfTextAnchors } from "../src/anchors.ts";
import {
  liteParsePages,
  liteParseTextBoxes,
  makeLiteParseText,
  type LiteParseTextResult,
} from "./liteparse-node.ts";

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const writeGolden = (fixture: string, suffix: string, payload: unknown): void => {
  const stem = fixture.replace(/\.pdf$/u, "");
  writeFileSync(
    join(CORPUS_FIXTURES_DIRECTORY, `${stem}.${suffix}`),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
};

const normalizedGolden = (parsed: LiteParseTextResult) => ({
  pages: parsed.pages.map((page) => ({
    pageNum: page.pageNum,
    ...(page.width === undefined ? {} : { width: round3(page.width) }),
    ...(page.height === undefined ? {} : { height: round3(page.height) }),
    textItems: page.textItems.map((item) => ({
      text: item.text,
      x: round3(item.x),
      y: round3(item.y),
      width: round3(item.width),
      height: round3(item.height),
    })),
  })),
});

const program = Effect.gen(function* () {
  const parseText = yield* makeLiteParseText;
  const failures: Array<{ readonly fixture: string; readonly error: string }> = [];
  for (const fixture of corpusFixtureNames()) {
    const pdf = new Uint8Array(readFileSync(join(CORPUS_FIXTURES_DIRECTORY, fixture)));
    yield* Effect.gen(function* () {
      const parsed = yield* parseText(pdf);
      writeGolden(fixture, "liteparse.json", normalizedGolden(parsed));
      const anchors = yield* findPdfTextAnchors({
        pdf,
        pages: liteParsePages(parsed),
        textBoxes: liteParseTextBoxes(parsed),
        matchers: corpusAnchorMatchers(fixture),
        stampSize: CORPUS_STAMP_SIZE,
        placement: "below",
        offset: 0,
      });
      writeGolden(
        fixture,
        "anchors.json",
        anchors.map((anchor) => ({
          pageIndex: anchor.pageIndex,
          x: round3(anchor.x),
          y: round3(anchor.y),
          width: round3(anchor.width),
          height: round3(anchor.height),
        })),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const failure = { error: String(error) };
          writeGolden(fixture, "liteparse.json", failure);
          writeGolden(fixture, "anchors.json", failure);
          failures.push({ fixture, error: failure.error });
        }),
      ),
    );
  }
  if (failures.length > 0) {
    writeFileSync(
      join(CORPUS_FIXTURES_DIRECTORY, "liteparse-failures.json"),
      `${JSON.stringify(failures, null, 2)}\n`,
    );
  }
});

const pdfCoreModule = await WebAssembly.compile(
  readFileSync(createRequire(import.meta.url).resolve("@signature-kit/pdf-core/pdf-core.wasm")),
);

NodeRuntime.runMain(program.pipe(Effect.provide(pdfCoreLayer(pdfCoreModule))));
