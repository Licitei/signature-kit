import { readdirSync } from "node:fs";
import { join } from "node:path";

export const PDF_CORE_FIXTURES_DIR = join(import.meta.dirname, "fixtures");

export const CORPUS_FIXTURE_NAMES = [
  "helvetica-winansi.pdf",
  "react-pdf-declaration.pdf",
  "rotated-cropped.pdf",
  "links.pdf",
  "habilitacao-150.pdf",
  "object-streams.pdf",
  "incremental-update.pdf",
  "icp-signed.pdf",
  "broken-xref.pdf",
] as const;

export type CorpusFixtureName = (typeof CORPUS_FIXTURE_NAMES)[number];

export const LINK_FIXTURE_URIS = {
  primary: "https://signature-kit.dev/corpus/link-primary",
  secondary: "https://signature-kit.dev/corpus/link-secondary",
  indirect: "https://signature-kit.dev/corpus/link-indirect",
  rotated: "https://signature-kit.dev/corpus/rotated-page-link",
} as const;

export const corpusFixturePath = (name: CorpusFixtureName): string =>
  join(PDF_CORE_FIXTURES_DIR, name);

export const listCommittedCorpusFixtures = (): ReadonlyArray<CorpusFixtureName> => {
  const names = new Set(
    readdirSync(PDF_CORE_FIXTURES_DIR).filter((entry) => entry.endsWith(".pdf")),
  );
  return CORPUS_FIXTURE_NAMES.filter((name) => names.has(name));
};