import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PdfTextAnchorMatcher } from "../src/config";

export const CORPUS_FIXTURES_DIRECTORY = fileURLToPath(
  new URL("../../../shared/pdf-core/__tests__/fixtures/", import.meta.url),
);

export const CORPUS_LINK_URIS = {
  primary: "https://signature-kit.dev/corpus/link-primary",
  secondary: "https://signature-kit.dev/corpus/link-secondary",
  indirect: "https://signature-kit.dev/corpus/link-indirect",
  rotated: "https://signature-kit.dev/corpus/rotated-page-link",
};

export const CORPUS_STAMP_SIZE = { width: 80, height: 20 };

const contentMatchers: ReadonlyArray<PdfTextAnchorMatcher> = [
  { text: "[[licitei-assinatura]]" },
  { text: "{{signature}}" },
  { digits: "12345678909" },
  { digits: "12345678000195" },
];

export const corpusFixtureNames = (): ReadonlyArray<string> =>
  readdirSync(CORPUS_FIXTURES_DIRECTORY)
    .filter((entry) => entry.endsWith(".pdf") && !entry.startsWith("markdown-"))
    .sort();

export const corpusAnchorMatchers = (fixture: string): ReadonlyArray<PdfTextAnchorMatcher> => {
  if (fixture === "links.pdf") {
    return [
      ...contentMatchers,
      { link: CORPUS_LINK_URIS.primary },
      { link: CORPUS_LINK_URIS.secondary },
      { link: CORPUS_LINK_URIS.indirect },
    ];
  }
  if (fixture === "rotated-cropped.pdf") {
    return [...contentMatchers, { link: CORPUS_LINK_URIS.rotated }];
  }
  return contentMatchers;
};
