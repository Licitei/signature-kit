import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

export const PDF_CORE_FIXTURES_DIR = join(import.meta.dirname, "fixtures");

export const CorpusFixtureNameSchema = Schema.Literals([
  "helvetica-winansi.pdf",
  "react-pdf-declaration.pdf",
  "takumi-declaration.pdf",
  "rotated-cropped.pdf",
  "links.pdf",
  "habilitacao-150.pdf",
  "object-streams.pdf",
  "incremental-update.pdf",
  "icp-signed.pdf",
  "broken-xref.pdf",
]);

export const CORPUS_FIXTURE_NAMES = CorpusFixtureNameSchema.literals;

export type CorpusFixtureName = (typeof CorpusFixtureNameSchema)["Type"];

export const LINK_FIXTURE_URIS = {
  primary: "https://signature-kit.dev/corpus/link-primary",
  secondary: "https://signature-kit.dev/corpus/link-secondary",
  indirect: "https://signature-kit.dev/corpus/link-indirect",
  rotated: "https://signature-kit.dev/corpus/rotated-page-link",
};

export const corpusFixturePath = (name: CorpusFixtureName): string =>
  join(PDF_CORE_FIXTURES_DIR, name);

export const listCommittedCorpusFixtures = (): ReadonlyArray<CorpusFixtureName> => {
  const names = new Set(
    readdirSync(PDF_CORE_FIXTURES_DIR).filter((entry) => entry.endsWith(".pdf")),
  );
  return CORPUS_FIXTURE_NAMES.filter((name) => names.has(name));
};
