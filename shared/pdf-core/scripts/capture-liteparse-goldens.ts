import { Effect } from "effect";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  CORPUS_FIXTURE_NAMES,
  LINK_FIXTURE_URIS,
  PDF_CORE_FIXTURES_DIR,
  type CorpusFixtureName,
} from "../__tests__/corpus.ts";
import {
  ensureLiteParseWasm,
  loadFixtureBytes,
  liteParsePageCount,
  parsePdfWithLiteParse,
} from "./liteparse-node.ts";
import { findPdfTextAnchors } from "../../../formats/pdf/src/anchors.ts";
import { textBoxesFromLiteParseResult } from "../../../formats/pdf/src/stamp.ts";
import type { PdfLiteParseResult } from "../../../formats/pdf/src/config.ts";

type LiteParseGoldenPage = {
  readonly pageNum: number;
  readonly width?: number;
  readonly height?: number;
  readonly textItems: ReadonlyArray<{
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>;
};

type LiteParseGolden = { readonly pages: ReadonlyArray<LiteParseGoldenPage> };
type LiteParseGoldenFailure = { readonly error: string };
type AnchorGolden = ReadonlyArray<{
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}>;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeLiteParse = (parsed: unknown): LiteParseGolden | LiteParseGoldenFailure => {
  if (!isRecord(parsed) || !Array.isArray(parsed.pages)) {
    return { error: "LiteParse returned an unexpected JSON shape." };
  }
  const pages = parsed.pages.flatMap((page): ReadonlyArray<LiteParseGoldenPage> => {
    if (!isRecord(page) || typeof page.pageNum !== "number" || !Array.isArray(page.textItems)) {
      return [];
    }
    const textItems = page.textItems.flatMap((item): LiteParseGoldenPage["textItems"] => {
      if (
        !isRecord(item) ||
        typeof item.text !== "string" ||
        typeof item.x !== "number" ||
        typeof item.y !== "number" ||
        typeof item.width !== "number" ||
        typeof item.height !== "number"
      ) {
        return [];
      }
      return [
        {
          text: item.text,
          x: round3(item.x),
          y: round3(item.y),
          width: round3(item.width),
          height: round3(item.height),
        },
      ];
    });
    return [
      {
        pageNum: page.pageNum,
        ...(typeof page.width === "number" ? { width: round3(page.width) } : {}),
        ...(typeof page.height === "number" ? { height: round3(page.height) } : {}),
        textItems,
      },
    ];
  });
  return { pages };
};

const contentMatchers = [
  { text: "[[licitei-assinatura]]" },
  { text: "{{signature}}" },
  { digits: "12345678909" },
  { digits: "12345678000195" },
] as const;

const linkMatchersFor = (name: CorpusFixtureName) => {
  if (name === "links.pdf") {
    return [
      { link: LINK_FIXTURE_URIS.primary },
      { link: LINK_FIXTURE_URIS.secondary },
      { link: LINK_FIXTURE_URIS.indirect },
    ];
  }
  if (name === "rotated-cropped.pdf") {
    return [{ link: LINK_FIXTURE_URIS.rotated }];
  }
  return [];
};

const captureAnchors = async (
  name: CorpusFixtureName,
  pdf: Uint8Array,
  liteparse: LiteParseGolden,
): Promise<AnchorGolden | LiteParseGoldenFailure> => {
  const textBoxes = textBoxesFromLiteParseResult(liteparse as PdfLiteParseResult);
  const pages = liteparse.pages.map((page) => ({
    index: page.pageNum - 1,
    width: page.width ?? 612,
    height: page.height ?? 792,
  }));
  const matchers = [...contentMatchers, ...linkMatchersFor(name)];
  if (matchers.length === 0) {
    return [];
  }
  const anchors = await Effect.runPromise(
    findPdfTextAnchors({
      pdf,
      pages,
      textBoxes,
      matchers,
      stampSize: { width: 80, height: 20 },
      placement: "below",
      offset: 0,
    }),
  );
  return anchors.map((anchor) => ({
    pageIndex: anchor.pageIndex,
    x: round3(anchor.x),
    y: round3(anchor.y),
    width: round3(anchor.width),
    height: round3(anchor.height),
  }));
};

const writeGolden = (fixtureName: CorpusFixtureName, suffix: string, payload: unknown): void => {
  const stem = basename(fixtureName, ".pdf");
  const target = join(PDF_CORE_FIXTURES_DIR, `${stem}.${suffix}`);
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
};

const captureFixture = async (name: CorpusFixtureName): Promise<{ readonly error?: string }> => {
  const pdf = loadFixtureBytes(join(PDF_CORE_FIXTURES_DIR, name));
  try {
    const pageCount = await liteParsePageCount(pdf);
    const parsed = await parsePdfWithLiteParse(pdf, pageCount);
    const liteparse = normalizeLiteParse(parsed);
    writeGolden(name, "liteparse.json", liteparse);
    if ("error" in liteparse) {
      writeGolden(name, "anchors.json", liteparse);
      return { error: liteparse.error };
    }
    const anchors = await captureAnchors(name, pdf, liteparse);
    writeGolden(name, "anchors.json", anchors);
    return {};
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const failure = { error: message };
    writeGolden(name, "liteparse.json", failure);
    writeGolden(name, "anchors.json", failure);
    return { error: message };
  }
};

await ensureLiteParseWasm();

const failures: Array<{ readonly fixture: CorpusFixtureName; readonly error: string }> = [];
for (const fixture of CORPUS_FIXTURE_NAMES) {
  const result = await captureFixture(fixture);
  if (result.error !== undefined) {
    failures.push({ fixture, error: result.error });
  }
}

if (failures.length > 0) {
  const logPath = join(PDF_CORE_FIXTURES_DIR, "liteparse-failures.json");
  writeFileSync(logPath, `${JSON.stringify(failures, null, 2)}\n`);
}