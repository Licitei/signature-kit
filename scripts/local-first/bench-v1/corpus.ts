import { createFixturePdf, editFixturePdf } from "../../../formats/pdf/__tests__/pdf-fixtures";
import { Effect } from "effect";

export const syntheticPdf = (pages: number) =>
  createFixturePdf(
    Array.from({ length: pages }, (_, page) => ({
      text: [{ x: 32, y: 118, size: 14, text: `Synthetic contract | Page ${page + 1}` }],
    })),
  );

export const largePdf = syntheticPdf(20).pipe(
  Effect.flatMap((pdf) => {
    const padding = new Uint8Array(21 * 1024 * 1024).fill(32);
    return editFixturePdf(
      pdf,
      ({ next }) => [
        {
          op: "appendContent",
          pageIndex: 19,
          ref: next(),
          data: padding,
          compress: false,
        },
      ],
      { incremental: true },
    );
  }),
);

export const tablePdf = createFixturePdf([
  {
    size: [400, 300],
    text: [
      { x: 55, y: 148, size: 10, text: "Item" },
      { x: 205, y: 148, size: 10, text: "Value" },
      { x: 55, y: 128, size: 10, text: "A" },
      { x: 205, y: 128, size: 10, text: "12" },
      { x: 55, y: 108, size: 10, text: "B" },
      { x: 205, y: 108, size: 10, text: "8" },
    ],
  },
]).pipe(
  Effect.flatMap((pdf) =>
    editFixturePdf(pdf, ({ next }) => [
      {
        op: "appendContent",
        pageIndex: 0,
        ref: next(),
        compress: true,
        data: new TextEncoder().encode(
          [
            "0.5 w",
            ...[100, 120, 140, 160].map((y) => `50 ${y} m 350 ${y} l S`),
            ...[50, 200, 350].map((x) => `${x} 100 m ${x} 160 l S`),
          ].join("\n"),
        ),
      },
    ]),
  ),
);

export const pdfFixtures = {
  "real-habilitacao-150": "shared/pdf-core/__tests__/fixtures/habilitacao-150.pdf",
  "real-helvetica-winansi": "shared/pdf-core/__tests__/fixtures/helvetica-winansi.pdf",
  "real-broken-xref": "shared/pdf-core/__tests__/fixtures/broken-xref.pdf",
  "real-encrypted-signed": "shared/pdf-core/__tests__/fixtures/encryption/signed.pdf",
  "real-encrypted-locked": "formats/pdf/__tests__/fixtures/encrypted.pdf",
};
