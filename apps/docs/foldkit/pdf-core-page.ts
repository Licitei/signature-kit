import type { Html, HtmlBuilder } from "foldkit/html";
import { codeBlock } from "./highlight";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { pageRoute } from "./routes";
import { landing } from "./styles/landing";
import { pages } from "./styles/pages";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";
import { relatedSection } from "./tool-pages";

export const pdfCorePath = pageRoute({ path: "pdf-core" });
export const pdfCoreTitle = "pdf-core: motor de PDF em Rust e WebAssembly";
export const pdfCoreDescription =
  "Motor de PDF em Rust, sem dependências, compilado para WebAssembly: texto em ordem de leitura, renderização, escrita incremental e análise de assinaturas.";
const readme = "https://github.com/Licitei/signature-kit/tree/main/shared/pdf-core";
const benchmarks = `${readme}#extraction-benchmarks`;

const metrics: ReadonlyArray<{
  value: number;
  decimals: number;
  unit: string;
  label: string;
}> = [
  { value: 2.42, decimals: 2, unit: "ms por página", label: "Markdown do documento inteiro" },
  { value: 5.07, decimals: 2, unit: "ms", label: "Primeira página em Markdown, p50" },
  { value: 98.8, decimals: 1, unit: "%", label: "Trechos de evidência recuperados (248 de 251)" },
  { value: 423, decimals: 0, unit: "KB com gzip", label: "Módulo WebAssembly (1.087.037 bytes)" },
];

const engines: ReadonlyArray<{
  name: string;
  detail: string;
  perPage: number;
  first: string;
  whole: string;
  evidence: string;
  failures: string;
  own: boolean;
}> = [
  {
    name: "SignatureKit pdf-core",
    detail: "Wasm",
    perPage: 2.42,
    first: "5,07 / 18,15 ms",
    whole: "71,92 ms / 1,54 s",
    evidence: "248/251 (98,8%)",
    failures: "0/30",
    own: true,
  },
  {
    name: "LiteParse 2.20.0",
    detail: "PDFium nativo",
    perPage: 13.41,
    first: "22,69 / 56,23 ms",
    whole: "382,55 ms / 9,75 s",
    evidence: "229/251 (91,2%)",
    failures: "0/30",
    own: false,
  },
  {
    name: "PDF Inspector 1.27.0",
    detail: "nativo",
    perPage: 34.68,
    first: "379,84 ms / 13,82 s",
    whole: "1,55 / 19,80 s",
    evidence: "211/251 (84,1%)",
    failures: "1/30",
    own: false,
  },
  {
    name: "PDF Inspector 1.27.0",
    detail: "Wasm",
    perPage: 49.26,
    first: "208,96 ms / 3,69 s",
    whole: "2,25 / 33,32 s",
    evidence: "211/251 (84,1%)",
    failures: "1/30",
    own: false,
  },
];

const capabilities: ReadonlyArray<{ glyph: IconName; title: string; body: string }> = [
  {
    glyph: "list",
    title: "Texto em ordem de leitura",
    body: "Colunas lidas uma de cada vez, títulos que atravessam colunas antes delas e notas de rodapé no fim da página.",
  },
  {
    glyph: "file",
    title: "Markdown e tabelas",
    body: "Parágrafos, títulos, listas e tabelas GFM. A hifenização de fim de linha é resolvida sem dicionário.",
  },
  {
    glyph: "pen",
    title: "Trechos com estilo e links",
    body: "inspect devolve retângulos, tamanho da fonte, negrito, itálico e as anotações de link de cada página.",
  },
  {
    glyph: "sparkles",
    title: "Renderização",
    body: "Display lists compactas pintadas com Canvas 2D no navegador, em janelas e em workers.",
  },
  {
    glyph: "copy",
    title: "Escrita",
    body: "Atualização incremental que preserva assinaturas anteriores, reescrita completa, união de páginas e documentos novos.",
  },
  {
    glyph: "signature",
    title: "Assinaturas e revisões",
    body: "Dicionários de assinatura, ByteRange e revisões completas, com limites de trabalho definidos.",
  },
  {
    glyph: "zap",
    title: "Leitura por faixas",
    body: "openLazy lê só os bytes das páginas pedidas de um arquivo, Blob ou API com Range.",
  },
  {
    glyph: "search",
    title: "Diagnóstico para OCR",
    body: "pageDiagnostics indica quais páginas têm camada de texto utilizável antes de você chamar um OCR.",
  },
  {
    glyph: "lock",
    title: "PDFs criptografados",
    body: "Abre arquivos do Standard Security com senha de abertura vazia (RC4, AESV2 e AESV3).",
  },
];

const promiseSnippet = `import { loadPdfCoreBrowser } from "@signature-kit/pdf-core/promise"

const core = await loadPdfCoreBrowser()

// pdf: Uint8Array com os bytes do arquivo
const pages = await core.text(pdf, { format: "markdown" })
const tables = await core.tables(pdf, { pageIndexes: [0] })`;

const effectSnippet = `import { NodeServices } from "@effect/platform-node"
import { PdfCore } from "@signature-kit/pdf-core/pdf-core"
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file"
import { Effect, Layer } from "effect"

const program = Effect.gen(function* () {
  const core = yield* PdfCore
  const inspection = yield* core.inspect(pdf, { text: true, links: true })
  return inspection.pages.map((page) => page.mediaBox)
})

program.pipe(Effect.provide(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))))`;

export const pdfCoreStructuredData = (origin: string) => ({
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  name: "@signature-kit/pdf-core",
  description: pdfCoreDescription,
  url: `${origin}${pdfCorePath}`,
  codeRepository: readme,
  programmingLanguage: ["Rust", "TypeScript", "WebAssembly"],
  runtimePlatform: ["Node.js", "Bun", "Navegador"],
  license: "https://github.com/Licitei/signature-kit/blob/main/LICENSE",
  author: { "@type": "Organization", name: "Licitei", url: "https://licitei.com.br" },
});

const largest = Math.max(...engines.map((engine) => engine.perPage));

export const pdfCoreView = <Message>(h: HtmlBuilder<Message>, demo: Html): ReadonlyArray<Html> => [
  h.section(
    [...sx(h, landing.signHero, pages.engineHero)],
    [
      h.div(
        [...sx(h, pages.engineInner)],
        [
          h.div(
            [...sx(h, landing.signCopy, pages.engineCopy), h.Attribute("data-enter", "")],
            [
              h.p([...sx(h, pages.engineEyebrow)], ["@signature-kit/pdf-core"]),
              h.h1([...sx(h, landing.signTitle)], ["O motor de PDF do SignatureKit."]),
              h.p(
                [...sx(h, landing.signLead, pages.engineLead)],
                [
                  "Escrito em Rust, sem dependências externas, e compilado para WebAssembly. Extrai texto em ordem de leitura, renderiza páginas, escreve atualizações incrementais e analisa assinaturas, no servidor e no navegador.",
                ],
              ),
              h.div(
                [...sx(h, landing.heroActions)],
                [
                  h.a([...sx(h, shell.primary), h.Href("#demo")], ["Testar com um PDF"]),
                  h.a([...sx(h, shell.outlineLight), h.Href(readme)], ["Ver no GitHub"]),
                ],
              ),
            ],
          ),
          h.dl(
            [...sx(h, pages.metrics), h.Attribute("data-enter", "")],
            metrics.map((metric) =>
              h.keyed("div")(
                metric.label,
                [...sx(h, pages.metric)],
                [
                  h.dt([...sx(h, pages.metricLabel)], [metric.label]),
                  h.dd(
                    [...sx(h, pages.metricValue)],
                    [
                      h.span(
                        [
                          h.Attribute("data-count", String(metric.value)),
                          h.Attribute("data-count-decimals", String(metric.decimals)),
                        ],
                        [
                          metric.value.toLocaleString("pt-BR", {
                            minimumFractionDigits: metric.decimals,
                            maximumFractionDigits: metric.decimals,
                          }),
                        ],
                      ),
                      h.span([...sx(h, pages.metricUnit)], [metric.unit]),
                    ],
                  ),
                ],
              ),
            ),
          ),
          h.p(
            [...sx(h, pages.engineNote)],
            [
              "Medições publicadas no README do pacote: 30 documentos de licitação com texto selecionável, 5.435 páginas, Bun 1.4.5 em Linux x64. O tamanho do módulo vem das notas de versão.",
            ],
          ),
        ],
      ),
    ],
  ),
  h.section(
    [...sx(h, pages.engineBand), h.Id("demo")],
    [
      h.div(
        [...sx(h, pages.engineSection)],
        [
          h.div(
            [...sx(h, landing.head), h.Attribute("data-reveal", "")],
            [
              h.h2([...sx(h, landing.sectionTitle, pages.onDark)], ["Teste com um PDF seu"]),
              h.p(
                [...sx(h, landing.lead, pages.onDarkMuted)],
                [
                  "O WebAssembly só é carregado quando você escolhe um arquivo. O PDF fica no seu navegador e o tempo exibido é o da extração no seu dispositivo.",
                ],
              ),
            ],
          ),
          h.div([h.Attribute("data-reveal", "")], [demo]),
        ],
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Comparação em editais de licitação"]),
          h.p(
            [...sx(h, landing.lead)],
            [
              "Milissegundos por página para converter o documento inteiro em Markdown. Barras menores são melhores.",
            ],
          ),
        ],
      ),
      h.ol(
        [...sx(h, pages.bars), h.Attribute("data-reveal", "")],
        engines.map((engine) =>
          h.keyed("li")(
            `${engine.name}-${engine.detail}`,
            [...sx(h, pages.barRow)],
            [
              h.span(
                [...sx(h, pages.barName)],
                [engine.name, h.span([...sx(h, pages.barDetail)], [` ${engine.detail}`])],
              ),
              h.span(
                [...sx(h, pages.barTrack)],
                [
                  h.span([
                    ...sx(h, pages.bar, engine.own && pages.barOwn),
                    h.Style({ width: `${((engine.perPage / largest) * 100).toFixed(2)}%` }),
                    h.Attribute("data-grow", ""),
                  ]),
                ],
              ),
              h.span(
                [...sx(h, pages.barValue)],
                [`${engine.perPage.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} ms`],
              ),
            ],
          ),
        ),
      ),
      h.div(
        [...sx(h, pages.tableWrap), h.Attribute("data-reveal", "")],
        [
          h.table(
            [...sx(h, pages.table)],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      "Motor",
                      "Primeira página, p50 / p90",
                      "Documento inteiro, p50 / p90",
                      "ms por página",
                      "Evidências encontradas",
                      "Falhas",
                    ].map((label) =>
                      h.keyed("th")(
                        label,
                        [h.Attribute("scope", "col"), ...sx(h, pages.th)],
                        [label],
                      ),
                    ),
                  ),
                ],
              ),
              h.tbody(
                [],
                engines.map((engine) =>
                  h.keyed("tr")(
                    `${engine.name}-${engine.detail}`,
                    [...sx(h, engine.own && pages.rowOwn)],
                    [
                      h.th(
                        [h.Attribute("scope", "row"), ...sx(h, pages.td, pages.tdName)],
                        [`${engine.name} (${engine.detail})`],
                      ),
                      h.td([...sx(h, pages.td)], [engine.first]),
                      h.td([...sx(h, pages.td)], [engine.whole]),
                      h.td(
                        [...sx(h, pages.td)],
                        [engine.perPage.toLocaleString("pt-BR", { minimumFractionDigits: 2 })],
                      ),
                      h.td([...sx(h, pages.td)], [engine.evidence]),
                      h.td([...sx(h, pages.td)], [engine.failures]),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
      h.div(
        [...sx(h, pages.method), h.Attribute("data-reveal", "")],
        [
          h.h3([...sx(h, landing.cellTitle)], ["Como foi medido"]),
          h.p(
            [...sx(h, landing.cellBody)],
            [
              "Trinta documentos de licitações públicas brasileiras com texto selecionável, de 15 a 697 páginas cada. O mesmo processo Bun 1.4.5, em Linux x64, chamou a API pública de cada motor em ordem rotativa, com os bytes já em memória, sem OCR e sem contar a inicialização. Tempos e evidências usam os 29 arquivos que todos os motores processaram com saída não vazia. As evidências são trechos literais do gabarito do corpus, como data de abertura e valor do contrato, procurados no Markdown gerado.",
            ],
          ),
          h.p(
            [...sx(h, landing.cellBody)],
            [
              "O corpus de licitações é mantido fora do repositório. O README não registra o hardware nem a data da execução, então trate os números como referência e repita a medição com o runner, que roda as fixtures públicas com as mesmas versões dos motores.",
            ],
          ),
          h.a(
            [...sx(h, landing.textLink), h.Href(benchmarks)],
            ["Ver metodologia e runner no README →"],
          ),
        ],
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section, pages.tight)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["O que o pdf-core faz"]),
          h.p(
            [...sx(h, landing.lead)],
            [
              "Um único módulo WebAssembly lê, desenha e escreve PDF, com a mesma API no Node, no Bun e no navegador.",
            ],
          ),
        ],
      ),
      h.ul(
        [
          ...sx(h, pages.features),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        capabilities.map((item) =>
          h.keyed("li")(
            item.title,
            [...sx(h, pages.feature)],
            [
              h.span([...sx(h, pages.featureIcon)], [icon(h, item.glyph)]),
              h.h3([...sx(h, landing.cellTitle)], [item.title]),
              h.p([...sx(h, landing.cellBody)], [item.body]),
            ],
          ),
        ),
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Com Promises ou com Effect"]),
          h.p(
            [...sx(h, landing.lead)],
            [
              "O cliente com Promises atende apps sem Effect. O serviço PdfCore entra em programas Effect como qualquer outra dependência.",
            ],
          ),
        ],
      ),
      h.div(
        [...sx(h, pages.snippets), h.Attribute("data-reveal", "")],
        [
          codeBlock(h, { label: "navegador.ts", source: promiseSnippet, language: "ts" }),
          codeBlock(h, { label: "servidor.ts", source: effectSnippet, language: "ts" }),
        ],
      ),
    ],
  ),
  relatedSection(h, [
    {
      kind: "Código",
      label: "README do pdf-core",
      hint: "API completa, limites, ABI do Wasm e benchmarks.",
      href: readme,
    },
    {
      kind: "npm",
      label: "@signature-kit/pdf-core",
      hint: "bun add @signature-kit/pdf-core",
      href: "https://www.npmjs.com/package/@signature-kit/pdf-core",
    },
    {
      kind: "Notas de versão",
      label: "Ordem de leitura com colunas",
      hint: "Como as colunas e o fluxo de texto são detectados.",
      href: pageRoute({ path: "changelog/pdf-core-reading-order" }),
    },
    {
      kind: "Notas de versão",
      label: "Extração mais rápida",
      hint: "Páginas selecionadas e Markdown.",
      href: pageRoute({ path: "changelog/pdf-extraction-performance" }),
    },
  ]),
];
