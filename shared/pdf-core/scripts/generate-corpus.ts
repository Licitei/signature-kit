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

const { renderToBuffer, Document, Link, Page, Text, View, Font, StyleSheet } =
  await import("@react-pdf/renderer");
const React = await import("react");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const PAGE_SIZE: readonly [number, number] = [612, 792];
const icpSource = join(repoRoot, "validators/iti/__tests__/fixtures/icp-brasil-ad-rb-signed.pdf");
const encoder = new TextEncoder();

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
    {},
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
    {},
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

const buildBrokenXref = buildPdf([
  {
    draw: (painter) =>
      painter.text("PDF válido com startxref corrompido.", { x: 72, y: 700, size: 12 }),
  },
]).pipe(
  Effect.map((bytes) => {
    const ascii = new TextDecoder("latin1").decode(bytes);
    const startxrefIndex = ascii.lastIndexOf("startxref");
    const lineBreak = startxrefIndex < 0 ? -1 : ascii.indexOf("\n", startxrefIndex);
    if (lineBreak < 0) return bytes;
    const corrupted = `${ascii.slice(0, lineBreak + 1)}999999999\n${ascii.slice(lineBreak + 1)}`;
    return Uint8Array.from(corrupted, (character) => character.charCodeAt(0));
  }),
);

const program = Effect.gen(function* () {
  mkdirSync(PDF_CORE_FIXTURES_DIR, { recursive: true });
  writeFixture("markdown-basics.pdf", yield* buildMarkdownBasics);
  writeFixture("markdown-hyphenation.pdf", yield* buildMarkdownHyphenation);
  writeFixture("markdown-page-continue.pdf", yield* buildMarkdownPageContinue);
  writeFixture("markdown-nested-lists.pdf", yield* buildMarkdownNestedLists);
  writeFixture("markdown-two-column.pdf", yield* buildMarkdownTwoColumn);
  writeFixture("markdown-headings-react.pdf", yield* Effect.promise(buildMarkdownHeadingsReact));
  writeFixture("helvetica-winansi.pdf", yield* buildHelveticaWinansi);
  writeFixture("react-pdf-declaration.pdf", yield* Effect.promise(buildReactPdfDeclaration));
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
