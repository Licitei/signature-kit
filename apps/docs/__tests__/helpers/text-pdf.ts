import type { PdfCoreEditOperation, PdfCoreEditTarget } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect } from "effect";

export type TextRun = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  readonly bold?: boolean;
  readonly color?: readonly [number, number, number];
};

export type TextPage = {
  readonly width: number;
  readonly height: number;
  readonly runs?: ReadonlyArray<TextRun>;
  readonly fills?: ReadonlyArray<{
    readonly box: readonly [number, number, number, number];
    readonly color: readonly [number, number, number];
  }>;
  readonly rotate?: number;
  readonly cropBox?: readonly [number, number, number, number];
};

const encoder = new TextEncoder();

const hex = (text: string): string =>
  Array.from(text, (character) => (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

const runContent = (run: TextRun): string =>
  `BT ${(run.color ?? [0, 0, 0]).join(" ")} rg /${run.bold === true ? "F2" : "F1"} ${run.size ?? 24} Tf ${run.x} ${run.y} Td <${hex(run.text)}> Tj ET`;

export const textPdf = (
  pages: ReadonlyArray<TextPage>,
): Effect.Effect<Uint8Array, never, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const [first = { width: 595, height: 842 }, ...rest] = pages;
    const size = ({ width, height }: TextPage) => ({ width, height });
    const created = yield* core.create({ pages: [size(first), ...rest.map(size)] });
    const { nextObjectNumber } = yield* core.document(created);
    const regular = { number: nextObjectNumber, generation: 0 };
    const bold = { number: nextObjectNumber + 1, generation: 0 };
    let next = nextObjectNumber + 2;
    const operations: Array<PdfCoreEditOperation> = [
      { op: "standardFont", ref: regular, baseFont: "Helvetica" },
      { op: "standardFont", ref: bold, baseFont: "Helvetica-Bold" },
    ];
    pages.forEach((page, pageIndex) => {
      const target: PdfCoreEditTarget = { base: { kind: "page", pageIndex } };
      if (page.rotate !== undefined) {
        operations.push({ op: "set", target, key: "Rotate", value: String(page.rotate) });
      }
      if (page.cropBox !== undefined) {
        operations.push({
          op: "set",
          target,
          key: "CropBox",
          value: `[${page.cropBox.join(" ")}]`,
        });
      }
      const content = [
        ...(page.fills ?? []).map(
          ({ box, color }) => `q ${color.join(" ")} rg ${box.join(" ")} re f Q`,
        ),
        ...(page.runs ?? []).map(runContent),
      ];
      if (content.length === 0) return;
      operations.push(
        {
          op: "addResource",
          pageIndex,
          category: "Font",
          name: "F1",
          value: `${regular.number} 0 R`,
        },
        { op: "addResource", pageIndex, category: "Font", name: "F2", value: `${bold.number} 0 R` },
        {
          op: "appendContent",
          pageIndex,
          ref: { number: next++, generation: 0 },
          data: encoder.encode(content.join("\n")),
          compress: true,
        },
      );
    });
    return yield* core.edit(created, operations, { mode: "rewrite" });
  }).pipe(Effect.orDie);

export const pdfPages = (pdf: Uint8Array): Effect.Effect<number, never, PdfCore> =>
  PdfCore.pipe(
    Effect.flatMap((core) => core.document(pdf)),
    Effect.map((document) => document.pages.length),
    Effect.orDie,
  );

export const lastAnnotationRect = (
  pdf: Uint8Array,
  pageIndex: number,
): Effect.Effect<readonly [number, number, number, number] | undefined, never, PdfCore> =>
  PdfCore.pipe(
    Effect.flatMap((core) => core.document(pdf, { annotationPages: [pageIndex] })),
    Effect.map((document) => document.annotations.at(-1)?.rect),
    Effect.orDie,
  );

export const titledPdf = (
  title: string,
  pages: ReadonlyArray<readonly [number, number]>,
): Uint8Array => {
  const pageRefs = pages.map((_, index) => `${index + 4} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`,
    `<< /Title (${title}) /Producer (SignatureKit tests) >>`,
    ...pages.map(
      ([width, height]) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> >>`,
    ),
  ];
  let source = "%PDF-1.7\n";
  const offsets = objects.map((body, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(source);
};
