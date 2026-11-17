import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LINK_FIXTURE_URIS, PDF_CORE_FIXTURES_DIR } from "../__tests__/corpus.ts";

const { PDFDocument, PDFHexString, PDFString, rgb, StandardFonts } =
  await import("@cantoo/pdf-lib");
const { renderToBuffer, Document, Page, Text, View, Font, StyleSheet } =
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
  const pdfjsRoot = dirname(fileURLToPath(requireFromModule.resolve("pdfjs-dist/package.json")));
  return join(pdfjsRoot, "standard_fonts", "LiberationSans-Regular.ttf");
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

const buildMarkdownBasics = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  stampMetadata(document);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const oblique = await document.embedFont(StandardFonts.HelveticaOblique);
  const page = document.addPage(PAGE_SIZE);
  page.drawText("1. INFORMAÇÕES GERAIS", { x: 72, y: 720, size: 14, font: bold });
  page.drawText("Texto de corpo com destaque ", { x: 72, y: 690, size: 11, font: regular });
  page.drawText("CONCORRÊNCIA", { x: 248, y: 690, size: 11, font: bold });
  page.drawText(" aberta.", { x: 356, y: 690, size: 11, font: regular });
  page.drawText("• primeiro item", { x: 72, y: 660, size: 11, font: regular });
  page.drawText("• segundo item", { x: 72, y: 642, size: 11, font: regular });
  page.drawText("1.1. cláusula numerada permanece parágrafo.", {
    x: 72,
    y: 614,
    size: 11,
    font: oblique,
  });
  addLinkAnnotation(document, page, "https://signature-kit.dev/corpus/markdown-link", [
    72,
    520,
    260,
    540,
  ]);
  page.drawText("Link para documentação", { x: 72, y: 528, size: 11, font: regular });
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      const x = 72 + col * 160;
      const y = 440 - row * 40;
      page.drawRectangle({ x, y, width: 150, height: 28, borderWidth: 0.5 });
    }
  }
  page.drawText("Item", { x: 78, y: 450, size: 10, font: bold });
  page.drawText("Qtd", { x: 238, y: 450, size: 10, font: bold });
  page.drawText("Areia", { x: 78, y: 410, size: 10, font: regular });
  page.drawText("4", { x: 238, y: 410, size: 10, font: regular });
  return document.save({ useObjectStreams: false });
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
  writeFixture("helvetica-winansi.pdf", await buildHelveticaWinansi());
  writeFixture("react-pdf-declaration.pdf", await buildReactPdfDeclaration());
  writeFixture("rotated-cropped.pdf", await buildRotatedCropped());
  writeFixture("links.pdf", await buildLinks());
  writeFixture("habilitacao-150.pdf", await buildHabilitacao150());
  writeFixture("object-streams.pdf", await buildObjectStreams());
  writeFixture("incremental-update.pdf", await buildIncrementalUpdate());
  writeFixture("broken-xref.pdf", await buildBrokenXref());
  writeFixture("markdown-basics.pdf", await buildMarkdownBasics());
  copyFileSync(icpSource, join(PDF_CORE_FIXTURES_DIR, "icp-signed.pdf"));
};

await main();
