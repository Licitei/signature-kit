import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PdfCoreEditOperation,
  PdfCoreEditTarget,
  PdfCoreFontMetrics,
  PdfCoreObjectRef,
} from "../src/config.ts";
import { PdfCore, pdfCoreLayer } from "../src/pdf-core.ts";
import { Effect } from "effect";

import { LINK_FIXTURE_URIS, PDF_CORE_FIXTURES_DIR } from "../__tests__/corpus.ts";
import { renderTakumiDeclarationPdf } from "./takumi-declaration-document.ts";

const { renderToBuffer, Document, Link, Page, Text, View, Font, StyleSheet } =
  await import("@react-pdf/renderer");
const React = await import("react");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const PAGE_SIZE: readonly [number, number] = [612, 792];
const icpSource = join(repoRoot, "validators/iti/__tests__/fixtures/icp-brasil-ad-rb-signed.pdf");
const encoder = new TextEncoder();
const CORPUS_CREATION_DATE = new Date(Date.UTC(2026, 0, 1));

const MINIMAL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

type FontName = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique";
type Box = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];

const FONT_RESOURCES: Readonly<Record<FontName, string>> = {
  Helvetica: "F1",
  "Helvetica-Bold": "F2",
  "Helvetica-Oblique": "F3",
};

type Metrics = Readonly<Record<FontName, PdfCoreFontMetrics>>;

type Painter = {
  readonly text: (
    text: string,
    options: {
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly font?: FontName;
      readonly color?: Rgb;
    },
  ) => void;
  readonly rect: (box: Box, lineWidth: number) => void;
  readonly image: (box: Box) => void;
  readonly link: (
    uri: string,
    rect: Box,
    options?: { readonly hex?: boolean; readonly indirectAction?: boolean },
  ) => void;
  readonly width: (text: string, size: number, font?: FontName) => number;
};

type PageSpec = {
  readonly rotate?: number;
  readonly cropBox?: Box;
  readonly draw: (painter: Painter) => void;
};

type LinkSpec = {
  readonly uri: string;
  readonly rect: Box;
  readonly hex: boolean;
  readonly indirectAction: boolean;
};

const winAnsiHex = (metrics: PdfCoreFontMetrics, text: string): string => {
  const codes = new Map<number, number>();
  metrics.unicode.forEach((unicode, code) => {
    if (unicode !== 0 && !codes.has(unicode)) codes.set(unicode, code);
  });
  return Array.from(text, (character) =>
    (codes.get(character.codePointAt(0) ?? 0) ?? 0x3f).toString(16).padStart(2, "0"),
  ).join("");
};

const textWidth = (metrics: PdfCoreFontMetrics, text: string, size: number): number => {
  let units = 0;
  for (const character of text) {
    const code = metrics.unicode.indexOf(character.codePointAt(0) ?? 0);
    units += code < 0 ? 0 : (metrics.widths[code] ?? 0);
  }
  return (units * size) / 1000;
};

const utf16Hex = (text: string): string =>
  `FEFF${Array.from({ length: text.length }, (_, index) =>
    text.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("")}`;

const literal = (text: string): string => `(${text.replace(/[\\()]/gu, (match) => `\\${match}`)})`;

const loadMetrics = Effect.gen(function* () {
  const core = yield* PdfCore;
  return {
    Helvetica: yield* core.fontMetrics("Helvetica"),
    "Helvetica-Bold": yield* core.fontMetrics("Helvetica-Bold"),
    "Helvetica-Oblique": yield* core.fontMetrics("Helvetica-Oblique"),
  } satisfies Metrics;
});

const buildPdf = (
  pages: ReadonlyArray<PageSpec>,
  options: { readonly objectStreams?: boolean } = {},
) =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const metrics = yield* loadMetrics;
    const created = yield* core.create({
      pages: pages.map(() => ({ width: PAGE_SIZE[0], height: PAGE_SIZE[1] })),
    });
    const { nextObjectNumber } = yield* core.document(created);
    let next = nextObjectNumber;
    const allocate = (): PdfCoreObjectRef => ({ number: next++, generation: 0 });
    const fontRefs = new Map<FontName, PdfCoreObjectRef>();
    let imageRef: PdfCoreObjectRef | undefined;
    const operations: Array<PdfCoreEditOperation> = [];
    const fontRef = (font: FontName): PdfCoreObjectRef => {
      const found = fontRefs.get(font);
      if (found !== undefined) return found;
      const created = allocate();
      fontRefs.set(font, created);
      operations.push({ op: "standardFont", ref: created, baseFont: font });
      return created;
    };
    for (const [pageIndex, page] of pages.entries()) {
      const content: Array<string> = [];
      const links: Array<LinkSpec> = [];
      const usedFonts = new Set<FontName>();
      let usesImage = false;
      page.draw({
        text: (text, { x, y, size, font = "Helvetica", color = [0, 0, 0] }) => {
          usedFonts.add(font);
          content.push(
            `BT ${color.join(" ")} rg /${FONT_RESOURCES[font]} ${size} Tf ${x} ${y} Td <${winAnsiHex(metrics[font], text)}> Tj ET`,
          );
        },
        rect: ([x, y, width, height], lineWidth) =>
          content.push(`q 0 0 0 RG ${lineWidth} w ${x} ${y} ${width} ${height} re S Q`),
        image: ([x, y, width, height]) => {
          usesImage = true;
          content.push(`q ${width} 0 0 ${height} ${x} ${y} cm /Im1 Do Q`);
        },
        link: (uri, rect, linkOptions) =>
          links.push({
            uri,
            rect,
            hex: linkOptions?.hex === true,
            indirectAction: linkOptions?.indirectAction === true,
          }),
        width: (text, size, font = "Helvetica") => textWidth(metrics[font], text, size),
      });
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
      for (const font of usedFonts) {
        const ref = fontRef(font);
        operations.push({
          op: "addResource",
          pageIndex,
          category: "Font",
          name: FONT_RESOURCES[font],
          value: `${ref.number} 0 R`,
        });
      }
      if (usesImage) {
        if (imageRef === undefined) {
          imageRef = allocate();
          operations.push({ op: "png", ref: imageRef, softMaskRef: allocate(), png: MINIMAL_PNG });
        }
        operations.push({
          op: "addResource",
          pageIndex,
          category: "XObject",
          name: "Im1",
          value: `${imageRef.number} 0 R`,
        });
      }
      if (content.length > 0) {
        operations.push({
          op: "appendContent",
          pageIndex,
          ref: allocate(),
          data: encoder.encode(content.join("\n")),
          compress: true,
        });
      }
      for (const link of links) {
        const action = `<< /S /URI /URI ${link.hex ? `<${utf16Hex(link.uri)}>` : literal(link.uri)} >>`;
        const actionRef = link.indirectAction ? allocate() : undefined;
        if (actionRef !== undefined) {
          operations.push({ op: "setObject", ref: actionRef, value: action });
        }
        const annotation = allocate();
        operations.push(
          {
            op: "setObject",
            ref: annotation,
            value: `<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(" ")}] /Border [0 0 0] /A ${
              actionRef === undefined ? action : `${actionRef.number} 0 R`
            } >>`,
          },
          { op: "append", target, key: "Annots", value: `${annotation.number} 0 R` },
        );
      }
    }
    return yield* core.edit(created, operations, {
      mode: "rewrite",
      ...(options.objectStreams === true ? { objectStreams: true } : {}),
    });
  });

const writeFixture = (name: string, bytes: Uint8Array): void => {
  const target = join(PDF_CORE_FIXTURES_DIR, name);
  writeFileSync(target, bytes);
};

const buildHelveticaWinansi = buildPdf([
  {
    draw: (painter) => {
      const lines = [
        "Declaração de habilitação — corpus SignatureKit",
        "Ação, coração, situação e à margem do edital.",
        "CPF 123.456.789-09 e CNPJ 12.345.678/0001-95.",
        "Âncoras [[licitei-assinatura]] e {{signature}}.",
      ];
      let y = 720;
      for (const [index, line] of lines.entries()) {
        const size = index === 0 ? 16 : 12;
        painter.text(line, {
          x: 72,
          y,
          size,
          font: index === 0 ? "Helvetica-Bold" : "Helvetica",
          color: [0.1, 0.1, 0.1],
        });
        y -= size + 10;
      }
    },
  },
]);

const requireFromModule = createRequire(import.meta.url);

const liberationFontPath = (): string => {
  const pdfjsPackage = requireFromModule.resolve("pdfjs-dist/package.json");
  return join(dirname(pdfjsPackage), "standard_fonts", "LiberationSans-Regular.ttf");
};

const buildReactPdfDeclaration = async (): Promise<Uint8Array> => {
  Font.register({
    family: "Liberation",
    src: liberationFontPath(),
  });
  const styles = StyleSheet.create({
    page: { padding: 48, fontSize: 11, fontFamily: "Helvetica" },
    title: { fontSize: 16, marginBottom: 12, fontFamily: "Helvetica-Bold" },
    paragraph: { marginBottom: 8, lineHeight: 1.4 },
    embedded: { fontFamily: "Liberation", marginBottom: 8 },
    anchorRow: { width: 300 },
    anchor: { fontSize: 4, color: "#ffffff" },
  });
  const body = React.createElement(
    Document,
    { creationDate: CORPUS_CREATION_DATE },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      React.createElement(Text, { style: styles.title }, "Declaração de Habilitação"),
      React.createElement(
        Text,
        { style: styles.paragraph },
        "Declaro, sob as penas da lei, que atendo às condições de habilitação exigidas no edital, com ênfase em documentação, qualificação técnica e regularidade fiscal.",
      ),
      React.createElement(
        Text,
        { style: styles.embedded },
        "Texto com fonte incorporada: ção, ênfase, à disposição.",
      ),
      React.createElement(
        View,
        { style: styles.anchorRow },
        React.createElement(Text, { style: styles.anchor }, "[[licitei-assinatura]]"),
      ),
      React.createElement(
        Text,
        { style: styles.paragraph },
        "Local e data: Curitiba, 15 de janeiro de 2024.",
      ),
    ),
  );
  return new Uint8Array(await renderToBuffer(body));
};

const buildRotatedCropped = buildPdf(
  [90, 270].map((rotation) => ({
    rotate: rotation,
    cropBox: [72, 72, PAGE_SIZE[0], PAGE_SIZE[1]],
    draw: (painter: Painter) => {
      painter.text(`Página com rotação ${rotation}°`, { x: 120, y: 420, size: 14 });
      painter.link(LINK_FIXTURE_URIS.rotated, [100, 360, 320, 390]);
    },
  })),
);

const buildLinks = buildPdf([
  {
    draw: (painter) => {
      painter.text("Documento de links para âncoras URI.", { x: 72, y: 700, size: 12 });
      painter.link(LINK_FIXTURE_URIS.primary, [72, 620, 280, 650]);
      painter.link(LINK_FIXTURE_URIS.secondary, [72, 560, 280, 590]);
      painter.link(LINK_FIXTURE_URIS.indirect, [72, 500, 280, 530], { indirectAction: true });
    },
  },
]);

const habilitacaoParagraph = (pageIndex: number): string => {
  const topics = [
    "qualificação técnica",
    "regularidade fiscal",
    "capacidade operacional",
    "documentação complementar",
  ];
  const topic = topics[pageIndex % topics.length] ?? topics[0];
  return `Página ${pageIndex + 1}: bloco sobre ${topic}, com referência ao edital e à execução contratual em conformidade com a Lei 14.133/2021.`;
};

const wrapWords = (
  text: string,
  width: (candidate: string) => number,
  maxWidth: number,
): string[] => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && width(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
};

const buildHabilitacao150 = buildPdf(
  Array.from({ length: 150 }, (_, pageIndex) => ({
    draw: (painter: Painter) => {
      painter.text(`Habilitação — folha ${pageIndex + 1}`, {
        x: 72,
        y: 730,
        size: 12,
        font: "Helvetica-Bold",
      });
      wrapWords(habilitacaoParagraph(pageIndex), (line) => painter.width(line, 10), 468).forEach(
        (line, index) => painter.text(line, { x: 72, y: 700 - index * 12, size: 10 }),
      );
      if (pageIndex % 12 === 5) {
        for (let row = 0; row < 4; row += 1) {
          for (let col = 0; col < 3; col += 1) {
            const x = 72 + col * 150;
            const y = 520 - row * 50;
            painter.rect([x, y, 130, 30], 0.5);
            painter.text(`C${col + 1}R${row + 1}`, { x: x + 6, y: y + 10, size: 9 });
          }
        }
      }
      if (pageIndex % 25 === 12) {
        const scale = 80 + (pageIndex % 40);
        painter.image([360, 220, scale, scale]);
      }
      if (pageIndex === 149) {
        painter.text("Âncora [[licitei-assinatura]] na última página.", {
          x: 72,
          y: 120,
          size: 11,
        });
      }
    },
  })),
);

const buildObjectStreams = buildPdf(
  [
    {
      draw: (painter) =>
        painter.text("PDF salvo com object streams e xref stream.", { x: 72, y: 700, size: 12 }),
    },
  ],
  { objectStreams: true },
);

const buildIncrementalUpdate = Effect.gen(function* () {
  const core = yield* PdfCore;
  const metrics = yield* loadMetrics;
  const base = yield* buildPdf([
    {
      draw: (painter) => painter.text("Versão original do documento.", { x: 72, y: 700, size: 12 }),
    },
  ]);
  const { nextObjectNumber } = yield* core.document(base);
  const font = { number: nextObjectNumber, generation: 0 };
  return yield* core.edit(
    base,
    [
      { op: "standardFont", ref: font, baseFont: "Helvetica" },
      {
        op: "addResource",
        pageIndex: 0,
        category: "Font",
        name: "F9",
        value: `${font.number} 0 R`,
      },
      {
        op: "appendContent",
        pageIndex: 0,
        ref: { number: nextObjectNumber + 1, generation: 0 },
        wrapRef: { number: nextObjectNumber + 2, generation: 0 },
        data: encoder.encode(
          `BT /F9 12 Tf 72 660 Td <${winAnsiHex(metrics.Helvetica, "Texto alterado por atualização incremental.")}> Tj ET`,
        ),
        compress: true,
      },
    ],
    { mode: "incremental" },
  );
});

const drawJustified = (
  painter: Painter,
  lines: ReadonlyArray<string>,
  options: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly size: number;
    readonly leading: number;
  },
): void => {
  const { x, y, width, size, leading } = options;
  for (const [index, line] of lines.entries()) {
    const baseline = y - index * leading;
    const words = line.split(" ");
    if (index === lines.length - 1 || words.length < 2) {
      painter.text(line, { x, y: baseline, size });
      continue;
    }
    const extra = (width - painter.width(line, size)) / (words.length - 1);
    let cursor = x;
    for (const word of words) {
      painter.text(word, { x: cursor, y: baseline, size });
      cursor += painter.width(`${word} `, size) + extra;
    }
  }
};

const buildMarkdownBasics = buildPdf([
  {
    draw: (painter) => {
      painter.text("1. INFORMAÇÕES GERAIS", { x: 72, y: 720, size: 14, font: "Helvetica-Bold" });
      let cursor = 72;
      for (const [text, font] of [
        ["Texto de corpo com destaque ", "Helvetica"],
        ["CONCORRÊNCIA", "Helvetica-Bold"],
        [" aberta.", "Helvetica"],
      ] satisfies ReadonlyArray<readonly [string, FontName]>) {
        painter.text(text, { x: cursor, y: 690, size: 11, font });
        cursor += painter.width(text, 11, font);
      }
      painter.text("• primeiro item", { x: 72, y: 660, size: 11 });
      painter.text("• segundo item", { x: 72, y: 642, size: 11 });
      painter.text("1.1. cláusula numerada permanece parágrafo.", {
        x: 72,
        y: 614,
        size: 11,
        font: "Helvetica-Oblique",
      });
      painter.link("https://signature-kit.dev/corpus/markdown-link", [72, 520, 260, 540]);
      painter.text("Link para documentação", { x: 72, y: 528, size: 11 });
      for (let row = 0; row < 2; row += 1) {
        for (let col = 0; col < 2; col += 1) {
          painter.rect([72 + col * 150, 440 - row * 28, 150, 28], 0.5);
        }
      }
      painter.text("Item", { x: 78, y: 450, size: 10, font: "Helvetica-Bold" });
      painter.text("Qtd", { x: 228, y: 450, size: 10, font: "Helvetica-Bold" });
      painter.text("Areia", { x: 78, y: 422, size: 10 });
      painter.text("4", { x: 228, y: 422, size: 10 });
    },
  },
]);

const HYPHENATED_PARAGRAPHS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "A planilha orçamentária contempla toda a mão-de-",
    "obra direta, os encargos sociais, os insumos e o",
    "apoio técnico e o custo do suporte administra-",
    "tivo aprovado pela comissão.",
  ],
  [
    "Caso a garantia seja exigida, a contratada deverá apresentá-",
    "lo em até cinco dias úteis, preservado o bem-estar dos",
    "trabalhadores.",
  ],
];

const buildMarkdownHyphenation = buildPdf([
  {
    draw: (painter) => {
      const size = 11;
      const width = Math.max(
        ...HYPHENATED_PARAGRAPHS.flatMap((lines) =>
          lines.slice(0, -1).map((line) => painter.width(line, size)),
        ),
      );
      let y = 700;
      for (const lines of HYPHENATED_PARAGRAPHS) {
        drawJustified(painter, lines, { x: 72, y, width, size, leading: 14 });
        y -= lines.length * 14 + 14;
      }
    },
  },
]);

const MARKDOWN_PAGE_BODIES: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>> = [
  [
    ["O presente edital trata da contratação de serviços contínuos de", "manutenção predial."],
    [
      "A proposta deve considerar a mão-de-obra, os encargos e os insumos",
      "necessários à execução dos serviços, sem interrup-",
    ],
  ],
  [["ção contratual, durante toda a vigência do contrato."], ["Segundo parágrafo da página dois."]],
];

const buildMarkdownPageContinue = buildPdf(
  MARKDOWN_PAGE_BODIES.map((paragraphs, index) => ({
    draw: (painter: Painter) => {
      const total = MARKDOWN_PAGE_BODIES.length;
      painter.text(`EDITAL Nº 7/2026 — PÁGINA ${index + 1} DE ${total}`, {
        x: 72,
        y: 760,
        size: 9,
        font: "Helvetica-Oblique",
      });
      painter.text(`Licitei — corpus markdown — ${index + 1}/${total}`, {
        x: 72,
        y: 40,
        size: 9,
        font: "Helvetica-Oblique",
      });
      let y = 700;
      for (const lines of paragraphs) {
        for (const line of lines) {
          painter.text(line, { x: 72, y, size: 11 });
          y -= 14;
        }
        y -= 12;
      }
    },
  })),
);

const NESTED_LIST_LINES: ReadonlyArray<readonly [number, number, string]> = [
  [72, 720, "• Documentos de habilitação:"],
  [90, 704, "– certidão negativa de débitos;"],
  [90, 688, "– balanço patrimonial."],
  [72, 672, "• Proposta comercial."],
  [72, 646, "1. Prazo de entrega"],
  [72, 630, "2. Local de entrega:"],
  [90, 614, "a) almoxarifado central;"],
  [90, 598, "b) unidade de saúde."],
  [72, 582, "3. Forma de pagamento"],
  [72, 556, "I - habilitação jurídica;"],
  [72, 540, "II - qualificação técnica."],
];

const buildMarkdownNestedLists = buildPdf([
  {
    draw: (painter) => {
      for (const [x, y, line] of NESTED_LIST_LINES) painter.text(line, { x, y, size: 11 });
    },
  },
]);

const TWO_COLUMN_TEXT: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "A coluna da esquerda começa com um parágrafo que ocupa algumas linhas de texto corrido sem interrupção até o ponto final.",
    "Segundo parágrafo à esquerda.",
  ],
  [
    "A coluna da direita traz outro texto independente, que também segue em linhas paralelas às da coluna esquerda.",
    "Segundo parágrafo à direita.",
  ],
];

const buildMarkdownTwoColumn = buildPdf([
  {
    draw: (painter) => {
      const size = 10;
      const width = 230;
      for (const [column, paragraphs] of TWO_COLUMN_TEXT.entries()) {
        const x = 72 + column * (width + 20);
        let y = 700;
        for (const paragraph of paragraphs) {
          for (const line of wrapWords(
            paragraph,
            (candidate) => painter.width(candidate, size),
            width,
          )) {
            painter.text(line, { x, y, size });
            y -= 13;
          }
          y -= 10;
        }
      }
    },
  },
]);

const buildMarkdownHeadingsReact = async (): Promise<Uint8Array> => {
  const styles = StyleSheet.create({
    page: { padding: 48, fontFamily: "Helvetica" },
    title: { fontSize: 20, marginBottom: 10, fontFamily: "Helvetica-Bold" },
    h2: { fontSize: 16, marginBottom: 8, fontFamily: "Helvetica-Bold" },
    h3: { fontSize: 13, marginBottom: 6, fontFamily: "Helvetica-Bold" },
    body: { fontSize: 11, marginBottom: 6, lineHeight: 1.3 },
    link: { fontSize: 11, color: "#0b57d0" },
  });
  const body = React.createElement(
    Document,
    { creationDate: CORPUS_CREATION_DATE },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      React.createElement(Text, { style: styles.title }, "Título sem numeração"),
      React.createElement(Text, { style: styles.h2 }, "1. Seção principal"),
      React.createElement(Text, { style: styles.h3 }, "1.1. Subseção"),
      React.createElement(
        Text,
        { style: styles.body },
        "Corpo com ",
        React.createElement(Text, { style: { fontFamily: "Helvetica-Bold" } }, "negrito"),
        " e ",
        React.createElement(Text, { style: { fontFamily: "Helvetica-Oblique" } }, "itálico"),
        " no mesmo parágrafo.",
      ),
      React.createElement(
        Link,
        { src: "https://signature-kit.dev/corpus/headings-link", style: styles.link },
        "Documentação",
      ),
    ),
  );
  return new Uint8Array(await renderToBuffer(body));
};

type RawObject = string | { readonly dict: string; readonly data: Uint8Array };

const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const rawPdf = (objects: ReadonlyArray<RawObject>): Uint8Array => {
  const parts: Array<Uint8Array> = [bytesOf("%PDF-1.7\n%âãÏÓ\n")];
  let length = parts[0]?.byteLength ?? 0;
  const offsets: Array<number> = [];
  const push = (part: Uint8Array): void => {
    parts.push(part);
    length += part.byteLength;
  };
  objects.forEach((object, index) => {
    offsets.push(length);
    push(bytesOf(`${index + 1} 0 obj\n`));
    if (typeof object === "string") {
      push(bytesOf(object));
    } else {
      push(bytesOf(`<< ${object.dict} /Length ${object.data.byteLength} >>\nstream\n`));
      push(object.data);
      push(bytesOf("\nendstream"));
    }
    push(bytesOf("\nendobj\n"));
  });
  const xref = length;
  push(
    bytesOf(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return concatBytes(parts);
};

type RenderPage = {
  readonly content: string;
  readonly resources: string;
  readonly rotate?: number;
  readonly size?: readonly [number, number];
};

const renderPdf = (
  pages: ReadonlyArray<RenderPage>,
  extra: ReadonlyArray<RawObject>,
  catalog = "",
): Uint8Array => {
  const first = 3 + extra.length;
  const kids = pages.map((_, index) => `${first + index * 2} 0 R`).join(" ");
  const objects: Array<RawObject> = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    ...extra,
  ];
  pages.forEach((page, index) => {
    const [width, height] = page.size ?? [200, 200];
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${page.rotate ?? 0} /Resources ${page.resources} /Contents ${first + index * 2 + 1} 0 R >>`,
    );
    objects.push({ dict: "", data: bytesOf(page.content) });
  });
  return rawPdf(objects);
};

const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 24;
  };
};

const buildRenderImages = (): Uint8Array => {
  const rgb = Uint8Array.from(
    { length: 4 * 4 * 3 },
    (_, index) => [255, 0, 0, 0, 160, 0, 0, 0, 255, 250, 200, 0][index % 12] ?? 0,
  );
  const gray = Uint8Array.from(
    { length: 8 * 8 },
    (_, index) => (index % 8) * 32 + (index >> 3) * 4,
  );
  const indexed = Uint8Array.from({ length: 2 * 4 }, (_, index) => [0x01, 0x23][index % 2] ?? 0);
  return renderPdf(
    [
      {
        resources: "<< /XObject << /Rgb 3 0 R /Gray 4 0 R /Pal 5 0 R >> >>",
        content:
          "q 80 0 0 80 10 110 cm /Rgb Do Q q 80 0 0 80 110 110 cm /Gray Do Q q 180 0 0 80 10 10 cm /Pal Do Q",
      },
    ],
    [
      {
        dict: "/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8",
        data: rgb,
      },
      {
        dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8",
        data: gray,
      },
      {
        dict: "/Type /XObject /Subtype /Image /Width 4 /Height 2 /ColorSpace [/Indexed /DeviceRGB 3 <ff000000ff000000ff202020>] /BitsPerComponent 4",
        data: indexed,
      },
    ],
  );
};

const buildRenderMasks = (): Uint8Array => {
  const rgb = Uint8Array.from({ length: 8 * 8 * 3 }, (_, index) =>
    index % 3 === 2 ? 200 : index % 3 === 0 ? 30 : 90,
  );
  const alpha = Uint8Array.from({ length: 8 * 8 }, (_, index) => Math.min(255, (index % 8) * 36));
  const checker = Uint8Array.from({ length: 8 }, (_, row) => (row % 2 === 0 ? 0x55 : 0xaa));
  const stencil = Uint8Array.from({ length: 16 * 2 }, (_, index) =>
    Math.floor(index / 2) % 4 < 2 ? 0x0f : 0xf0,
  );
  return renderPdf(
    [
      {
        resources:
          "<< /XObject << /Soft 3 0 R /Hard 5 0 R /Stencil 7 0 R >> /ExtGState << /Half << /ca 0.5 >> >> >>",
        content:
          "0.9 0.9 0.2 rg 0 0 200 200 re f q 80 0 0 80 10 110 cm /Soft Do Q q 80 0 0 80 110 110 cm /Hard Do Q q /Half gs 0.8 0 0 rg 160 0 0 80 20 10 cm /Stencil Do Q",
      },
    ],
    [
      {
        dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 4 0 R",
        data: rgb,
      },
      {
        dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8",
        data: alpha,
      },
      {
        dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Mask 6 0 R",
        data: rgb.map((value) => 255 - value),
      },
      { dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true", data: checker },
      {
        dict: "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ImageMask true /BitsPerComponent 1",
        data: stencil,
      },
    ],
  );
};

const WHITE_CODES: ReadonlyArray<readonly [number, number]> = [
  [8, 0x35],
  [6, 0x07],
  [4, 0x07],
  [4, 0x08],
  [4, 0x0b],
  [4, 0x0c],
  [4, 0x0e],
  [4, 0x0f],
  [5, 0x13],
  [5, 0x14],
  [5, 0x07],
  [5, 0x08],
  [6, 0x08],
  [6, 0x03],
  [6, 0x34],
  [6, 0x35],
  [6, 0x2a],
  [6, 0x2b],
  [7, 0x27],
  [7, 0x0c],
  [7, 0x08],
  [7, 0x17],
  [7, 0x03],
  [7, 0x04],
  [7, 0x28],
  [7, 0x2b],
  [7, 0x13],
  [7, 0x24],
  [7, 0x18],
  [8, 0x02],
  [8, 0x03],
  [8, 0x1a],
  [8, 0x1b],
  [8, 0x12],
  [8, 0x13],
  [8, 0x14],
  [8, 0x15],
  [8, 0x16],
  [8, 0x17],
  [8, 0x28],
  [8, 0x29],
  [8, 0x2a],
  [8, 0x2b],
  [8, 0x2c],
  [8, 0x2d],
  [8, 0x04],
  [8, 0x05],
  [8, 0x0a],
  [8, 0x0b],
  [8, 0x52],
  [8, 0x53],
  [8, 0x54],
  [8, 0x55],
  [8, 0x24],
  [8, 0x25],
  [8, 0x58],
  [8, 0x59],
  [8, 0x5a],
  [8, 0x5b],
  [8, 0x4a],
  [8, 0x4b],
  [8, 0x32],
  [8, 0x33],
  [8, 0x34],
];
const BLACK_CODES: ReadonlyArray<readonly [number, number]> = [
  [10, 0x37],
  [3, 0x02],
  [2, 0x03],
  [2, 0x02],
  [3, 0x03],
  [4, 0x03],
  [4, 0x02],
  [5, 0x03],
  [6, 0x05],
  [6, 0x04],
  [7, 0x04],
  [7, 0x05],
  [7, 0x07],
  [8, 0x04],
  [8, 0x07],
  [9, 0x18],
  [10, 0x17],
  [10, 0x18],
  [10, 0x08],
  [11, 0x67],
  [11, 0x68],
  [11, 0x6c],
  [11, 0x37],
  [11, 0x28],
  [11, 0x17],
  [11, 0x18],
  [12, 0xca],
  [12, 0xcb],
  [12, 0xcc],
  [12, 0xcd],
  [12, 0x68],
  [12, 0x69],
  [12, 0x6a],
  [12, 0x6b],
  [12, 0xd2],
  [12, 0xd3],
  [12, 0xd4],
  [12, 0xd5],
  [12, 0xd6],
  [12, 0xd7],
  [12, 0x6c],
  [12, 0x6d],
  [12, 0xda],
  [12, 0xdb],
  [12, 0x54],
  [12, 0x55],
  [12, 0x56],
  [12, 0x57],
  [12, 0x64],
  [12, 0x65],
  [12, 0x52],
  [12, 0x53],
  [12, 0x24],
  [12, 0x37],
  [12, 0x38],
  [12, 0x27],
  [12, 0x28],
  [12, 0x58],
  [12, 0x59],
  [12, 0x2b],
  [12, 0x2c],
  [12, 0x5a],
  [12, 0x66],
  [12, 0x67],
];

const group4 = (rows: ReadonlyArray<ReadonlyArray<boolean>>): Uint8Array => {
  const bits: Array<number> = [];
  const write = ([length, code]: readonly [number, number]): void => {
    for (let bit = length - 1; bit >= 0; bit -= 1) bits.push((code >> bit) & 1);
  };
  for (const row of rows) {
    const runs: Array<number> = [];
    let color = false;
    let run = 0;
    for (const black of row) {
      if (black === color) {
        run += 1;
      } else {
        runs.push(run);
        color = black;
        run = 1;
      }
    }
    runs.push(run);
    if (runs.length % 2 === 1) runs.push(0);
    for (let index = 0; index < runs.length; index += 2) {
      write([3, 0x01]);
      write(WHITE_CODES[runs[index] ?? 0] ?? [8, 0x35]);
      write(BLACK_CODES[runs[index + 1] ?? 0] ?? [10, 0x37]);
    }
  }
  write([12, 0x001]);
  write([12, 0x001]);
  while (bits.length % 8 !== 0) bits.push(0);
  return Uint8Array.from({ length: bits.length / 8 }, (_, byte) =>
    bits.slice(byte * 8, byte * 8 + 8).reduce((value, bit) => (value << 1) | bit, 0),
  );
};

const buildRenderCcitt = (): Uint8Array => {
  const rows = Array.from({ length: 24 }, (_, y) =>
    Array.from(
      { length: 48 },
      (_, x) => (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 || x === y,
    ),
  );
  return renderPdf(
    [
      {
        resources: "<< /XObject << /Fax 3 0 R >> >>",
        content: "q 192 0 0 96 4 52 cm /Fax Do Q",
      },
    ],
    [
      {
        dict: "/Type /XObject /Subtype /Image /Width 48 /Height 24 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 48 /Rows 24 >>",
        data: group4(rows),
      },
    ],
  );
};

const buildRenderShadings = (): Uint8Array =>
  renderPdf(
    [
      {
        resources:
          "<< /Shading << /Ax << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [10 0 190 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >> /Rad << /ShadingType 3 /ColorSpace /DeviceRGB /Coords [100 50 0 100 50 45] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 0] /C1 [0 0.5 0] /N 1 >> /Extend [false true] >> >> /Pattern << /P0 << /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 150 0 190] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> /Extend [true true] >> >> >> >>",
        content:
          "q 10 110 180 30 re W n /Ax sh Q q 10 10 180 90 re W n /Rad sh Q /Pattern cs /P0 scn 10 150 180 40 re f",
      },
    ],
    [],
  );

const buildRenderType3 = (): Uint8Array =>
  renderPdf(
    [
      {
        resources: "<< /Font << /T3 3 0 R >> >>",
        content: "BT /T3 40 Tf 0 0 0.8 rg 10 120 Td (ABAB) Tj 0.8 0 0 rg 0 -80 Td (BBA) Tj ET",
      },
    ],
    [
      "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /box 4 0 R /tri 5 0 R >> /Encoding << /Type /Encoding /Differences [65 /box /tri] >> /FirstChar 65 /LastChar 66 /Widths [1000 1000] /Resources << >> >>",
      { dict: "", data: bytesOf("1000 0 0 0 900 900 d1 50 50 800 800 re f") },
      { dict: "", data: bytesOf("1000 0 0 0 900 900 d1 50 50 m 850 50 l 450 850 l f") },
    ],
  );

const charstringNumber = (value: number): Array<number> => {
  if (value >= -107 && value <= 107) return [value + 139];
  if (value >= 108 && value <= 1131) {
    const shifted = value - 108;
    return [Math.floor(shifted / 256) + 247, shifted % 256];
  }
  const shifted = -value - 108;
  return [Math.floor(shifted / 256) + 251, shifted % 256];
};

const charstring = (program: ReadonlyArray<CharstringItem>): Array<number> =>
  program.flatMap((item) => (typeof item === "number" ? charstringNumber(item) : [item[0]]));

const cffIndex = (items: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  if (items.length === 0) return [0, 0];
  const out = [items.length >> 8, items.length & 0xff, 4];
  let offset = 1;
  const pushOffset = (value: number): void => {
    out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  };
  pushOffset(offset);
  for (const item of items) {
    offset += item.length;
    pushOffset(offset);
  }
  for (const item of items) out.push(...item);
  return out;
};

const dictInt = (value: number): Array<number> => [
  29,
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

type CharstringItem = number | readonly [number];

const BOX_GLYPH: ReadonlyArray<CharstringItem> = [100, 0, [21], 500, [6], 700, [7], -500, [6]];
const TRIANGLE_GLYPH: ReadonlyArray<CharstringItem> = [100, 0, [21], 500, 0, -250, 700, [5]];

const buildCff = (): Uint8Array => {
  const header = [1, 0, 4, 4];
  const names = cffIndex([Array.from(bytesOf("TestCFF"))]);
  const strings = cffIndex([]);
  const globals = cffIndex([]);
  const charstrings = cffIndex([
    charstring([[14]]),
    charstring([600, ...BOX_GLYPH, [14]]),
    charstring([600, ...TRIANGLE_GLYPH, [14]]),
  ]);
  const privateDict = [...charstringNumber(0), 20, ...charstringNumber(0), 21];
  const charset = [0, 0, 34, 0, 35];
  const topDict = (charsetAt: number, charstringsAt: number, privateAt: number): Array<number> => [
    ...dictInt(charsetAt),
    15,
    ...dictInt(charstringsAt),
    17,
    ...dictInt(privateDict.length),
    ...dictInt(privateAt),
    18,
    ...charstringNumber(0),
    ...charstringNumber(0),
    ...charstringNumber(1000),
    ...charstringNumber(1000),
    5,
  ];
  const topIndexLength = cffIndex([topDict(0, 0, 0)]).length;
  const charsetAt = header.length + names.length + topIndexLength + strings.length + globals.length;
  const charstringsAt = charsetAt + charset.length;
  const privateAt = charstringsAt + charstrings.length;
  const top = topDict(charsetAt, charstringsAt, privateAt);
  return Uint8Array.from([
    ...header,
    ...names,
    ...cffIndex([top]),
    ...strings,
    ...globals,
    ...charset,
    ...charstrings,
    ...privateDict,
  ]);
};

const encrypt = (plain: Uint8Array, key: number): Uint8Array => {
  let state = key;
  return plain.map((byte) => {
    const cipher = byte ^ (state >> 8);
    state = ((cipher + state) * 52845 + 22719) & 0xffff;
    return cipher;
  });
};

const buildType1 = (): {
  readonly data: Uint8Array;
  readonly clear: number;
  readonly binary: number;
} => {
  const glyph = (program: ReadonlyArray<CharstringItem>): Uint8Array =>
    encrypt(Uint8Array.from([0, 0, 0, 0, ...charstring(program)]), 4330);
  const notdef = glyph([0, 600, [13], [14]]);
  const box = glyph([0, 600, [13], ...BOX_GLYPH, [9], [14]]);
  const triangle = glyph([0, 600, [13], 100, 0, [21], 500, 0, [5], -250, 700, [5], [9], [14]]);
  const clear = bytesOf(
    "%!PS-AdobeFont-1.0: TestType1 001.000\n12 dict begin\n/FontName /TestType1 def\n/FontType 1 def\n/PaintType 0 def\n/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n/FontBBox {0 0 1000 1000} readonly def\n/Encoding StandardEncoding def\ncurrentdict end\ncurrentfile eexec\n",
  );
  const entry = (name: string, data: Uint8Array): Uint8Array =>
    concatBytes([bytesOf(`/${name} ${data.byteLength} RD `), data, bytesOf(" ND\n")]);
  const priv = concatBytes([
    Uint8Array.from([0, 0, 0, 0]),
    bytesOf(
      "dup /Private 8 dict dup begin\n/RD{string currentfile exch readstring pop}executeonly def\n/ND{noaccess def}executeonly def\n/NP{noaccess put}executeonly def\n/lenIV 4 def\n/BlueValues [] def\n/MinFeature {16 16} def\n/password 5839 def\n/Subrs 0 array\nND\n2 index /CharStrings 3 dict dup begin\n",
    ),
    entry(".notdef", notdef),
    entry("A", box),
    entry("B", triangle),
    bytesOf(
      "end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n",
    ),
  ]);
  const binary = encrypt(priv, 55665);
  return { data: concatBytes([clear, binary]), clear: clear.byteLength, binary: binary.byteLength };
};

const buildRenderEmbeddedFonts = (): Uint8Array => {
  const type1 = buildType1();
  return renderPdf(
    [
      {
        resources: "<< /Font << /C 3 0 R /T 6 0 R >> >>",
        content:
          "BT /C 60 Tf 0 0.3 0.6 rg 10 120 Td (ABBA) Tj ET BT /T 60 Tf 0.5 0 0.2 rg 10 30 Td (BAAB) Tj ET",
      },
    ],
    [
      "<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+TestCFF /FirstChar 65 /LastChar 66 /Widths [600 600] /Encoding /WinAnsiEncoding /FontDescriptor 4 0 R >>",
      "<< /Type /FontDescriptor /FontName /AAAAAA+TestCFF /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 700 /StemV 80 /FontFile3 5 0 R >>",
      { dict: "/Subtype /Type1C", data: buildCff() },
      "<< /Type /Font /Subtype /Type1 /BaseFont /BBBBBB+TestType1 /FirstChar 65 /LastChar 66 /Widths [600 600] /Encoding /WinAnsiEncoding /FontDescriptor 7 0 R >>",
      "<< /Type /FontDescriptor /FontName /BBBBBB+TestType1 /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 700 /StemV 80 /FontFile 8 0 R >>",
      {
        dict: `/Length1 ${type1.clear} /Length2 ${type1.binary} /Length3 0`,
        data: type1.data,
      },
    ],
  );
};

const buildRenderQr = (): Uint8Array => {
  const size = 21;
  const next = seeded(7);
  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [14, 0],
    [0, 14],
  ];
  const finder = (x: number, y: number): boolean | undefined => {
    for (const [left, top] of corners) {
      const dx = x - left;
      const dy = y - top;
      if (dx >= 0 && dx < 7 && dy >= 0 && dy < 7) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        return ring !== 2;
      }
    }
    return undefined;
  };
  const rowBytes = Math.ceil(size / 8);
  const data = new Uint8Array(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = finder(x, y) ?? next() % 2 === 0;
      const at = y * rowBytes + (x >> 3);
      if (!dark) data[at] = (data[at] ?? 0) | (0x80 >> (x & 7));
    }
  }
  return renderPdf(
    [
      {
        resources: "<< /XObject << /Qr 3 0 R >> >>",
        content: "q 189 0 0 189 5.5 5.5 cm /Qr Do Q",
      },
    ],
    [
      {
        dict: `/Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 1`,
        data,
      },
    ],
  );
};

const ROTATED_CONTENT =
  "0 0 0.7 rg 20 20 60 120 re f 0.8 0.2 0 RG 4 w 100 30 m 180 170 l S q 40 0 0 40 120 120 cm /Im Do Q";

const buildRenderRotated = (): Uint8Array =>
  renderPdf(
    [90, 180, 270].map((rotate): RenderPage => ({
      rotate,
      size: [200, 160],
      resources: "<< /XObject << /Im 3 0 R >> >>",
      content: ROTATED_CONTENT,
    })),
    [
      {
        dict: "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8",
        data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
      },
    ],
  );

const buildRenderOptionalContent = (): Uint8Array =>
  renderPdf(
    [
      {
        resources: "<< /Properties << /Off 3 0 R /On 4 0 R >> /XObject << /Hidden 5 0 R >> >>",
        content:
          "/OC /Off BDC 1 0 0 rg 10 10 180 80 re f EMC /OC /On BDC 0 0.6 0 rg 10 110 180 80 re f EMC /Hidden Do",
      },
    ],
    [
      "<< /Type /OCG /Name (Off) >>",
      "<< /Type /OCG /Name (On) >>",
      {
        dict: "/Type /XObject /Subtype /Form /BBox [0 0 200 200] /OC 3 0 R",
        data: bytesOf("0 0 1 rg 50 50 100 100 re f"),
      },
    ],
    "/OCProperties << /OCGs [3 0 R 4 0 R] /D << /OFF [3 0 R] >> >>",
  );

const RENDER_FIXTURES: ReadonlyArray<readonly [string, () => Uint8Array]> = [
  ["images.pdf", buildRenderImages],
  ["masks.pdf", buildRenderMasks],
  ["ccitt-g4.pdf", buildRenderCcitt],
  ["shadings.pdf", buildRenderShadings],
  ["type3.pdf", buildRenderType3],
  ["embedded-fonts.pdf", buildRenderEmbeddedFonts],
  ["qr-upscaled.pdf", buildRenderQr],
  ["rotated.pdf", buildRenderRotated],
  ["optional-content.pdf", buildRenderOptionalContent],
];

const corruptStartxref = (bytes: Uint8Array): Uint8Array => {
  const needle = encoder.encode("startxref");
  let at = -1;
  outer: for (let index = bytes.byteLength - needle.byteLength; index >= 0; index -= 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    at = index;
    break;
  }
  if (at < 0) return bytes;
  let lineBreak = -1;
  for (let index = at + needle.byteLength; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) {
      lineBreak = index;
      break;
    }
  }
  if (lineBreak < 0) return bytes;
  let offsetEnd = lineBreak + 1;
  while (offsetEnd < bytes.byteLength && bytes[offsetEnd] !== 0x0a) offsetEnd += 1;
  const replacement = encoder.encode("999999999");
  const out = new Uint8Array(
    bytes.byteLength - (offsetEnd - (lineBreak + 1)) + replacement.byteLength,
  );
  out.set(bytes.subarray(0, lineBreak + 1));
  out.set(replacement, lineBreak + 1);
  out.set(bytes.subarray(offsetEnd), lineBreak + 1 + replacement.byteLength);
  return out;
};

const buildBrokenXref = buildPdf([
  {
    draw: (painter) =>
      painter.text("PDF válido com startxref corrompido.", { x: 72, y: 700, size: 12 }),
  },
]).pipe(Effect.map(corruptStartxref));

const program = Effect.gen(function* () {
  mkdirSync(PDF_CORE_FIXTURES_DIR, { recursive: true });
  mkdirSync(join(PDF_CORE_FIXTURES_DIR, "render"), { recursive: true });
  for (const [name, build] of RENDER_FIXTURES) {
    writeFixture(join("render", name), build());
  }
  writeFixture("markdown-basics.pdf", yield* buildMarkdownBasics);
  writeFixture("markdown-hyphenation.pdf", yield* buildMarkdownHyphenation);
  writeFixture("markdown-page-continue.pdf", yield* buildMarkdownPageContinue);
  writeFixture("markdown-nested-lists.pdf", yield* buildMarkdownNestedLists);
  writeFixture("markdown-two-column.pdf", yield* buildMarkdownTwoColumn);
  writeFixture("markdown-headings-react.pdf", yield* Effect.promise(buildMarkdownHeadingsReact));
  writeFixture("helvetica-winansi.pdf", yield* buildHelveticaWinansi);
  writeFixture("react-pdf-declaration.pdf", yield* Effect.promise(buildReactPdfDeclaration));
  writeFixture("takumi-declaration.pdf", yield* Effect.promise(renderTakumiDeclarationPdf));
  writeFixture("rotated-cropped.pdf", yield* buildRotatedCropped);
  writeFixture("links.pdf", yield* buildLinks);
  writeFixture("habilitacao-150.pdf", yield* buildHabilitacao150);
  writeFixture("object-streams.pdf", yield* buildObjectStreams);
  writeFixture("incremental-update.pdf", yield* buildIncrementalUpdate);
  writeFixture("broken-xref.pdf", yield* buildBrokenXref);
  copyFileSync(icpSource, join(PDF_CORE_FIXTURES_DIR, "icp-signed.pdf"));
});

const pdfCoreModule = await WebAssembly.compile(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dist/pdf-core.wasm")),
);

await Effect.runPromise(program.pipe(Effect.provide(pdfCoreLayer(pdfCoreModule))));
