import { deflateSync } from "node:zlib";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { signPdf } from "../src/sign";
import { stampPdfRubric, stampPdfVisibleSignature } from "../src/stamp";
import { verifyPdfSignatures } from "../src/verify";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { createFixturePdf, entryRef, fixtureDocument, objectSource } from "./pdf-fixtures";
import { pageContent, streamData } from "./pdf-streams";

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const chunk = new Uint8Array(data.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(data.byteLength + 8, crc32(chunk.subarray(4, data.byteLength + 8)));
  return chunk;
};

const solidPng = (red: number, green: number, blue: number): Uint8Array => {
  const chunks = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk("IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0)),
    pngChunk("IDAT", new Uint8Array(deflateSync(Uint8Array.of(0, red, green, blue)))),
    pngChunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return png;
};

const RED = solidPng(255, 0, 0);
const BLUE = solidPng(0, 0, 255);

const drawnXObjects = (content: string): ReadonlyArray<string> =>
  [...content.matchAll(/\/(\S+) Do\b/gu)].map((match) => match[1] ?? "");

const xObjectRef = (pdf: Uint8Array, pageNumber: number, name: string): number | undefined => {
  const page = objectSource(pdf, pageNumber) ?? "";
  const resourcesRef = entryRef(page, "Resources");
  const resources = resourcesRef === undefined ? page : (objectSource(pdf, resourcesRef) ?? "");
  const xObjectsRef = entryRef(resources, "XObject");
  const xObjects = xObjectsRef === undefined ? resources : (objectSource(pdf, xObjectsRef) ?? "");
  const match = new RegExp(`/${name}\\s+(\\d+)\\s+\\d+\\s+R`, "u").exec(xObjects)?.[1];
  return match === undefined ? undefined : Number(match);
};

const firstPageNumber = (pdf: Uint8Array) =>
  fixtureDocument(pdf).pipe(Effect.map((document) => document.pages[0]?.ref?.number ?? -1));

const signingLayer = Effect.gen(function* () {
  const pfx = yield* readA1Fixture("ecnpj");
  return Layer.merge(
    a1SignaturesLayer({ pfx, password: Redacted.make("changeit") }),
    pdfCoreTestLayer,
  );
});

describe("stamp resource names", () => {
  it.effect("keeps an earlier stamp's image when a later stamp draws on the same page", () =>
    Effect.gen(function* () {
      const source = yield* createFixturePdf([{}]);
      const first = yield* stampPdfVisibleSignature({
        pdf: source,
        pageIndex: 0,
        rect: { pageIndex: 0, x: 20, y: 20, width: 120, height: 60 },
        border: false,
        inkPng: RED,
      });
      const second = yield* stampPdfVisibleSignature({
        pdf: first,
        pageIndex: 0,
        rect: { pageIndex: 0, x: 200, y: 20, width: 120, height: 60 },
        border: false,
        inkPng: BLUE,
      });
      const page = yield* firstPageNumber(second);
      const [firstName, secondName] = drawnXObjects(yield* pageContent(second, 0));
      const firstRef = xObjectRef(first, page, firstName ?? "");
      const secondRef = xObjectRef(second, page, secondName ?? "");

      expect(drawnXObjects(yield* pageContent(first, 0))).toStrictEqual([firstName]);
      expect(firstName).not.toBe(secondName);
      expect(firstRef).toBeDefined();
      expect(secondRef).toBeDefined();
      expect(xObjectRef(second, page, firstName ?? "")).toBe(firstRef);
      expect(secondRef).not.toBe(firstRef);
      expect(streamData(second, firstRef ?? -1)).toBe("\xff\x00\x00");
      expect(streamData(second, secondRef ?? -1)).toBe("\x00\x00\xff");
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("keeps a signed appearance intact when a later signer stamps the same page", () =>
    Effect.gen(function* () {
      const layer = yield* signingLayer;
      const source = yield* createFixturePdf([{}]);
      const stampedA = yield* stampPdfVisibleSignature({
        pdf: source,
        pageIndex: 0,
        rect: { pageIndex: 0, x: 20, y: 20, width: 120, height: 60 },
        border: false,
        inkPng: RED,
      });
      const rubricA = yield* stampPdfRubric(stampedA, {
        rect: [20, 120, 92, 152],
        pages: [0],
        lines: ["A"],
      });
      const signedA = yield* signPdf({ pdf: rubricA, signatureLength: 8192 }).pipe(
        Effect.provide(layer),
      );
      const stampedB = yield* stampPdfVisibleSignature({
        pdf: signedA,
        pageIndex: 0,
        rect: { pageIndex: 0, x: 200, y: 20, width: 120, height: 60 },
        border: false,
        inkPng: BLUE,
      });
      const rubricB = yield* stampPdfRubric(stampedB, {
        rect: [120, 120, 192, 152],
        pages: [0],
        lines: ["B"],
      });
      const signedB = yield* signPdf({ pdf: rubricB, signatureLength: 8192 }).pipe(
        Effect.provide(layer),
      );
      const page = yield* firstPageNumber(signedB);
      const [inkA, inkB] = drawnXObjects(yield* pageContent(signedB, 0));
      const inkARef = xObjectRef(signedA, page, inkA ?? "");
      const results = yield* verifyPdfSignatures({ pdf: signedB });
      const content = yield* pageContent(signedB, 0);
      const fonts = [...content.matchAll(/\/(\S+) \d+(?:\.\d+)? Tf/gu)].map((match) => match[1]);

      expect(results.map((result) => result.valid)).toStrictEqual([true, true]);
      expect(inkA).not.toBe(inkB);
      expect(inkARef).toBeDefined();
      expect(xObjectRef(signedB, page, inkA ?? "")).toBe(inkARef);
      expect(streamData(signedB, inkARef ?? -1)).toBe("\xff\x00\x00");
      expect(new Set(fonts).size).toBe(fonts.length);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
