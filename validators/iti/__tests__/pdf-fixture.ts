import type { PdfCoreEditOperations } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect } from "effect";

const encoder = new TextEncoder();

const hexText = (text: string): string =>
  Array.from(text, (character) => (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

export const createTextPdf = (
  text: string,
  options: { readonly objectStreams: boolean } = { objectStreams: false },
): Effect.Effect<Uint8Array, never, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const created = yield* core.create({ pages: [{ width: 300, height: 200 }] });
    const { nextObjectNumber } = yield* core.document(created);
    return yield* core.edit(
      created,
      [
        {
          op: "standardFont",
          ref: { number: nextObjectNumber, generation: 0 },
          baseFont: "Helvetica",
        },
        {
          op: "addResource",
          pageIndex: 0,
          category: "Font",
          name: "F1",
          value: `${nextObjectNumber} 0 R`,
        },
        {
          op: "appendContent",
          pageIndex: 0,
          ref: { number: nextObjectNumber + 1, generation: 0 },
          data: encoder.encode(`BT /F1 12 Tf 24 140 Td <${hexText(text)}> Tj ET`),
          compress: true,
        },
      ],
      { mode: "rewrite", objectStreams: options.objectStreams },
    );
  }).pipe(Effect.orDie);

export const appendIncrementalObjects = (
  pdf: Uint8Array,
  build: (nextObjectNumber: number) => PdfCoreEditOperations,
): Effect.Effect<Uint8Array, never, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const { nextObjectNumber } = yield* core.document(pdf);
    return yield* core.edit(pdf, build(nextObjectNumber), { mode: "incremental" });
  }).pipe(Effect.orDie);
