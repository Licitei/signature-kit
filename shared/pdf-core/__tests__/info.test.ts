import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const document = (count: string, info: string, xmp = "") => {
  let source = "%PDF-2.0\n";
  const packet = deflateSync(Buffer.from(xmp)).toString("latin1");
  const body = [
    "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R /Lang (pt-BR) >>",
    `<< /Type /Pages /Kids [4 0 R] /Count ${count} >>`,
    info,
    `<< /Length 262144 >>\nstream\n${" ".repeat(262144)}\nendstream`,
    `<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length ${packet.length} >>\nstream\n${packet}\nendstream`,
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
  return { pdf: Buffer.from(source, "latin1"), unneeded: offsets[3] ?? 0 };
};

const xmp = `
<?xpacket begin=""?>
<data:RDF xmlns:data="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <data:Description xmlns:d="http://purl.org/dc/elements/1.1/" xmlns:p="http://ns.adobe.com/pdf/1.3/"
    xmlns:x="http://ns.adobe.com/xap/1.0/" x:CreatorTool="XML creator">
    <d:title><data:Alt>
      <data:li xml:lang="en">English title</data:li>
      <data:li xml:lang="x-default">Default &amp; title</data:li>
    </data:Alt></d:title>
    <d:description><data:Alt><data:li xml:lang="en"><![CDATA[XML subject]]></data:li></data:Alt></d:description>
    <p:Producer>XML producer</p:Producer>
  </data:Description>
</data:RDF>
<?xpacket end="w"?>`;

describe("PdfCore document info", () => {
  it.effect("decodes PDF strings, prefers Info and reads XMP without walking the page tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const { pdf, unneeded } = document(
          "7",
          "<< /Subject <FEFF004100E9> /Author <EFBBBFC3A9> /Keywords <8092> /CreationDate (D:20260811120000Z) /ModDate (D:20260812120000+03'00') >>",
          xmp,
        );
        const source = pdfCoreBytesSource(pdf);
        const doc = yield* core.openLazy(
          {
            size: source.size,
            read: (offset, length) => {
              expect(offset + length <= unneeded + 1 || offset > unneeded + 262144).toBe(true);
              return source.read(offset, length);
            },
          },
          { probeBytes: 128, gapBytes: 0 },
        );
        const expected = {
          pageCount: 7,
          encrypted: false,
          title: "Default & title",
          subject: "Aé",
          author: "é",
          keywords: "•™",
          creator: "XML creator",
          producer: "XML producer",
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

  it.effect("fills the subject from XMP and tolerates malformed XMP", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const first = document("1", "<< /Title () >>", xmp);
      expect(yield* core.info(first.pdf)).toMatchObject({ title: "", subject: "XML subject" });
      const second = document("1", "<< /Title (Info only) >>", "<broken");
      expect(yield* core.info(second.pdf)).toStrictEqual({
        title: "Info only",
        language: "pt-BR",
        pageCount: 1,
        encrypted: false,
      });
    }).pipe(Effect.provide(layer)),
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
