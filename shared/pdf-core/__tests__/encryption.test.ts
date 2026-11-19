import { Buffer } from "node:buffer";
import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import type { PdfCoreLazyStats } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
const id = "<31415926535897932384626433832795>";
const encryptedTrailer = ` /Encrypt 7 0 R /ID [${id}${id}]`;
const contents =
  "1 w 20 120 200 40 re S 120 120 m 120 160 l S 20 140 m 220 140 l S BT /F1 12 Tf 30 147 Td (Item) Tj 100 0 Td (Price) Tj -100 -20 Td (Book) Tj 100 0 Td (10) Tj ET";

const stream = (data: Buffer, entries: string): string =>
  `<< /Length ${data.length}${entries} >>\nstream\n${data.toString("latin1")}\nendstream`;

const link = (uri: string): string =>
  `<< /Type /Annot /Subtype /Link /Rect [0 0 40 40] /A << /S /URI /URI ${uri} >> >>`;

const pageObjects = (content: Buffer, uri: string, streamFilters: string): Array<string> => [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> /Annots [4 0 R] >>",
  link(uri),
  stream(content, streamFilters),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

const indirect = (number: number, body: string): string => `${number} 0 obj\n${body}\nendobj\n`;

const xrefTablePdf = (
  objects: ReadonlyArray<string>,
  trailer = "",
  omittedObject?: number,
): Buffer => {
  let result = "%PDF-1.7\n";
  const offsets = objects.map((body, index) => {
    const offset = result.length;
    result += indirect(index + 1, body);
    return index + 1 === omittedObject
      ? "0000000000 00000 f \n"
      : `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  const xref = result.length;
  const size = objects.length + 1;
  result += `xref\n0 ${size}\n0000000000 65535 f \n`;
  result += offsets.join("");
  result += `trailer\n<< /Size ${size} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, "latin1");
};

const pdf = (
  content: Buffer,
  uri: string,
  encryption?: string,
  streamFilters = encryption === undefined ? "" : " /Filter /FlateDecode",
): Uint8Array => {
  const objects = pageObjects(content, uri, streamFilters);
  return encryption === undefined
    ? xrefTablePdf(objects)
    : xrefTablePdf([...objects, encryption], encryptedTrailer);
};

const r5Dictionary =
  "<< /Filter /Standard /V 5 /R 5 /Length 256 /P -4 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <e4d6d5b2a2947349dbbc4249299f3041858d7d89ba6346419647c0a029dcba5d03030303030303030404040404040404> /OE <932a9f5784cb9df715be698c54c55a24e074e8f744c91f93311811d23ce2d560> /U <04abc8821a06e5a30937967d11ad10221cb5ac3b5273e434f1284ee87129a06101010101010101010202020202020202> /UE <cc5f7293e47e8dc660b3a972b87100e86a48123ee4da35816d7f8dd8b68983b3> /Perms <c9182b8a74a17d69a434f7ea9ff44b68> >>";

const aes256 = (data: Buffer, padding = true): Buffer => {
  const iv = Buffer.alloc(16, 0x19);
  const cipher = createCipheriv("aes-256-cbc", Buffer.alloc(32, 0x3a), iv);
  cipher.setAutoPadding(padding);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
};

const xrefRow = (type: number, offset: number, index: number): Buffer => {
  const row = Buffer.alloc(7);
  row.writeUInt8(type);
  row.writeUInt32BE(offset, 1);
  row.writeUInt16BE(index, 5);
  return row;
};

const encryptedObjectStreamPdf = (): Buffer => {
  const uri = "(https://example.test)";
  const filters = " /Filter /FlateDecode";
  const members = aes256(deflateSync(`4 0 ${link(uri)}`));
  const objects = [
    ...pageObjects(aes256(deflateSync(contents)), uri, filters),
    r5Dictionary,
    stream(members, ` /Type /ObjStm /N 1 /First 4${filters}`),
  ];
  let body = "%PDF-1.7\n";
  const rows = objects.map((object, index) => {
    const number = index + 1;
    if (number === 4) return xrefRow(2, 8, 0);
    const row = xrefRow(1, body.length, 0);
    body += indirect(number, object);
    return row;
  });
  const startxref = body.length;
  const xref = deflateSync(
    Buffer.concat([xrefRow(0, 0, 65535), ...rows, xrefRow(1, startxref, 0)]),
  );
  body += indirect(
    9,
    stream(xref, ` /Type /XRef /Size 10 /Root 1 0 R /W [1 4 2]${encryptedTrailer}${filters}`),
  );
  return Buffer.from(`${body}startxref\n${startxref}\n%%EOF\n`, "latin1");
};

const vectors = {
  r2: {
    uri: "<4f12a908a7b96b599b10915932d4073ff5d3d18d>",
    content:
      "d2a1b8340024ec0293a0f34da5092a93e2d573c1c005fc711b12c829745f092bdc101c0f37003b61e6fc65066568464ac60da87c26dc6ae398d214ad4f094a9c3018fa3ca26a43526b556b6742d28d8ba9d42e960ac929ac78df07ef103b46e3f7d82913cce35279c657d10d",
    dictionary:
      "<< /Filter /Standard /Length 40 /O <a0b130ed69fe55902dc33d8c602379c856fe7ed15e9d8e0bacd7367a5f67b6dc> /P -4 /R 2 /U <e0dcfef423e881eb379f48274cf2f6c4deb74ca157e4a2ed17813dfddf601617> /V 1 >>",
  },
  r3: {
    uri: "<b956856ecffda3e9323599147078a1acadd66a49>",
    content:
      "6d313e808b3f945ecc882a2eae297b0368d53b02d66a3b1b20d8ff9025c4d3c3ca233e4ce428e42f351e574c2d28d1267737040376cb694927b17ac3007056f6cc92e37452126263b23897656fee781d093f4616d3f65750a4f374aa8ce9dba896aa637f46d21b47f9f71918",
    dictionary:
      "<< /Filter /Standard /Length 128 /O <5a0c0b55deda723d6a1a77ca020e0bf91273d02733c4748c700d9eb9a6d68a09> /P -4 /R 3 /U <7556a3ea1d7266be2635f8b0c1eb48ab0021446990b9e4114071a4d9104984c1> /V 2 >>",
  },
  r4rc4: {
    uri: "<67c267d4b551c3b5a323c3c3b718e26febe5d152>",
    content:
      "e1ba820c5305fce67df8039af4da1b4a8a67965bdfb29ae0ec1fd09f7410efd65710e2aa7963408e4a3599da329c69e598fee68e7cc796b925b0f60cd704ac32dc29c59f7459158f00389781950bbb597ee681a90c7acbc6d0787c0113773c4f5d3dae616a55082396a65f5e",
    dictionary:
      "<< /CF << /StdCF << /AuthEvent /DocOpen /CFM /V2 /Length 16 >> >> /EncryptMetadata false /Filter /Standard /Length 128 /O <5a0c0b55deda723d6a1a77ca020e0bf91273d02733c4748c700d9eb9a6d68a09> /OE <> /P -4 /R 4 /StmF /StdCF /StrF /StdCF /U <62b93ce6d50b4f87ebceae9507cc498e0021446990b9e4114071a4d9104984c1> /UE <> /V 4 >>",
  },
  r4aes: {
    uri: "<0e1c2a38465462707e8c9aa8b6c4d2e0a855eb54e095518e6bd6fab9d7d7b3cf45e104d546d80485550b7a1191c6f9b7>",
    content:
      "0e1c2a38465462707e8c9aa8b6c4d2e0db4f7853f5e2f47456927395c5850459dc16dbf12c0700e5b5e30c8b22231a2914ff78041ed4395d7d81ae37daceea24e89aa7c7956d75bbb01217441266f7fdf150d7f98b37565da339833385cfca10134778a8af002791c98f3e4d2e6c6bc842bee258d6c96a605c69759782d0860e",
    dictionary:
      "<< /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /Filter /Standard /Length 128 /O <5a0c0b55deda723d6a1a77ca020e0bf91273d02733c4748c700d9eb9a6d68a09> /OE <> /P -4 /R 4 /StmF /StdCF /StrF /StdCF /U <7556a3ea1d7266be2635f8b0c1eb48ab0021446990b9e4114071a4d9104984c1> /UE <> /V 4 >>",
  },
  r6: {
    uri: "<0e1c2a38465462707e8c9aa8b6c4d2e0f574471ad71c03252fbfd15cca1b48177ddfb44ba010148dc81c843e587df5e2>",
    content:
      "0e1c2a38465462707e8c9aa8b6c4d2e0b8158e0d9acc5f9cd66f93f324b37f3eb4ed93b0df59d66b8534c8a8bb8edebc5ffaf8ba04c8a518039e93e9648e11e002fe039f903900101df5f3c4129392806411b5b513cb10151eba1c20d959488ca8228385903f121e58c9c15941e2cd5f2ea1bc716df5d2a019bebfa7bf9f9c6d",
    dictionary:
      "<< /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /Filter /Standard /Length 256 /O <cd8ccfac99ff5d10d94eef8e1cbab66598296ae05ee414353f05579cc3311fed28f256297c08efa7e9dff45fa79db51b> /OE <26fa174c0a1e845e28c06b58d64cfb33bcdbd15b21e8ae32694766b9bcca9228> /P -4 /Perms <de892da4b03480a1dcc2950c60917329> /R 6 /StmF /StdCF /StrF /StdCF /U <c0da6e8ec122099abc7562a19c9730d71e3cb985fbfd0b20fb6b658befe774b67bd82e31eee7d3951fe71609b7e2f8ec> /UE <6e12d7ab9b9a29204af44ad1e08fbbe3bd3af5dae16482175276a0f5da5684a1> /V 5 >>",
  },
  locked: {
    uri: "<0e1c2a38465462707e8c9aa8b6c4d2e02224c115a46ef184b602a239c2b0ef6458e7ae935e04ec7b3d1c3f89e54fac41>",
    content:
      "0e1c2a38465462707e8c9aa8b6c4d2e0377d2c81ecebd4c316598dd291c85c3778bb7ff33f88652138d599f1e6f52d9e82f706b80da41341b292b30be8200621d13e587fb9fff550c4b6dd2e40adfd3320e21dda05f4a35f002908d520cbb23a1a38af9da82cb54c5ba9f9013493fefefa21b30ceb3ade5215e61f832aee9d4a",
    dictionary:
      "<< /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /Filter /Standard /Length 256 /O <a64e038da70c77fd9d839b4c440bfe1b8be021b4dc5b1b09bce46fdaf531cabf965b9750fb2f636c73e2f5a3ea00567a> /OE <c9f6dc0ecb65a73364ab4a4dd11a3f0490d2e897dd291530929b610d1969e3dd> /P -4 /Perms <536ffee20714c4475d8a2cfc47ae4314> /R 6 /StmF /StdCF /StrF /StdCF /U <5c492b5d3b64454a2e9c6dd6e308c1b29d014a5199c6174d933b01cf8ee28157662619bb909121463e6282a34b6d601d> /UE <972b11fb07a2929a3ded309d8f5a3a60927d8a2645c2d0f46042d3e9c175beee> /V 5 >>",
  },
};

const fixture = (vector: (typeof vectors)[keyof typeof vectors]): Uint8Array =>
  pdf(Buffer.from(vector.content, "hex"), vector.uri, vector.dictionary);

const compareLazy = Effect.fn(function* (
  input: Uint8Array,
  strategy: PdfCoreLazyStats["strategy"] = "lazy",
) {
  const core = yield* PdfCore;
  const doc = yield* core.openLazy(pdfCoreBytesSource(input));
  for (const pageIndexes of [[0], [0, 0], []]) {
    const plain = { pageIndexes };
    const markdown = { pageIndexes, format: "markdown" } satisfies Parameters<typeof doc.text>[0];
    expect(yield* doc.text(plain)).toStrictEqual(yield* core.text(input, plain));
    expect(yield* doc.text(markdown)).toStrictEqual(yield* core.text(input, markdown));
    expect(yield* doc.tables(plain)).toStrictEqual(yield* core.tables(input, plain));
    expect(yield* doc.renderPages(plain)).toStrictEqual(yield* core.renderPages(input, plain));
  }
  expect((yield* doc.stats).strategy).toBe(strategy);
});

describe("PdfCore encrypted PDFs", () => {
  const plain = pdf(Buffer.from(contents), "(https://example.test)");
  const options = { text: true, links: true };

  for (const [name, vector] of Object.entries(vectors)) {
    if (name === "locked") continue;
    it.effect(`reads and merges ${name} with an empty user password`, () =>
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const input = fixture(vector);
        yield* Effect.scoped(compareLazy(input));
        const expected = yield* core.inspect(plain, options);
        expect(expected.links[0]?.uri).toBe("https://example.test");
        expect(yield* core.inspect(input, options)).toEqual(expected);
        expect(yield* core.text(input)).toEqual(yield* core.text(plain));
        const tables = yield* core.tables(plain);
        expect(tables[0]?.cells.map((cell) => cell.text)).toEqual(["Item", "Price", "Book", "10"]);
        expect(yield* core.tables(input)).toEqual(tables);
        expect(yield* core.renderPages(input)).toEqual(yield* core.renderPages(plain));
        const info = yield* core.document(input, { annotationPages: [0] });
        expect(info.annotations[0]?.uri).toBe("https://example.test");
        const merged = yield* core.merge([{ pdf: input, pageIndexes: [0] }]);
        expect(Buffer.from(merged).includes("/Encrypt")).toBe(false);
        expect(yield* core.inspect(merged, options)).toEqual(expected);
      }).pipe(Effect.provide(layer)),
    );
  }

  it.effect("extracts lazily from an encrypted object stream", () =>
    Effect.scoped(compareLazy(encryptedObjectStreamPdf())).pipe(Effect.provide(layer)),
  );

  it.effect("reads both legacy version and revision combinations", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const v2r2 = vectors.r2;
      const input = fixture({ ...v2r2, dictionary: v2r2.dictionary.replace("/V 1", "/V 2") });
      yield* Effect.scoped(compareLazy(input));
      expect(yield* core.inspect(input, options)).toEqual(yield* core.inspect(plain, options));
      const v1r3 = pdf(
        Buffer.from(
          "70acb5db8efca1750e1733017bd83ec5efbeb71f4a779b94b84782327a9f8a0b46af9e",
          "hex",
        ),
        "<dd1fdb0e451e3a10d58da4e127696658157854ba>",
        "<< /Filter /Standard /V 1 /R 3 /P -4 /O <61840a4e66456bd408feb9a45fc05fce6d8f57574f1350bf0362c1836240898c> /U <7d96333c226e3ca7101c067ccaa2cc4000000000000000000000000000000000> >>",
        "",
      );
      yield* Effect.scoped(compareLazy(v1r3));
      const expected = pdf(
        Buffer.from("BT /F1 12 Tf 30 147 Td (Item) Tj ET"),
        "(https://example.test)",
      );
      expect(yield* core.inspect(v1r3, options)).toEqual(yield* core.inspect(expected, options));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts unsigned permissions and rejects values outside 32 bits", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r2;
      const withPermissions = (flags: number) =>
        fixture({ ...vector, dictionary: vector.dictionary.replace("/P -4", `/P ${flags}`) });
      yield* Effect.scoped(compareLazy(withPermissions(4294967292)));
      expect(yield* core.inspect(withPermissions(4294967292), options)).toEqual(
        yield* core.inspect(plain, options),
      );
      for (const flags of [-2147483649, 4294967296]) {
        const failure = yield* Effect.flip(core.inspect(withPermissions(flags), options));
        expect(failure.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("derives the V4 key length from bytes, bits, or the default", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r4aes;
      const expected = yield* core.inspect(plain, options);
      for (const filterLength of [" /Length 16", " /Length 128", ""]) {
        const dictionary = vector.dictionary
          .replace(" /Length 128", "")
          .replace(" /Length 16", filterLength);
        const input = fixture({ ...vector, dictionary });
        yield* Effect.scoped(compareLazy(input));
        expect(yield* core.inspect(input, options)).toEqual(expected);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads R6 password entries padded out to 127 bytes", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r6;
      const dictionary = vector.dictionary.replaceAll(
        /(\/[OU] <[\da-f]{96})>/g,
        (_, entry: string) => `${entry}${"00".repeat(79)}>`,
      );
      const input = fixture({ ...vector, dictionary });
      yield* Effect.scoped(compareLazy(input));
      expect(yield* core.inspect(input, options)).toEqual(yield* core.inspect(plain, options));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a clear xref stream and decrypts its R5 object stream once", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const input = encryptedObjectStreamPdf();
      const expected = yield* core.inspect(plain, options);
      expect(yield* core.inspect(input, options)).toEqual(expected);
      const merged = yield* core.merge([{ pdf: input }]);
      expect(yield* core.inspect(merged, options)).toEqual(expected);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rebuilds an xref table missing its encryption entry", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r4aes;
      const objects = pageObjects(
        Buffer.from(vector.content, "hex"),
        vector.uri,
        " /Filter /FlateDecode",
      );
      const expected = yield* core.inspect(plain, options);
      const input = xrefTablePdf([...objects, vector.dictionary], encryptedTrailer, 7);
      yield* Effect.scoped(compareLazy(input, "fallback"));
      expect(yield* core.inspect(input, options)).toEqual(expected);
      const failure = yield* Effect.flip(
        core.inspect(xrefTablePdf(objects, encryptedTrailer), options),
      );
      expect(failure.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves clear metadata when EncryptMetadata is false", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r4rc4;
      const objects = pageObjects(
        Buffer.from(vector.content, "hex"),
        vector.uri,
        " /Filter /FlateDecode",
      );
      objects[0] = "<< /Type /Catalog /Pages 2 0 R /Metadata 8 0 R >>";
      const metadata = "<metadata>Clear text</metadata>";
      const input = xrefTablePdf(
        [
          ...objects,
          vector.dictionary,
          stream(Buffer.from(metadata), " /Type /Metadata /Subtype /XML"),
        ],
        encryptedTrailer,
      );
      yield* Effect.scoped(compareLazy(input));
      expect(yield* core.inspect(input, options)).toEqual(yield* core.inspect(plain, options));
      const rewritten = yield* core.edit(input, [], { mode: "rewrite" });
      expect(Buffer.from(rewritten).includes(metadata)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the bytes of an explicit Identity stream and removes the Crypt filter", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r4rc4;
      const input = pdf(
        deflateSync(contents),
        vector.uri,
        vector.dictionary,
        " /Filter [/Crypt /FlateDecode] /DecodeParms [<< /Name /Identity >> null]",
      );
      yield* Effect.scoped(compareLazy(input));
      const expected = yield* core.inspect(plain, options);
      expect(yield* core.inspect(input, options)).toEqual(expected);
      const merged = yield* core.merge([{ pdf: input }]);
      expect(Buffer.from(merged).includes("/Crypt")).toBe(false);
      expect(yield* core.inspect(merged, options)).toEqual(expected);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps empty and malformed AES strings and preserves bytes with invalid padding", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const badPadding = Buffer.from("Invalid padding!");
      const objects = pageObjects(
        aes256(deflateSync(contents)),
        `<${aes256(Buffer.from("https://example.test")).toString("hex")}>`,
        " /Filter /FlateDecode",
      );
      objects[0] = "<< /Type /Catalog /Pages 2 0 R /Lang () /Malformed (short) /Metadata 8 0 R >>";
      const input = xrefTablePdf(
        [
          ...objects,
          r5Dictionary,
          stream(aes256(badPadding, false), " /Type /Metadata /Subtype /XML"),
        ],
        encryptedTrailer,
      );
      yield* Effect.scoped(compareLazy(input));
      expect(yield* core.inspect(input, options)).toEqual(yield* core.inspect(plain, options));
      const rewritten = Buffer.from(yield* core.edit(input, [], { mode: "rewrite" }));
      expect(rewritten.includes("/Lang ()")).toBe(true);
      expect(rewritten.includes("/Malformed (short)")).toBe(true);
      expect(rewritten.includes(badPadding)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves signature Contents untouched when rewriting an encrypted PDF", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const input = readFileSync(new URL("./fixtures/encryption/signed.pdf", import.meta.url));
      const report = yield* core.signatures(input, "dictionaries");
      expect(report.failure).toBeUndefined();
      const signature = report.dictionaries[0];
      const span = signature?.contents;
      if (span === undefined) return yield* Effect.die("Missing signature contents in fixture");
      expect(signature?.unsignedPlaceholder).toBe(false);
      const contentsToken = input.toString("ascii", span.valueStart, span.valueEnd);
      expect(contentsToken.startsWith("<30")).toBe(true);
      const rewritten = Buffer.from(yield* core.edit(input, [], { mode: "rewrite" }));
      expect(rewritten.includes(`/Contents ${contentsToken}`)).toBe(true);
      expect(rewritten.includes("/Encrypt")).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("removes an explicit crypt filter when merging its decrypted stream", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const vector = vectors.r4aes;
      const input = pdf(
        Buffer.from(vector.content, "hex"),
        vector.uri,
        vector.dictionary,
        " /Filter [/Crypt /FlateDecode] /DecodeParms [<< /Name /StdCF >> null]",
      );
      yield* Effect.scoped(compareLazy(input));
      const expected = yield* core.text(plain);
      expect(yield* core.text(input)).toEqual(expected);
      const merged = yield* core.merge([{ pdf: input }]);
      expect(yield* core.text(merged)).toEqual(expected);
      expect(Buffer.from(merged).includes("/Crypt")).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps nonempty user passwords behind the typed encryption error", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const input = fixture(vectors.locked);
      const lazyFailure = yield* Effect.scoped(
        Effect.gen(function* () {
          const doc = yield* core.openLazy(pdfCoreBytesSource(input));
          return yield* Effect.flip(doc.text({ pageIndexes: [0] }));
        }),
      );
      expect(lazyFailure.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
      const failed = yield* Effect.flip(core.inspect(input, options));
      expect(failed.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rewrites an encrypted input for its first signature", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const input = fixture(vectors.r6);
      const result = yield* core.edit(input, [
        {
          op: "signature",
          ref: { number: 8, generation: 0 },
          contentsLength: 64,
          entries: "<< /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached >>",
        },
        {
          op: "append",
          target: { base: { kind: "page", pageIndex: 0 } },
          key: "Annots",
          value: "9 0 R",
        },
        {
          op: "setObject",
          ref: { number: 9, generation: 0 },
          value:
            "<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /V 8 0 R /T (Sig1) /P 3 0 R >>",
        },
        {
          op: "set",
          target: { base: { kind: "catalog" } },
          key: "AcroForm",
          value: "<< /Fields [9 0 R] /SigFlags 3 >>",
        },
      ]);
      expect(Buffer.from(result).includes("/Encrypt")).toBe(false);
      const report = yield* core.signatures(result, "dictionaries");
      expect(report.failure).toBeUndefined();
      expect(report.dictionaries[0]?.unsignedPlaceholder).toBe(true);
      expect(yield* core.text(result)).toEqual(yield* core.text(plain));
      const error = yield* Effect.flip(core.edit(input, [], { mode: "incremental" }));
      expect(error.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
    }).pipe(Effect.provide(layer)),
  );
});
