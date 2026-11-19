import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { Effect } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";

const rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const dc = "http://purl.org/dc/elements/1.1/";
const pdf = "http://ns.adobe.com/pdf/1.3/";
const xmp = "http://ns.adobe.com/xap/1.0/";
const xml = "http://www.w3.org/XML/1998/namespace";

type XmpDescriptions = ReturnType<
  ReturnType<DOMParser["parseFromString"]>["getElementsByTagNameNS"]
>;

const property = (
  descriptions: XmpDescriptions,
  namespace: string,
  name: string,
): string | undefined => {
  for (let index = 0; index < descriptions.length; index += 1) {
    const description = descriptions.item(index);
    if (description === null) continue;
    const attribute = description.getAttributeNS(namespace, name);
    if (attribute !== null) return attribute;
    const element = Array.from(description.getElementsByTagNameNS(namespace, name)).find(
      (child) => child.parentNode === description,
    );
    if (element === undefined) continue;
    const alt = Array.from(element.getElementsByTagNameNS(rdf, "Alt"))[0];
    if (alt === undefined) return element.textContent ?? undefined;
    const items = Array.from(alt.getElementsByTagNameNS(rdf, "li"));
    const value =
      items.find((item) => item.getAttributeNS(xml, "lang") === "x-default") ?? items[0];
    if (value !== undefined) return value.textContent ?? undefined;
  }
  return undefined;
};

export const readXmp = (bytes: Uint8Array) =>
  bytes.length === 0
    ? Effect.succeed({})
    : Effect.try({
        try: () => {
          const encoding =
            bytes[0] === 0xfe && bytes[1] === 0xff
              ? "utf-16be"
              : bytes[0] === 0xff && bytes[1] === 0xfe
                ? "utf-16le"
                : "utf-8";
          const packet = new TextDecoder(encoding, { fatal: true }).decode(bytes);
          const document = new DOMParser({ onError: onErrorStopParsing }).parseFromString(
            packet,
            "application/xml",
          );
          if (document.doctype !== null) return {};
          const descriptions = document.getElementsByTagNameNS(rdf, "Description");
          const title = property(descriptions, dc, "title");
          const subject = property(descriptions, dc, "description");
          const creator = property(descriptions, xmp, "CreatorTool");
          const producer = property(descriptions, pdf, "Producer");
          return {
            ...(title === undefined ? {} : { title }),
            ...(subject === undefined ? {} : { subject }),
            ...(creator === undefined ? {} : { creator }),
            ...(producer === undefined ? {} : { producer }),
          };
        },
        catch: () =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.invalidPdf,
            operation: PdfCoreOperationValue.info,
            reason: "The PDF metadata stream is not valid XMP XML.",
          }),
      }).pipe(Effect.orElseSucceed(() => ({})));
