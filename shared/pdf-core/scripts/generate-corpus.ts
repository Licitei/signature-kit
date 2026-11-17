import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PDFFont, PDFPage } from "@cantoo/pdf-lib";

import { LINK_FIXTURE_URIS, PDF_CORE_FIXTURES_DIR } from "../__tests__/corpus.ts";

const { PDFDocument, PDFHexString, PDFString, rgb, StandardFonts } =
  await import("@cantoo/pdf-lib");
const { renderToBuffer, Document, Link, Page, Text, View, Font, StyleSheet } =
  await import("@react-pdf/renderer");
const React = await import("react");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const FIXED_DATE = new Date("2024-01-15T10:30:00.000Z");
const CORPUS_CREATOR = "signature-kit-pdf-core-corpus";
const PAGE_SIZE: readonly [number, number] = [612, 792];
const icpSource = join(repoRoot, "validators/iti/__tests__/fixtures/icp-brasil-ad-rb-signed.pdf");

const MINIMAL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const stampMetadata = (document: PDFDocument): void => {
  document.setTitle("signature-kit-pdf-core-corpus");
  document.setAuthor("Licitei");
  document.setSubject("pdf-core regression corpus");
  document.setCreator(CORPUS_CREATOR);
  document.setProducer(CORPUS_CREATOR);
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
};

const writeFixture = (name: string, bytes: Uint8Array): void => {
  const target = join(PDF_CORE_FIXTURES_DIR, name);
  writeFileSync(target, bytes);
};

const addLinkAnnotation = (
  document: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  uri: string,
  rect: readonly [number, number, number, number],
  options?: { readonly hex?: boolean; readonly indirectAction?: boolean },
): void => {
  const action = document.context.obj({
    S: "URI",
    URI: options?.hex === true ? PDFHexString.fromText(uri) : PDFString.of(uri),
  });
  const annotation = document.context.register(
    document.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [...rect],
      Border: [0, 0, 0],
      A: options?.indirectAction === true ? document.context.register(action) : action,
    }),
  );
  page.node.addAnnot(annotation);
};

const buildHelveticaWinansi = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage(PAGE_SIZE);
  const lines = [
    "Declaração de habilitação — corpus SignatureKit",
    "Ação, coração, situação e à margem do edital.",
    "CPF 123.456.789-09 e CNPJ 12.345.678/0001-95.",
    "Âncoras [[licitei-assinatura]] e {{signature}}.",
  ];
  let y = 720;
  for (const [index, line] of lines.entries()) {
    const font = index === 0 ? bold : regular;
    const size = index === 0 ? 16 : 12;
    page.drawText(line, { x: 72, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    y -= size + 10;
  }
  return document.save({ useObjectStreams: false });
};

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

const buildRotatedCropped = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const rotations: ReadonlyArray<90 | 270> = [90, 270];
  for (const rotation of rotations) {
    const page = document.addPage(PAGE_SIZE);
    page.setRotation({ type: "degrees", angle: rotation });
    page.setCropBox(72, 72, PAGE_SIZE[0] - 72, PAGE_SIZE[1] - 72);
    page.drawText(`Página com rotação ${rotation}°`, { x: 120, y: 420, size: 14, font });
    addLinkAnnotation(document, page, LINK_FIXTURE_URIS.rotated, [100, 360, 320, 390]);
  }
  return document.save({ useObjectStreams: false });
};

const buildLinks = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  page.drawText("Documento de links para âncoras URI.", { x: 72, y: 700, size: 12, font });
  addLinkAnnotation(document, page, LINK_FIXTURE_URIS.primary, [72, 620, 280, 650]);
  addLinkAnnotation(document, page, LINK_FIXTURE_URIS.secondary, [72, 560, 280, 590]);
  addLinkAnnotation(document, page, LINK_FIXTURE_URIS.indirect, [72, 500, 280, 530], {
    indirectAction: true,
  });
  return document.save({ useObjectStreams: false });
};

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

const buildHabilitacao150 = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const png = await document.embedPng(MINIMAL_PNG);
  for (let pageIndex = 0; pageIndex < 150; pageIndex += 1) {
    const page = document.addPage(PAGE_SIZE);
    page.drawText(`Habilitação — folha ${pageIndex + 1}`, {
      x: 72,
      y: 730,
      size: 12,
      font: bold,
    });
    page.drawText(habilitacaoParagraph(pageIndex), {
      x: 72,
      y: 700,
      size: 10,
      font,
      maxWidth: 468,
      lineHeight: 12,
    });
    if (pageIndex % 12 === 5) {
      const rows = 4;
      const cols = 3;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = 72 + col * 150;
          const y = 520 - row * 50;
          page.drawRectangle({ x, y, width: 130, height: 30, borderWidth: 0.5 });
          page.drawText(`C${col + 1}R${row + 1}`, { x: x + 6, y: y + 10, size: 9, font });
        }
      }
    }
    if (pageIndex % 25 === 12) {
      const scale = 80 + (pageIndex % 40);
      page.drawImage(png, { x: 360, y: 220, width: scale, height: scale });
    }
    if (pageIndex === 149) {
      page.drawText("Âncora [[licitei-assinatura]] na última página.", {
        x: 72,
        y: 120,
        size: 11,
        font,
      });
    }
  }
  return document.save({ useObjectStreams: false });
};

const buildObjectStreams = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  page.drawText("PDF salvo com object streams e xref stream.", { x: 72, y: 700, size: 12, font });
  return document.save({ useObjectStreams: true });
};

const buildIncrementalUpdate = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  page.drawText("Versão original do documento.", { x: 72, y: 700, size: 12, font });
  const base = await document.save({ useObjectStreams: false });
  const updated = await PDFDocument.load(base);
  updated.setModificationDate(FIXED_DATE);
  const updatedFont = await updated.embedFont(StandardFonts.Helvetica);
  const updatedPage = updated.getPage(0);
  updatedPage.drawText("Texto alterado por atualização incremental.", {
    x: 72,
    y: 660,
    size: 12,
    font: updatedFont,
  });
  return updated.save();
};

type DrawnPiece = { readonly text: string; readonly font: PDFFont };

const drawPieces = (
  page: PDFPage,
  pieces: ReadonlyArray<DrawnPiece>,
  x: number,
  y: number,
  size: number,
): void => {
  let cursor = x;
  for (const piece of pieces) {
    page.drawText(piece.text, { x: cursor, y, size, font: piece.font });
    cursor += piece.font.widthOfTextAtSize(piece.text, size);
  }
};

const wrapWords = (text: string, font: PDFFont, size: number, width: number): string[] => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines;
};

const drawJustified = (
  page: PDFPage,
  lines: ReadonlyArray<string>,
  options: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly font: PDFFont;
    readonly size: number;
    readonly leading: number;
  },
): void => {
  const { x, y, width, font, size, leading } = options;
  for (const [index, line] of lines.entries()) {
    const baseline = y - index * leading;
    const words = line.split(" ");
    if (index === lines.length - 1 || words.length < 2) {
      page.drawText(line, { x, y: baseline, size, font });
      continue;
    }
    const extra = (width - font.widthOfTextAtSize(line, size)) / (words.length - 1);
    let cursor = x;
    for (const word of words) {
      page.drawText(word, { x: cursor, y: baseline, size, font });
      cursor += font.widthOfTextAtSize(`${word} `, size) + extra;
    }
  }
};

const buildMarkdownBasics = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const oblique = await document.embedFont(StandardFonts.HelveticaOblique);
  const page = document.addPage(PAGE_SIZE);
  page.drawText("1. INFORMAÇÕES GERAIS", { x: 72, y: 720, size: 14, font: bold });
  drawPieces(
    page,
    [
      { text: "Texto de corpo com destaque ", font: regular },
      { text: "CONCORRÊNCIA", font: bold },
      { text: " aberta.", font: regular },
    ],
    72,
    690,
    11,
  );
  page.drawText("• primeiro item", { x: 72, y: 660, size: 11, font: regular });
  page.drawText("• segundo item", { x: 72, y: 642, size: 11, font: regular });
  page.drawText("1.1. cláusula numerada permanece parágrafo.", {
    x: 72,
    y: 614,
    size: 11,
    font: oblique,
  });
  addLinkAnnotation(
    document,
    page,
    "https://signature-kit.dev/corpus/markdown-link",
    [72, 520, 260, 540],
  );
  page.drawText("Link para documentação", { x: 72, y: 528, size: 11, font: regular });
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      const x = 72 + col * 150;
      const y = 440 - row * 28;
      page.drawRectangle({
        x,
        y,
        width: 150,
        height: 28,
        borderWidth: 0.5,
        borderColor: rgb(0, 0, 0),
      });
    }
  }
  page.drawText("Item", { x: 78, y: 450, size: 10, font: bold });
  page.drawText("Qtd", { x: 228, y: 450, size: 10, font: bold });
  page.drawText("Areia", { x: 78, y: 422, size: 10, font: regular });
  page.drawText("4", { x: 228, y: 422, size: 10, font: regular });
  return document.save({ useObjectStreams: false });
};

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

const buildMarkdownHyphenation = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  const size = 11;
  const width = Math.max(
    ...HYPHENATED_PARAGRAPHS.flatMap((lines) =>
      lines.slice(0, -1).map((line) => font.widthOfTextAtSize(line, size)),
    ),
  );
  let y = 700;
  for (const lines of HYPHENATED_PARAGRAPHS) {
    drawJustified(page, lines, { x: 72, y, width, font, size, leading: 14 });
    y -= lines.length * 14 + 14;
  }
  return document.save({ useObjectStreams: false });
};

const buildMarkdownPageContinue = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const small = await document.embedFont(StandardFonts.HelveticaOblique);
  const bodies: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>> = [
    [
      [
        "O presente edital trata da contratação de serviços contínuos de",
        "manutenção predial.",
      ],
      [
        "A proposta deve considerar a mão-de-obra, os encargos e os insumos",
        "necessários à execução dos serviços, sem interrup-",
      ],
    ],
    [["ção contratual, durante toda a vigência do contrato."], ["Segundo parágrafo da página dois."]],
  ];
  for (const [index, paragraphs] of bodies.entries()) {
    const page = document.addPage(PAGE_SIZE);
    page.drawText(`EDITAL Nº 7/2026 — PÁGINA ${index + 1} DE ${bodies.length}`, {
      x: 72,
      y: 760,
      size: 9,
      font: small,
    });
    page.drawText(`Licitei — corpus markdown — ${index + 1}/${bodies.length}`, {
      x: 72,
      y: 40,
      size: 9,
      font: small,
    });
    let y = 700;
    for (const lines of paragraphs) {
      for (const line of lines) {
        page.drawText(line, { x: 72, y, size: 11, font: regular });
        y -= 14;
      }
      y -= 12;
    }
  }
  return document.save({ useObjectStreams: false });
};

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

const buildMarkdownNestedLists = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  for (const [x, y, line] of NESTED_LIST_LINES) {
    page.drawText(line, { x, y, size: 11, font });
  }
  return document.save({ useObjectStreams: false });
};

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

const buildMarkdownTwoColumn = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  const size = 10;
  const width = 230;
  for (const [column, paragraphs] of TWO_COLUMN_TEXT.entries()) {
    const x = 72 + column * (width + 20);
    let y = 700;
    for (const paragraph of paragraphs) {
      for (const line of wrapWords(paragraph, font, size, width)) {
        page.drawText(line, { x, y, size, font });
        y -= 13;
      }
      y -= 10;
    }
  }
  return document.save({ useObjectStreams: false });
};

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

const buildBrokenXref = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(PAGE_SIZE);
  page.drawText("PDF válido com startxref corrompido.", { x: 72, y: 700, size: 12, font });
  const bytes = await document.save({ useObjectStreams: false });
  const ascii = new TextDecoder().decode(bytes);
  const startxrefIndex = ascii.lastIndexOf("startxref");
  if (startxrefIndex < 0) {
    return bytes;
  }
  const lineBreak = ascii.indexOf("\n", startxrefIndex);
  if (lineBreak < 0) {
    return bytes;
  }
  const corrupted = `${ascii.slice(0, lineBreak + 1)}999999999\n${ascii.slice(lineBreak + 1)}`;
  return new TextEncoder().encode(corrupted);
};

const main = async (): Promise<void> => {
  mkdirSync(PDF_CORE_FIXTURES_DIR, { recursive: true });
  writeFixture("markdown-basics.pdf", await buildMarkdownBasics());
  writeFixture("markdown-hyphenation.pdf", await buildMarkdownHyphenation());
  writeFixture("markdown-page-continue.pdf", await buildMarkdownPageContinue());
  writeFixture("markdown-nested-lists.pdf", await buildMarkdownNestedLists());
  writeFixture("markdown-two-column.pdf", await buildMarkdownTwoColumn());
  writeFixture("markdown-headings-react.pdf", await buildMarkdownHeadingsReact());
  writeFixture("helvetica-winansi.pdf", await buildHelveticaWinansi());
  writeFixture("react-pdf-declaration.pdf", await buildReactPdfDeclaration());
  writeFixture("rotated-cropped.pdf", await buildRotatedCropped());
  writeFixture("links.pdf", await buildLinks());
  writeFixture("habilitacao-150.pdf", await buildHabilitacao150());
  writeFixture("object-streams.pdf", await buildObjectStreams());
  writeFixture("incremental-update.pdf", await buildIncrementalUpdate());
  writeFixture("broken-xref.pdf", await buildBrokenXref());
  copyFileSync(icpSource, join(PDF_CORE_FIXTURES_DIR, "icp-signed.pdf"));
};

await main();
