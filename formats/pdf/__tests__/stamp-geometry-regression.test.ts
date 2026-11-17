import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createIllustrativePdf,
  stampPdfRubric,
  stampPdfRubricOnPages,
  stampPdfVisibleSignature,
} from "../src/stamp";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { createFixturePdf, fixtureDocument, objectSource } from "./pdf-fixtures";
import { pageContent } from "./pdf-streams";

const ONE_BY_ONE_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const contentLines = (content: string): ReadonlyArray<string> =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const fixture = createFixturePdf([
  {},
  { size: [400, 400], cropBox: [100, 100, 300, 260], rotate: 90 },
]);

describe("visible stamp geometry", () => {
  it.effect("draws rubric frames, PNG placement and text at the legacy stamp coordinates", () =>
    Effect.gen(function* () {
      const stamped = yield* stampPdfRubric(yield* fixture, {
        rect: [20, 20, 140, 64],
        pages: [0],
        lines: ["Rubrica"],
        imagePng: ONE_BY_ONE_PNG,
      });

      expect(contentLines(yield* pageContent(stamped, 0))).toStrictEqual([
        "q 0.45 0.45 0.45 RG 0.6 w 20 20 120 44 re S Q",
        "q 22.52 0 0 22.52 68.74 38.48 cm /SigKitRubricImage Do Q",
        "q BT 0.1 0.1 0.1 rg /SigKitHelvetica 7 Tf 24 TL 1 0 0 1 23 30.48 Tm <52756272696361> Tj T* ET Q",
      ]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("rotates initials rubrics into the visible CropBox and centers the initials", () =>
    Effect.gen(function* () {
      const stamped = yield* stampPdfRubricOnPages({
        pdf: yield* fixture,
        pages: [1],
        pageDimensions: [{ index: 1, width: 160, height: 200 }],
        initials: "João Ávila",
        border: false,
      });
      const lines = contentLines(yield* pageContent(stamped, 1));
      const bracket = "q 0.1137 0.3059 0.8471 RG 1.12 w [] 0 d";

      expect(lines).toStrictEqual([
        "q 0 1 -1 0 300 100 cm",
        `${bracket} 74.48 111.52 m 83.44 111.52 l S Q`,
        `${bracket} 74.48 111.52 m 74.48 102.56 l S Q`,
        `${bracket} 137.52 111.52 m 128.56 111.52 l S Q`,
        `${bracket} 137.52 111.52 m 137.52 102.56 l S Q`,
        `${bracket} 74.48 88.48 m 83.44 88.48 l S Q`,
        `${bracket} 74.48 88.48 m 74.48 97.44 l S Q`,
        `${bracket} 137.52 88.48 m 128.56 88.48 l S Q`,
        `${bracket} 137.52 88.48 m 137.52 97.44 l S Q`,
        "q BT 0.1137 0.3059 0.8471 rg /SigKitHelvetica 15.36 Tf 24 TL 1 0 0 1 97.0374 93.5488 Tm <4A41> Tj T* ET Q",
        "Q",
      ]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("draws the badge container, QR quiet zone and modules, and its link annotation", () =>
    Effect.gen(function* () {
      const stamped = yield* stampPdfVisibleSignature({
        pdf: yield* fixture,
        pageIndex: 0,
        rect: { pageIndex: 0, x: 10, y: 10, width: 300, height: 120 },
        badge: {
          header: { text: "ASSINADO DIGITALMENTE" },
          rows: [[{ label: "Signatário", value: "Maria" }]],
          footer: [{ text: "validar.iti.gov.br", link: "https://validar.iti.gov.br" }],
          qr: { text: "https://validar.iti.gov.br" },
        },
      });
      const lines = contentLines(yield* pageContent(stamped, 0));
      const modules = lines[2]?.match(/ re /gu)?.length ?? 0;
      const document = yield* fixtureDocument(stamped, [0]);
      const link = document.annotations.find((annotation) => annotation.uri !== undefined);

      expect(lines[0]).toBe(
        "q 0.9412 0.9569 1 rg 0.2314 0.3569 0.8588 RG 1.5 w 20 50 m 300 50 l 310 50 310 60 v 310 160 l 310 170 300 170 v 20 170 l 10 170 10 160 v 10 60 l 10 50 20 50 v h B Q",
      );
      expect(lines[1]).toBe("q 1 1 1 rg 19 132.2264 28.7736 28.7736 re f Q");
      expect(lines[2]).toMatch(/^q 0\.1 0\.1 0\.1 rg 22\.4877 156\.6404 0\.8719 0\.8719 re /u);
      expect(modules).toBeGreaterThan(200);
      expect(lines.some((line) => line.includes("[4 4] 0 d"))).toBe(true);
      expect(link?.uri).toBe("https://validar.iti.gov.br");
      expect(link?.ref).toBeDefined();
      if (link?.ref !== undefined) {
        expect(objectSource(stamped, link.ref.number)).toMatch(/\/F 4\b/u);
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("lays out illustrative documents exactly where the legacy template did", () =>
    Effect.gen(function* () {
      const pdf = yield* createIllustrativePdf({
        title: "Acordo",
        body: "Corpo do documento",
        variant: "field",
        marked: true,
      });

      expect(contentLines(yield* pageContent(pdf, 0))).toStrictEqual([
        "q BT 0 0 0 rg /SigKitHelveticaBold 20 Tf 24 TL 1 0 0 1 48 770 Tm <41636F72646F> Tj T* ET Q",
        "q BT 0 0 0 rg /SigKitHelvetica 11 Tf 17 TL 1 0 0 1 48 720 Tm <436F72706F20646F20646F63756D656E746F> Tj T* ET Q",
        "q BT 0 0 0 rg /SigKitHelveticaBold 12 Tf 24 TL 1 0 0 1 48 125 Tm <4558454D504C4F2056495355414C202F2056495355414C204558414D504C45> Tj T* ET Q",
        "q BT 0 0 0 rg /SigKitHelvetica 10 Tf 24 TL 1 0 0 1 48 105 Tm <4E414F204520415353494E4154555241204449474954414C202F204E4F542041204449474954414C205349474E4154555245> Tj T* ET Q",
        "q 0 0 0 RG 1 w [] 0 d 48 190 m 300 190 l S Q",
        "q 0.45 0.45 0.45 RG 1 w 48 185 252 42 re S Q",
        "q BT 0 0 0 rg /SigKitHelvetica 10 Tf 24 TL 1 0 0 1 48 170 Tm <6669656C64> Tj T* ET Q",
        "q BT 0 0 0 rg /SigKitHelveticaBold 16 Tf 24 TL 1 0 0 1 55 202 Tm <4558414D504C45> Tj T* ET Q",
      ]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
