import type {
  PdfCoreDocument,
  PdfCoreEditOperation,
  PdfCoreEditTarget,
  PdfCoreObjectRef,
} from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect } from "effect";

export type FixtureBox = readonly [left: number, bottom: number, right: number, top: number];

export type FixtureText = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly text: string;
};

export type FixturePage = {
  readonly size?: readonly [width: number, height: number];
  readonly text?: ReadonlyArray<FixtureText>;
  readonly rotate?: number;
  readonly cropBox?: FixtureBox;
  readonly mediaBox?: FixtureBox;
};

export type FixtureEdit = {
  readonly document: PdfCoreDocument;
  readonly next: () => PdfCoreObjectRef;
  readonly page: (pageIndex: number) => PdfCoreObjectRef;
};

const encoder = new TextEncoder();

export const ref = (value: PdfCoreObjectRef): string => `${value.number} ${value.generation} R`;

export const box = (value: FixtureBox): string => `[${value.join(" ")}]`;

const hexText = (text: string): string =>
  `<${Array.from(text, (character) =>
    (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0").toUpperCase(),
  ).join("")}>`;

export const textContent = (runs: ReadonlyArray<FixtureText>, font = "F1"): string =>
  runs
    .map((run) => `BT /${font} ${run.size} Tf ${run.x} ${run.y} Td ${hexText(run.text)} Tj ET`)
    .join("\n");

export const editFixturePdf = (
  pdf: Uint8Array,
  build: (edit: FixtureEdit) => ReadonlyArray<PdfCoreEditOperation>,
  options: { readonly objectStreams?: boolean; readonly incremental?: boolean } = {},
): Effect.Effect<Uint8Array, never, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const document = yield* core.document(pdf);
    let nextNumber = document.nextObjectNumber;
    const operations = build({
      document,
      next: () => ({ number: nextNumber++, generation: 0 }),
      page: (pageIndex) => {
        const pageRef = document.pages[pageIndex]?.ref;
        return pageRef ?? { number: 0, generation: 0 };
      },
    });
    return yield* core.edit(pdf, operations, {
      mode: options.incremental === true ? "incremental" : "rewrite",
      ...(options.objectStreams === true ? { objectStreams: true } : {}),
    });
  }).pipe(Effect.orDie);

export const createFixturePdf = (
  pages: ReadonlyArray<FixturePage> = [{}],
  options: { readonly objectStreams?: boolean } = {},
): Effect.Effect<Uint8Array, never, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const pageSize = (page: FixturePage) => ({
      width: page.size?.[0] ?? 320,
      height: page.size?.[1] ?? 180,
    });
    const [first = {}, ...rest] = pages;
    const created = yield* core.create({ pages: [pageSize(first), ...rest.map(pageSize)] });
    return yield* editFixturePdf(
      created,
      ({ next }) => {
        const operations: Array<PdfCoreEditOperation> = [{ op: "repairCatalog" }];
        const font = pages.some((page) => (page.text?.length ?? 0) > 0) ? next() : undefined;
        if (font !== undefined) {
          operations.push({ op: "standardFont", ref: font, baseFont: "Helvetica" });
        }
        pages.forEach((page, pageIndex) => {
          const target: PdfCoreEditTarget = { base: { kind: "page", pageIndex } };
          if (page.rotate !== undefined) {
            operations.push({ op: "set", target, key: "Rotate", value: String(page.rotate) });
          }
          if (page.mediaBox !== undefined) {
            operations.push({ op: "set", target, key: "MediaBox", value: box(page.mediaBox) });
          }
          if (page.cropBox !== undefined) {
            operations.push({ op: "set", target, key: "CropBox", value: box(page.cropBox) });
          }
          if (font !== undefined && (page.text?.length ?? 0) > 0) {
            operations.push(
              { op: "addResource", pageIndex, category: "Font", name: "F1", value: ref(font) },
              {
                op: "appendContent",
                pageIndex,
                ref: next(),
                data: encoder.encode(textContent(page.text ?? [])),
                compress: true,
              },
            );
          }
        });
        return operations;
      },
      options,
    );
  }).pipe(Effect.orDie);

const latin1 = new TextDecoder("latin1");

export const pdfSource = (pdf: Uint8Array): string => latin1.decode(pdf);

export const objectSource = (pdf: Uint8Array, number: number): string | undefined => {
  const matches = [
    ...pdfSource(pdf).matchAll(
      new RegExp(`(?:^|[\\r\\n\\s])${number} 0 obj\\s*([\\s\\S]*?)endobj`, "gu"),
    ),
  ];
  return matches.at(-1)?.[1]?.trim();
};

export const fixtureDocument = (
  pdf: Uint8Array,
  annotationPages?: ReadonlyArray<number>,
): Effect.Effect<PdfCoreDocument, never, PdfCore> =>
  PdfCore.pipe(
    Effect.flatMap((core) =>
      core.document(pdf, annotationPages === undefined ? {} : { annotationPages }),
    ),
    Effect.orDie,
  );

export const pageSizes = (
  pdf: Uint8Array,
): Effect.Effect<ReadonlyArray<readonly [number, number]>, never, PdfCore> =>
  fixtureDocument(pdf).pipe(
    Effect.map((document) =>
      document.pages.map(({ mediaBox: [left, bottom, right, top] }) => [
        right - left,
        top - bottom,
      ]),
    ),
  );

export const widgetRects = (
  pdf: Uint8Array,
  pageIndex: number,
): Effect.Effect<ReadonlyArray<FixtureBox>, never, PdfCore> =>
  fixtureDocument(pdf, [pageIndex]).pipe(
    Effect.map((document) =>
      document.annotations.flatMap((annotation) =>
        annotation.widget && annotation.rect !== undefined ? [annotation.rect] : [],
      ),
    ),
  );

export const acroFormFixture = (
  build: (next: () => PdfCoreObjectRef) => {
    readonly objects: ReadonlyArray<readonly [PdfCoreObjectRef, string]>;
    readonly fields: ReadonlyArray<PdfCoreObjectRef>;
  },
): Effect.Effect<Uint8Array, never, PdfCore> =>
  createFixturePdf().pipe(
    Effect.flatMap((pdf) =>
      editFixturePdf(pdf, ({ next }) => {
        const { objects, fields } = build(next);
        const operations: Array<PdfCoreEditOperation> = objects.map(([objectRef, value]) => ({
          op: "setObject",
          ref: objectRef,
          value,
        }));
        const acroForm = next();
        operations.push(
          {
            op: "setObject",
            ref: acroForm,
            value: `<< /Fields [${fields.map(ref).join(" ")}] >>`,
          },
          {
            op: "set",
            target: { base: { kind: "catalog" } },
            key: "AcroForm",
            value: ref(acroForm),
          },
        );
        return operations;
      }),
    ),
  );

export const acroFormFieldNumbers = (pdf: Uint8Array): ReadonlyArray<number> => {
  const fieldsArray = [...pdfSource(pdf).matchAll(/\/Fields\s*\[([^\]]*)\]/gu)].at(-1)?.[1] ?? "";
  return [...fieldsArray.matchAll(/(\d+)\s+\d+\s+R/gu)].map((match) => Number(match[1]));
};

export const acroFormField = (pdf: Uint8Array, index: number): string => {
  const number = acroFormFieldNumbers(pdf)[index];
  return number === undefined ? "" : (objectSource(pdf, number) ?? "");
};

export const pdfStringEntry = (body: string, key: string): string | undefined => {
  const literalValue = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`, "u").exec(body)?.[1];
  if (literalValue !== undefined) return literalValue.replace(/\\(.)/gu, "$1");
  const hex = new RegExp(`/${key}\\s*<([0-9A-Fa-f]*)>`, "u").exec(body)?.[1];
  if (hex === undefined) return undefined;
  const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  return bytes[0] === 0xfe && bytes[1] === 0xff
    ? new TextDecoder("utf-16be").decode(bytes.subarray(2))
    : latin1.decode(bytes);
};

const keyPattern = (key: string): string => `/${key}(?=[\\s/(<\\[\\]>]|$)`;

export const hasKey = (body: string, key: string): boolean =>
  new RegExp(keyPattern(key), "u").test(body);

export const entryRef = (body: string, key: string): number | undefined => {
  const match = new RegExp(`${keyPattern(key)}\\s*(\\d+)\\s+\\d+\\s+R`, "u").exec(body)?.[1];
  return match === undefined ? undefined : Number(match);
};

export const arrayRefs = (body: string, key: string): ReadonlyArray<number> => {
  const items = new RegExp(`${keyPattern(key)}\\s*\\[([^\\]]*)\\]`, "u").exec(body)?.[1] ?? "";
  return [...items.matchAll(/(\d+)\s+\d+\s+R/gu)].map((match) => Number(match[1]));
};

export const numberEntry = (body: string, key: string): number | undefined => {
  const match = new RegExp(`${keyPattern(key)}\\s*(-?[\\d.]+)(?!\\s+\\d+\\s+R)`, "u").exec(
    body,
  )?.[1];
  return match === undefined ? undefined : Number(match);
};

export const childObject = (pdf: Uint8Array, body: string, key: string, index: number): string => {
  const number = arrayRefs(body, key)[index];
  return number === undefined ? "" : (objectSource(pdf, number) ?? "");
};
