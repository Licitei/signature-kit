import { inflateSync } from "node:zlib";
import type { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect } from "effect";
import { arrayRefs, entryRef, fixtureDocument, objectSource, pdfSource } from "./pdf-fixtures";

export const decodedFlateStreams = (bytes: Uint8Array): string => {
  const pdf = Buffer.from(bytes);
  const text = pdf.toString("latin1");
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const filterIndex = text.indexOf("/Filter /FlateDecode", offset);
    if (filterIndex === -1) break;
    const dictionaryStart = text.lastIndexOf("<<", filterIndex);
    const streamMarker = text.indexOf("stream", filterIndex);
    const dictionaryText =
      dictionaryStart === -1 || streamMarker === -1
        ? ""
        : text.slice(dictionaryStart, streamMarker);
    const lengthText = /\/Length\s+(\d+)/u.exec(dictionaryText)?.[1];
    if (streamMarker === -1 || lengthText === undefined) {
      offset = filterIndex + "/Filter /FlateDecode".length;
      continue;
    }
    let dataStart = streamMarker + "stream".length;
    if (text[dataStart] === "\r" && text[dataStart + 1] === "\n") dataStart += 2;
    else if (text[dataStart] === "\n") dataStart += 1;
    const dataEnd = dataStart + Number.parseInt(lengthText, 10);
    if (!dictionaryText.includes("/Type /ObjStm")) {
      const decoded = inflateSync(pdf.subarray(dataStart, dataEnd)).toString("latin1");
      if (/(^|\n)(q|BT)\b|\scm\b|\srg\b|\sRG\b|\sTj\b/u.test(decoded)) chunks.push(decoded);
    }
    offset = dataEnd;
  }
  return chunks.join("\n");
};

export const streamData = (pdf: Uint8Array, number: number): string => {
  const source = pdfSource(pdf);
  const header = [...source.matchAll(new RegExp(`(?:^|\\s)${number} 0 obj\\s*<<`, "gu"))].at(-1);
  if (header === undefined) return "";
  const streamMarker = source.indexOf("stream", header.index);
  const dictionary = source.slice(header.index, streamMarker);
  const length = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/u.exec(dictionary)?.[1] ?? Number.NaN);
  if (!Number.isFinite(length)) return "";
  let start = streamMarker + "stream".length;
  if (source[start] === "\r") start += 1;
  if (source[start] === "\n") start += 1;
  const data = pdf.subarray(start, start + length);
  return (dictionary.includes("/FlateDecode") ? inflateSync(data) : Buffer.from(data)).toString(
    "latin1",
  );
};

export const pageContent = (
  pdf: Uint8Array,
  pageIndex: number,
): Effect.Effect<string, never, PdfCore> =>
  fixtureDocument(pdf).pipe(
    Effect.map((document) => {
      const pageRef = document.pages[pageIndex]?.ref;
      const page = pageRef === undefined ? "" : (objectSource(pdf, pageRef.number) ?? "");
      const direct = entryRef(page, "Contents");
      const contents =
        direct === undefined
          ? arrayRefs(page, "Contents")
          : (objectSource(pdf, direct) ?? "").startsWith("[")
            ? [...(objectSource(pdf, direct) ?? "").matchAll(/(\d+)\s+\d+\s+R/gu)].map((match) =>
                Number(match[1]),
              )
            : [direct];
      return contents.map((number) => streamData(pdf, number)).join("\n");
    }),
  );
