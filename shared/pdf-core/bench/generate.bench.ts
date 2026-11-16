import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderToBuffer, Document, Page, Text, View, Font, StyleSheet } from "@react-pdf/renderer";
import { render } from "takumi-pdf";
import { PageNumber, TotalPages } from "takumi-pdf/primitives";
import React from "react";

type BenchRow = {
  readonly generator: string;
  readonly coldMs: number;
  readonly warmP50Ms: number;
  readonly warmP95Ms: number;
  readonly outputBytes: number;
};

const benchDirectory = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = join(benchDirectory, "results");
const warmIterations = 10;
const packageRoot = join(benchDirectory, "..");
const liberationFontFile = join(
  packageRoot,
  "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
);

const percentile = (values: ReadonlyArray<number>, ratio: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const declarationParagraph =
  "Declaro, sob as penas da lei, que atendo às condições de habilitação exigidas no edital, com ênfase em documentação, qualificação técnica e regularidade fiscal, ação, coração, situação e à margem do instrumento convocatório.";

const buildReactPdfDeclaration = async (): Promise<Uint8Array> => {
  Font.register({
    family: "Liberation",
    src: liberationFontFile,
  });
  const styles = StyleSheet.create({
    page: { padding: 48, fontSize: 11, fontFamily: "Helvetica" },
    title: { fontSize: 16, marginBottom: 12, fontFamily: "Helvetica-Bold" },
    paragraph: { marginBottom: 8, lineHeight: 1.4 },
    embedded: { fontFamily: "Liberation", marginBottom: 8 },
    anchorRow: { width: 300 },
    anchor: { fontSize: 4, color: "#ffffff" },
  });
  const bodyBlocks: Array<ReturnType<typeof React.createElement>> = [
    React.createElement(Text, { style: styles.title }, "Declaração de Habilitação"),
    React.createElement(Text, { style: styles.paragraph }, declarationParagraph),
    React.createElement(
      Text,
      { style: styles.embedded },
      "Texto com fonte incorporada: ção, ênfase, à disposição.",
    ),
  ];
  for (let index = 0; index < 24; index += 1) {
    bodyBlocks.push(
      React.createElement(
        Text,
        { key: `p-${index}`, style: styles.paragraph },
        `Bloco ${index + 1}: ${declarationParagraph}`,
      ),
    );
  }
  bodyBlocks.push(
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
  );
  const body = React.createElement(
    Document,
    {},
    React.createElement(Page, { size: "A4", style: styles.page }, ...bodyBlocks),
  );
  return new Uint8Array(await renderToBuffer(body));
};

const buildTakumiDeclaration = async (): Promise<Uint8Array> => {
  const fontData = readFileSync(liberationFontFile);
  const children: Array<ReturnType<typeof React.createElement>> = [
    React.createElement(
      "h1",
      { tw: "text-base font-bold text-center mb-3 font-[Liberation]" },
      "Declaração de Habilitação",
    ),
    React.createElement("p", { tw: "text-[11px] font-[Liberation]" }, declarationParagraph),
    React.createElement(
      "p",
      { tw: "text-[11px] font-[Liberation]" },
      "Texto com fonte incorporada: ção, ênfase, à disposição.",
    ),
  ];
  for (let index = 0; index < 24; index += 1) {
    children.push(
      React.createElement(
        "p",
        { key: `p-${index}`, tw: "text-[11px] font-[Liberation]" },
        `Bloco ${index + 1}: ${declarationParagraph}`,
      ),
    );
  }
  children.push(
    React.createElement(
      "p",
      { tw: "text-[4px] text-white font-[Liberation]" },
      "[[licitei-assinatura]]",
    ),
    React.createElement(
      "p",
      { tw: "text-[11px] font-[Liberation]" },
      "Local e data: Curitiba, 15 de janeiro de 2024.",
    ),
  );
  return render(React.createElement("main", { tw: "flex flex-col gap-2" }, ...children), {
    size: "a4",
    fonts: [{ name: "Liberation", data: fontData }],
    footer: React.createElement(
      "div",
      { tw: "flex w-full justify-center text-[8px] text-gray-600 font-[Liberation]" },
      "Página ",
      React.createElement(PageNumber),
      " de ",
      React.createElement(TotalPages),
    ),
  });
};

const measure = async (
  generator: string,
  renderPdf: () => Promise<Uint8Array>,
  cold: () => Promise<unknown>,
): Promise<BenchRow> => {
  const coldStart = performance.now();
  await cold();
  const coldMs = performance.now() - coldStart;
  const warm: number[] = [];
  let outputBytes = 0;
  for (let iteration = 0; iteration < warmIterations; iteration += 1) {
    const start = performance.now();
    const pdf = await renderPdf();
    warm.push(performance.now() - start);
    outputBytes = pdf.byteLength;
  }
  return {
    generator,
    coldMs,
    warmP50Ms: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95),
    outputBytes,
  };
};

const reactPdfCold = async (): Promise<void> => {
  await import("@react-pdf/renderer");
};

const takumiCold = async (): Promise<void> => {
  const wasmPath = pathToFileURL(
    join(packageRoot, "node_modules/takumi-pdf/pkg/takumi_pdf_wasm_bg.wasm"),
  );
  const { initSync } = await import("takumi-pdf");
  const wasmBytes = readFileSync(new URL(wasmPath));
  initSync({ module: wasmBytes });
};

mkdirSync(resultsDirectory, { recursive: true });

const rows = [
  await measure("react-pdf", buildReactPdfDeclaration, reactPdfCold),
  await measure("takumi-pdf", buildTakumiDeclaration, takumiCold),
];

const markdownTable = (benchRows: ReadonlyArray<BenchRow>): string => {
  const header = "| generator | cold ms | warm p50 ms | warm p95 ms | output bytes |";
  const divider = "| --- | ---: | ---: | ---: | ---: |";
  const body = benchRows.map(
    (row) =>
      `| ${row.generator} | ${row.coldMs.toFixed(1)} | ${row.warmP50Ms.toFixed(1)} | ${row.warmP95Ms.toFixed(1)} | ${row.outputBytes} |`,
  );
  return [header, divider, ...body].join("\n");
};

console.log(markdownTable(rows));
writeFileSync(
  join(resultsDirectory, "generate-latest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
