import { Buffer } from "node:buffer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const streamLength = 262144;

const document = (count: string, info: string) => {
  let source = "%PDF-2.0\n";
  const body = [
    "<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R /Lang (pt-BR) >>",
    `<< /Type /Pages /Kids [5 0 R] /Count ${count} >>`,
    info,
    `<< /Type /Metadata /Subtype /XML /Length ${streamLength} >>\nstream\n${" ".repeat(streamLength)}\nendstream`,
    `<< /Length ${streamLength} >>\nstream\n${" ".repeat(streamLength)}\nendstream`,
  ];
  const offsets = body.map((value, index) => {
    const offset = source.length;
    source += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return offset;
  });
  const xref = source.length;
  source += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Root 1 0 R /Info 3 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return {
    pdf: Buffer.from(source, "latin1"),
    metadataOffset: offsets[3] ?? 0,
    childOffset: offsets[4] ?? 0,
  };
};

describe("PdfCore document info", () => {
  it.effect("reads Info and Lang without fetching Metadata or walking the page tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const { pdf, metadataOffset, childOffset } = document(
          "7",
          "<< /Title () /Subject <FEFF004100E9> /Author <EFBBBFC3A9> /Keywords <8092> /Producer (Info producer) /CreationDate (D:20260811120000Z) /ModDate (D:20260812120000+03'00') >>",
        );
        const source = pdfCoreBytesSource(pdf);
        const doc = yield* core.openLazy(
          {
            size: source.size,
            read: (offset, length) => {
              expect(
                offset + length <= metadataOffset + 1 || offset > childOffset + streamLength,
              ).toBe(true);
              return source.read(offset, length);
            },
          },
          { probeBytes: 128, gapBytes: 0 },
        );
        const expected = {
          pageCount: 7,
          encrypted: false,
          title: "",
          subject: "Aé",
          author: "é",
          keywords: "•™",
          producer: "Info producer",
          creationDate: "D:20260811120000Z",
          modificationDate: "D:20260812120000+03'00'",
          language: "pt-BR",
        };
        expect(yield* core.info(pdf)).toStrictEqual(expected);
        expect(yield* doc.info).toStrictEqual(expected);
        expect((yield* doc.stats).strategy).toBe("lazy");
        expect((yield* doc.stats).bytesRead).toBeLessThan(1024);
      }),
    ).pipe(Effect.provide(layer)),
  );

  for (const count of ["-1", "1.5", "10001"]) {
    it.effect(`rejects an invalid or out-of-budget page count (${count})`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* PdfCore;
          const { pdf } = document(count, "<< >>");
          const doc = yield* core.openLazy(pdfCoreBytesSource(pdf));
          const error = yield* Effect.flip(core.info(pdf));
          expect(error.code).toBe(
            count === "10001"
              ? PdfCoreErrorCodeValue.limitExceeded
              : PdfCoreErrorCodeValue.invalidPdf,
          );
          expect(yield* Effect.flip(doc.info)).toStrictEqual(error);
        }),
      ).pipe(Effect.provide(layer)),
    );
  }
});
