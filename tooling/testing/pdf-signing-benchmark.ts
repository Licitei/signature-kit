import { Effect } from "effect";
import type { A1SessionBinding, PdfPrepareOptions } from "@signature-kit/engine/rpc";
import type { PdfCoreEditOperation } from "@signature-kit/engine/wasm/config";
import type { PdfCoreService } from "@signature-kit/engine/wasm/pdf-core";

const encoder = new TextEncoder();
const syntheticPdf = (core: PdfCoreService, pages: number) =>
  Effect.gen(function* () {
    const pdf = yield* core.create({
      pages: [
        { width: 320, height: 180 },
        ...Array.from({ length: pages - 1 }, () => ({ width: 320, height: 180 })),
      ],
    });
    const { nextObjectNumber } = yield* core.document(pdf);
    const font = { number: nextObjectNumber, generation: 0 };
    const operations: PdfCoreEditOperation[] = [
      { op: "repairCatalog" },
      { op: "standardFont", ref: font, baseFont: "Helvetica" },
    ];
    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      const text = encoder.encode(`Synthetic contract | Page ${pageIndex + 1}`);
      operations.push(
        { op: "addResource", pageIndex, category: "Font", name: "F1", value: `${font.number} 0 R` },
        {
          op: "appendContent",
          pageIndex,
          ref: { number: nextObjectNumber + pageIndex + 1, generation: 0 },
          data: encoder.encode(`BT /F1 14 Tf 32 118 Td <${text.toHex().toUpperCase()}> Tj ET`),
          compress: true,
        },
      );
    }
    return yield* core.edit(pdf, operations, { mode: "rewrite" });
  });

const largePdf = (core: PdfCoreService) =>
  Effect.gen(function* () {
    const pdf = yield* syntheticPdf(core, 20);
    const { nextObjectNumber } = yield* core.document(pdf);
    return yield* core.edit(
      pdf,
      [
        {
          op: "appendContent",
          pageIndex: 19,
          ref: { number: nextObjectNumber, generation: 0 },
          data: new Uint8Array(21 * 1024 * 1024).fill(32),
          compress: false,
        },
      ],
      { mode: "incremental" },
    );
  });

export const signingCorpus = (core: PdfCoreService) => [
  { name: "synthetic-1", pdf: syntheticPdf(core, 1) },
  { name: "synthetic-20", pdf: syntheticPdf(core, 20) },
  { name: "synthetic-200", pdf: syntheticPdf(core, 200) },
  { name: "synthetic-21mib", pdf: largePdf(core) },
];

export const signingOptions = (session: A1SessionBinding): PdfPrepareOptions => ({
  session,
  field: { kind: "create", name: "Approval", page: 0, rect: [32, 28, 248, 72] },
  appearance: { kind: "visible", lines: ["Signed locally"] },
  policy: "cades",
});

export const medianSigningTime = <E, R>(sample: Effect.Effect<number, E, R>) =>
  Effect.gen(function* () {
    const coldMs = yield* sample;
    for (let i = 0; i < 2; i += 1) yield* sample;
    const samples = yield* Effect.forEach(Array.from({ length: 7 }), () => sample);
    const medianMs = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    return { coldMs, medianMs };
  });
