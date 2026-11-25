import { pageRoute } from "./routes";
import { Button, Disclosure, Toast } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { codeBlock } from "./highlight";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { landing } from "./styles/landing";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";
import { captureDocsEvent } from "./analytics";
import type { OverlayKind } from "./overlay";

export const installCommand = "bun add @signature-kit/signatures @signature-kit/a1 effect";
export const HomeCopyRequest = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const HomeCopyFinished = Schema.TaggedStruct("HomeCopyFinished", {
  request: HomeCopyRequest,
  ok: Schema.Boolean,
});
export const HomeCopyExpired = Schema.TaggedStruct("HomeCopyExpired", {
  request: HomeCopyRequest,
});
export const ExpireHomeCopy = Command.define("ExpireHomeCopy", {
  args: { request: HomeCopyRequest },
  messages: [HomeCopyExpired],
  execute: ({ request }) =>
    Effect.sleep("1800 millis").pipe(Effect.as(HomeCopyExpired.make({ request }))),
});
export const CopyHome = Command.define("CopyHome", {
  args: { request: HomeCopyRequest },
  messages: [HomeCopyFinished],
  execute: ({ request }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(installCommand);
        captureDocsEvent("install_command_copied", { analytics_location: "footer" });
        return HomeCopyFinished.make({ request, ok: true });
      },
      catch: () => {
        captureDocsEvent("install_command_copy_failed", { analytics_location: "footer" });
        return HomeCopyFinished.make({ request, ok: false });
      },
    }).pipe(Effect.catch((failure) => Effect.succeed(failure))),
});
export const CopyToast = Toast.make(Schema.Struct({ text: Schema.String }));

export const signFreeDescription =
  "Assine PDF grátis com certificado digital A1 (ICP-Brasil), direto no navegador. Assinatura qualificada em PAdES, sem cadastro: o PDF, o .pfx e a senha não saem do seu dispositivo.";
export const signFreeSteps = [
  { title: "Envie o PDF", body: "Lido como bytes no navegador. Nenhum upload acontece." },
  {
    title: "Posicione a assinatura",
    body: "Clique no ponto da assinatura ou use o posicionamento automático.",
  },
  { title: "Carregue o A1", body: "Selecione o .p12 ou .pfx e informe a senha. Tudo fica local." },
  { title: "Baixe assinado", body: "A assinatura PAdES é aplicada na página e o PDF sai pronto." },
];

export const SignFreeFaqIndex = Schema.Literals([0, 1, 2, 3, 4, 5, 6]);
export type SignFreeFaqIndex = typeof SignFreeFaqIndex.Type;

export const signFreeFaqs: ReadonlyArray<{
  readonly index: SignFreeFaqIndex;
  readonly question: string;
  readonly answer: string;
}> = [
  {
    index: 0,
    question: "A assinatura tem validade jurídica?",
    answer:
      "Sim. Com certificado ICP-Brasil, a assinatura é qualificada: o nível mais alto da Lei 14.063/2020, com presunção de validade jurídica dada pela MP 2.200-2/2001.",
  },
  {
    index: 1,
    question: "Precisa de cadastro?",
    answer: "Não. Basta o PDF, o arquivo do certificado A1 (.pfx ou .p12) e a senha.",
  },
  {
    index: 2,
    question: "O documento vai para algum servidor?",
    answer:
      "Não. O PDF, o certificado e a senha ficam na memória do seu navegador durante a assinatura. Nada é enviado.",
  },
  {
    index: 3,
    question: "Como confiro se a assinatura é válida?",
    answer:
      "Envie o PDF assinado ao Validar, o verificador oficial do ITI (validar.iti.gov.br), ou abra no Adobe Acrobat Reader e confira o painel de assinaturas.",
  },
  {
    index: 4,
    question: "Funciona com certificado A3 (token ou cartão)?",
    answer:
      "Ainda não. O A3 fica em mídia criptográfica e o navegador não acessa essa mídia diretamente. Esta página assina com A1.",
  },
  {
    index: 5,
    question: "Posso assinar vários PDFs de uma vez?",
    answer:
      "Sim. Selecione até 100 PDFs e todos são assinados com o mesmo certificado, um após o outro.",
  },
  {
    index: 6,
    question: "Dá para escolher onde a assinatura aparece?",
    answer:
      "Sim. No modo Completa você posiciona o carimbo na página, escolhe o estilo e pode rubricar as demais páginas.",
  },
];

const signFreeFacts: ReadonlyArray<{ glyph: IconName; text: string }> = [
  { glyph: "lock", text: "O PDF, o certificado e a senha não saem do seu dispositivo" },
  { glyph: "zap", text: "Sem cadastro e sem limite: até 100 PDFs por vez" },
  { glyph: "check", text: "Assinatura qualificada ICP-Brasil, no padrão PAdES" },
];

const signFreeOutcomes: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "PDF assinado em PAdES",
    body: "O padrão de assinatura de PDF aceito pela ICP-Brasil, com a cadeia do seu certificado embutida.",
  },
  {
    title: "Verificável em qualquer lugar",
    body: "Confira no Validar do ITI ou no Adobe Acrobat Reader. Não depende do SignatureKit para validar.",
  },
  {
    title: "Carimbo visível e rubricas",
    body: "Posicione o carimbo na página certa e rubrique as demais, no modo Completa.",
  },
  {
    title: "Lote de até 100 PDFs",
    body: "Contratos, aditivos e procurações assinados de uma vez, com o mesmo certificado.",
  },
];

const signFreeLevels: ReadonlyArray<{ level: string; body: string; current: boolean }> = [
  {
    level: "Simples",
    body: "Identifica quem assinou por meios básicos, como e-mail ou SMS.",
    current: false,
  },
  {
    level: "Avançada",
    body: "Vincula o signatário de forma unívoca, como a assinatura do gov.br.",
    current: false,
  },
  {
    level: "Qualificada",
    body: "Usa certificado digital ICP-Brasil, como o seu A1. É o nível que esta página gera.",
    current: true,
  },
];

export const signFreeLanding = <Message>(
  h: HtmlBuilder<Message>,
  signer: Html,
  faq: {
    open: Option.Option<SignFreeFaqIndex>;
    toggle: (index: SignFreeFaqIndex, open: boolean) => Message;
  },
) => [
  h.section(
    [...sx(h, landing.signHero), h.Id("assinar")],
    [
      h.div(
        [...sx(h, landing.signHeroInner)],
        [
          h.div(
            [...sx(h, landing.signCopy), h.Attribute("data-enter", "")],
            [
              h.p([...sx(h, landing.signEyebrow)], ["Assinador de PDF grátis"]),
              h.h1([...sx(h, landing.signTitle)], ["Assine PDF com certificado digital A1."]),
              h.p(
                [...sx(h, landing.signLead)],
                [
                  "Assinatura qualificada ICP-Brasil direto no navegador. Escolha o certificado, digite a senha, solte os PDFs e baixe assinados.",
                ],
              ),
              h.ul(
                [...sx(h, landing.signFacts)],
                signFreeFacts.map((fact) =>
                  h.keyed("li")(
                    fact.glyph,
                    [...sx(h, landing.signFact)],
                    [h.span([...sx(h, landing.signFactIcon)], [icon(h, fact.glyph)]), fact.text],
                  ),
                ),
              ),
            ],
          ),
          h.div([...sx(h, landing.signCard)], [signer]),
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
          h.h2([...sx(h, landing.sectionTitle)], ["Como assinar um PDF com certificado A1"]),
          h.p(
            [...sx(h, landing.lead)],
            ["Quatro passos, menos de dois minutos. Tudo acontece no seu navegador."],
          ),
        ],
      ),
      h.ol(
        [
          ...sx(h, landing.rail),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        signFreeSteps.map((step, index) =>
          h.keyed("li")(
            step.title,
            [...sx(h, landing.railItem)],
            [
              h.span(
                [...sx(h, landing.railNumber), h.AriaHidden(true)],
                [String(index + 1).padStart(2, "0")],
              ),
              h.div(
                [],
                [
                  h.h3([...sx(h, landing.cellTitle)], [step.title]),
                  h.p([...sx(h, landing.cellBody)], [step.body]),
                ],
              ),
            ],
          ),
        ),
      ),
      h.h3([...sx(h, landing.railHeading), h.Attribute("data-reveal", "")], ["O que você recebe"]),
      h.ul(
        [
          ...sx(h, landing.rail, landing.railPlain),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        signFreeOutcomes.map((item) =>
          h.keyed("li")(
            item.title,
            [...sx(h, landing.railItem, landing.railItemPlain)],
            [
              h.div(
                [],
                [
                  h.h4([...sx(h, landing.cellTitle)], [item.title]),
                  h.p([...sx(h, landing.cellBody)], [item.body]),
                ],
              ),
            ],
          ),
        ),
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section, landing.split)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Validade jurídica"]),
          h.p(
            [...sx(h, landing.lead)],
            [
              "A Lei 14.063/2020 define três níveis de assinatura eletrônica. Com certificado ICP-Brasil, a sua é qualificada, o nível com presunção de validade jurídica dada pela MP 2.200-2/2001.",
            ],
          ),
          h.a(
            [
              ...sx(h, landing.textLink),
              h.Href("https://validar.iti.gov.br"),
              h.Target("_blank"),
              h.Rel("noopener"),
            ],
            ["Validar uma assinatura no ITI →"],
          ),
        ],
      ),
      h.ol(
        [
          ...sx(h, landing.levels),
          h.Attribute("data-reveal", ""),
          h.Attribute("data-reveal-stagger", ""),
        ],
        signFreeLevels.map((item) =>
          h.keyed("li")(
            item.level,
            [...sx(h, landing.level, item.current && landing.levelCurrent)],
            [
              h.strong([...sx(h, landing.levelHead)], [item.level]),
              h.p([...sx(h, landing.cellBody)], [item.body]),
            ],
          ),
        ),
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section, landing.split)],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Perguntas frequentes"]),
          h.p(
            [...sx(h, landing.lead)],
            ["Não achou sua dúvida? Veja a documentação do fluxo de assinatura no navegador."],
          ),
          h.a(
            [
              ...sx(h, landing.textLink),
              h.Href(pageRoute({ path: "docs/a1-signing/browser-pdf-flow" })),
            ],
            ["Como funciona por dentro →"],
          ),
        ],
      ),
      h.div(
        [],
        signFreeFaqs.map((item) =>
          h.keyed("div")(
            String(item.index),
            [],
            [
              Disclosure.view(
                {
                  id: `sign-free-faq-${item.index}`,
                  isOpen: Option.contains(item.index)(faq.open),
                  onToggle: (open) => faq.toggle(item.index, open),
                  toView: ({ button, animatePanel }) =>
                    h.div(
                      [...sx(h, landing.faq)],
                      [
                        h.h3(
                          [...sx(h, landing.faqHeading)],
                          [
                            h.button(
                              [...button, ...sx(h, landing.faqButton)],
                              [
                                item.question,
                                h.span(
                                  [
                                    ...sx(
                                      h,
                                      landing.faqChevron,
                                      Option.contains(item.index)(faq.open) &&
                                        landing.faqChevronOpen,
                                    ),
                                  ],
                                  [icon(h, "chevron")],
                                ),
                              ],
                            ),
                          ],
                        ),
                        animatePanel(h.p([...sx(h, landing.faqPanel)], [item.answer])),
                      ],
                    ),
                },
                h,
              ),
            ],
          ),
        ),
      ),
    ],
  ),
];
export const signFreeCta = <Message>(h: HtmlBuilder<Message>) =>
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, landing.devCta), h.Attribute("data-reveal", "")],
        [
          h.div(
            [...sx(h, landing.devCopy)],
            [
              h.h2([...sx(h, landing.devTitle)], ["Precisa assinar no seu sistema?"]),
              h.p(
                [...sx(h, landing.devLead)],
                [
                  "Esta página usa o SignatureKit, biblioteca open source em TypeScript. Assine PDF e XML no servidor ou no navegador com o mesmo código.",
                ],
              ),
            ],
          ),
          h.a(
            [...sx(h, shell.primary), h.Href(pageRoute({ path: "docs/get-started/quickstart" }))],
            ["Ver a documentação"],
          ),
        ],
      ),
    ],
  );

export const autoSignSection = <Message>(h: HtmlBuilder<Message>, demo: Html) =>
  h.section(
    [...sx(h, landing.section), h.Id("auto-sign")],
    [
      h.div(
        [...sx(h, landing.head), h.Attribute("data-reveal", "")],
        [
          h.h2(
            [...sx(h, landing.sectionTitle), h.Id("auto-sign-heading")],
            ["Veja o posicionamento automático."],
          ),
          h.p(
            [...sx(h, landing.lead)],
            [
              "Exemplos visuais de onde a marca cai em contratos comuns. A assinatura de verdade acontece no formulário acima.",
            ],
          ),
        ],
      ),
      demo,
    ],
  );

export const brandMark = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 34 22"), h.AriaHidden(true), ...sx(h, landing.brandMark)],
    [
      h.path([
        h.D("M2 15c3 0 4-10 7-10s-2 12 2 12 3-8 6-8-1 6 2 6 3-4 6-4 2 2 4 2"),
        ...sx(h, landing.brandStroke),
      ]),
      h.circle([h.Cx("31.5"), h.Cy("13"), h.R("2"), ...sx(h, landing.brandDot)]),
    ],
  );

const githubIcon = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 16 16"), h.AriaHidden(true), ...sx(h, landing.icon)],
    [
      h.path([
        h.D(
          "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z",
        ),
        ...sx(h, landing.iconFill),
      ]),
    ],
  );
export const githubLink = <Message>(h: HtmlBuilder<Message>, tone: "light" | "dark") =>
  h.a(
    [
      ...sx(h, shell.iconLink, tone === "light" && shell.iconLinkLight),
      h.Href("https://github.com/Licitei/signature-kit"),
      h.AriaLabel("GitHub"),
    ],
    [githubIcon(h)],
  );

const uploadIcon = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 24 24"), h.AriaHidden(true), ...sx(h, landing.uploadIcon)],
    [h.path([h.D("M12 16V5M7 10l5-5 5 5M5 19h14"), ...sx(h, landing.iconStroke)])],
  );
const copyIcon = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 16 16"), h.AriaHidden(true), ...sx(h, landing.icon)],
    [
      h.path([
        h.D("M5.5 5.5V3a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-2.5"),
        ...sx(h, landing.iconStroke),
      ]),
      h.path([
        h.D("M3 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"),
        ...sx(h, landing.iconStroke),
      ]),
    ],
  );

export const signFreePath = pageRoute({ path: "assine-documentos-gratis" });

type HomeMessages<Message> = {
  open: (kind: OverlayKind) => Message;
  dragOver: boolean;
  drag: (over: boolean) => Message;
  drop: (files: ReadonlyArray<File>) => Message;
};

export const homeSnippet = `import { a1SignaturesLayer } from "@signature-kit/a1/signer"
import { signPdf } from "@signature-kit/pdf/sign"
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Redacted } from "effect"

// pdf e pfx: os bytes do documento e do certificado A1
const a1 = a1SignaturesLayer({ pfx, password: Redacted.make(password) })
const pdfCore = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))

export const signed = signPdf({ pdf, policy: "pades-icp-brasil" }).pipe(
  Effect.provide(a1),
  Effect.provide(pdfCore),
)`;

const homeFacts: ReadonlyArray<{ term: string; body: string }> = [
  {
    term: "PAdES",
    body: "PDF assinado no padrão aceito pela ICP-Brasil, com carimbo visível e rubricas quando você quiser.",
  },
  {
    term: "XML-DSig",
    body: "NF-e e outros XML assinados com o mesmo certificado e a mesma camada de assinatura.",
  },
  {
    term: "Navegador e servidor",
    body: "O mesmo código roda no Node, no Bun e no navegador. A chave nunca sai de onde você a carregou.",
  },
];

export const homeView = <Message>(h: HtmlBuilder<Message>, messages: HomeMessages<Message>) => [
  h.section(
    [...sx(h, landing.hero)],
    [
      h.div(
        [...sx(h, landing.heroCopy), h.Attribute("data-enter", "")],
        [
          h.p(
            [...sx(h, landing.backed)],
            [
              "Apoiado pela",
              h.a(
                [
                  ...sx(h, landing.backedLink),
                  h.Href("https://licitei.com.br"),
                  h.AriaLabel("Licitei"),
                ],
                [
                  h.img([
                    h.Src("/landing/licitei.webp"),
                    h.Alt("Licitei"),
                    h.Height("15"),
                    h.Width("68"),
                    ...sx(h, landing.backedLogo),
                  ]),
                ],
              ),
            ],
          ),
          h.h1([...sx(h, landing.title)], ["Assinatura digital com certificado A1."]),
          h.p(
            [...sx(h, landing.subtitle)],
            [
              "PAdES e XML-DSig com certificado ICP-Brasil, no servidor ou no navegador. Tipado, testado e open source.",
            ],
          ),
          h.div(
            [...sx(h, landing.heroActions)],
            [
              h.a(
                [
                  ...sx(h, shell.primary),
                  h.Href(pageRoute({ path: "docs/get-started/quickstart" })),
                ],
                ["Começar agora"],
              ),
              h.a([...sx(h, shell.outlineLight), h.Href("#assinar")], ["Assinar um PDF"]),
            ],
          ),
        ],
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.block, landing.api)],
    [
      h.div(
        [...sx(h, landing.apiCode), h.Attribute("data-reveal", "")],
        [codeBlock(h, { label: "assinar.ts", source: homeSnippet, language: "ts" })],
      ),
      h.div(
        [...sx(h, landing.apiCopy), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.blockTitle)], ["Um PDF assinado em uma chamada."]),
          h.p(
            [...sx(h, landing.blockLead)],
            [
              "Você entrega os bytes do PDF e do certificado A1. O SignatureKit devolve o documento assinado, e cada falha chega como um erro tipado.",
            ],
          ),
          h.dl(
            [...sx(h, landing.apiFacts)],
            homeFacts.map((fact) =>
              h.keyed("div")(
                fact.term,
                [...sx(h, landing.apiFact)],
                [
                  h.dt([...sx(h, landing.apiTerm)], [fact.term]),
                  h.dd([...sx(h, landing.apiBody)], [fact.body]),
                ],
              ),
            ),
          ),
          h.a(
            [
              ...sx(h, landing.textLink),
              h.Href(pageRoute({ path: "docs/get-started/quickstart" })),
            ],
            ["Ler o guia de primeiro uso →"],
          ),
        ],
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.block, landing.blockTight), h.Id("assinar")],
    [
      h.div(
        [...sx(h, landing.blockHead), h.Attribute("data-reveal", "")],
        [
          h.h2([...sx(h, landing.blockTitle)], ["Assine um PDF agora, com o seu A1."]),
          h.p(
            [...sx(h, landing.blockLead)],
            ["Grátis, sem cadastro. PDF, certificado e senha não saem do seu navegador."],
          ),
        ],
      ),
      h.a(
        [
          ...sx(h, landing.drop, messages.dragOver && landing.dropOver),
          h.Attribute("data-reveal", ""),
          h.Href(signFreePath),
          h.Attribute("data-overlay", "signer"),
          h.OnClick(messages.open("signer"), { defaultAction: "Prevent" }),
          h.AllowDrop(),
          h.OnDragEnter(messages.drag(true)),
          h.OnDragLeave(messages.drag(false)),
          h.OnDropFiles(messages.drop),
        ],
        [
          h.span(
            [...sx(h, landing.dropInner, messages.dragOver && landing.dropInnerOver)],
            [
              h.span(
                [...sx(h, landing.dropIcon, messages.dragOver && landing.dropIconOver)],
                [uploadIcon(h)],
              ),
              h.strong(
                [...sx(h, landing.dropTitle)],
                [messages.dragOver ? "Solte para abrir o assinador" : "Solte seus PDFs aqui"],
              ),
              h.span(
                [...sx(h, landing.dropHint)],
                [
                  messages.dragOver
                    ? "Os arquivos ficam no seu navegador"
                    : "ou escolha no computador · até 100 arquivos",
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  ),
];

export const installPill = <Message>(
  h: HtmlBuilder<Message>,
  input: { copied: boolean; onCopy: Message },
) =>
  h.div(
    [...sx(h, landing.install)],
    [
      h.span([...sx(h, landing.installMark), h.AriaHidden(true)], ["$"]),
      h.code([...sx(h, landing.installText), h.Attribute("tabindex", "0")], [installCommand]),
      Button.view(
        {
          onClick: input.onCopy,
          toView: ({ button }) =>
            h.button(
              [
                ...button,
                ...sx(h, "home-install", landing.installCopy),
                h.AriaLabel(input.copied ? "Copiado" : `Copiar ${installCommand}`),
              ],
              [
                h.span(
                  [...sx(h, landing.installGlyph, input.copied && landing.installGlyphOff)],
                  [copyIcon(h)],
                ),
                h.span(
                  [...sx(h, landing.installGlyph, !input.copied && landing.installGlyphOff)],
                  [icon(h, "check")],
                ),
              ],
            ),
        },
        h,
      ),
    ],
  );

export const copyToastView = <Message>(
  h: HtmlBuilder<Message>,
  input: {
    model: typeof CopyToast.Model.Type;
    toParentMessage: (message: typeof CopyToast.Message.Type) => Message;
  },
) =>
  h.submodel({
    slotId: "home-toast",
    model: input.model,
    view: CopyToast.view,
    viewInputs: {
      position: "BottomRight",
      ariaLabel: "Avisos",
      entryClassName: "home-status",
      entryToView: (entry) => h.p([...sx(h, landing.toast)], [entry.payload.text]),
    },
    toParentMessage: input.toParentMessage,
  });
