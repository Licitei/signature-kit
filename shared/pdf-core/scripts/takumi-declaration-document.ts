import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { LINK_FIXTURE_URIS } from "../__tests__/corpus.ts";

export const CORPUS_CREATOR = "signature-kit-pdf-core-corpus";

const requireFromModule = createRequire(import.meta.url);

export const liberationFontBytes = (): Uint8Array => {
  const pdfjsPackage = requireFromModule.resolve("pdfjs-dist/package.json");
  const fontPath = join(dirname(pdfjsPackage), "standard_fonts", "LiberationSans-Regular.ttf");
  return new Uint8Array(readFileSync(fontPath));
};

export const takumiBodyParagraph = (index: number): string => {
  const topics = [
    "qualificação técnica e regularidade fiscal",
    "capacidade operacional e experiência comprovada",
    "documentação complementar exigida no edital",
    "execução contratual em conformidade com a Lei 14.133/2021",
  ];
  const topic = topics[index % topics.length] ?? topics[0];
  return `Seção ${index + 1}: declaro atendimento às exigências de ${topic}, com ênfase em ação, coração, situação e à margem do instrumento convocatório. Referência CPF 123.456.789-09 e CNPJ 12.345.678/0001-95 para validação de âncoras numéricas.`;
};

export type TakumiDeclarationDocumentOptions = {
  readonly paragraphCount?: number;
  readonly textAnchorToken?: string;
  readonly includeLinkAnchor?: boolean;
  readonly linkUri?: string;
};

export const renderTakumiDeclarationPdf = async (
  options: TakumiDeclarationDocumentOptions = {},
): Promise<Uint8Array> => {
  const paragraphCount = options.paragraphCount ?? 28;
  const textAnchorToken = options.textAnchorToken ?? "[[licitei-assinatura]]";
  const includeLinkAnchor = options.includeLinkAnchor ?? true;
  const linkUri = options.linkUri ?? LINK_FIXTURE_URIS.takumiSignature;
  const fontData = liberationFontBytes();
  const { render } = await import("takumi-pdf");
  const { PageNumber, TotalPages } = await import("takumi-pdf/primitives");
  const React = await import("react");

  const children: Array<ReturnType<typeof React.createElement>> = [
    React.createElement(
      "h1",
      { tw: "text-base font-bold text-center mb-3 font-[Liberation]" },
      "Declaração de Habilitação",
    ),
    React.createElement(
      "p",
      { tw: "text-[11px] leading-relaxed font-[Liberation]" },
      "Declaro, sob as penas da lei, que atendo às condições de habilitação exigidas no edital, com ênfase em documentação, qualificação técnica e regularidade fiscal.",
    ),
    React.createElement(
      "p",
      { tw: "text-[11px] leading-relaxed font-[Liberation]" },
      "Texto com fonte incorporada: ção, ênfase, à disposição do órgão licitante.",
    ),
  ];
  for (let index = 0; index < paragraphCount; index += 1) {
    children.push(
      React.createElement(
        "p",
        { key: `body-${index}`, tw: "text-[11px] leading-relaxed font-[Liberation]" },
        takumiBodyParagraph(index),
      ),
    );
  }
  const anchorChildren: Array<ReturnType<typeof React.createElement>> = [
    React.createElement("p", { tw: "text-[4px] text-white font-[Liberation]" }, textAnchorToken),
  ];
  if (includeLinkAnchor) {
    anchorChildren.push(
      React.createElement(
        "a",
        {
          href: linkUri,
          tw: "text-[4px] text-white font-[Liberation]",
        },
        "âncora de assinatura",
      ),
    );
  }
  children.push(
    React.createElement(
      "p",
      { tw: "text-[11px] mt-4 font-[Liberation]" },
      "Local e data: Curitiba, 15 de janeiro de 2024.",
    ),
    React.createElement("div", { tw: "flex flex-col items-center gap-1 mt-6" }, ...anchorChildren),
  );
  const body = React.createElement("main", { tw: "flex flex-col gap-2" }, ...children);
  return render(body, {
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
    metadata: {
      title: "Declaração de Habilitação",
      creator: CORPUS_CREATOR,
      creationDate: "2024-01-15T10:30:00",
    },
  });
};
