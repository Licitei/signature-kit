import { pageRoute } from "./routes";
import { Button, Toast } from "@foldkit/ui";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { codeBlock } from "./highlight";
import { icon } from "./icons";
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
            ["Posicionamento automático"],
          ),
          h.p(
            [...sx(h, landing.lead)],
            [
              "Veja onde o posicionamento automático coloca a assinatura em contratos comuns. São só exemplos visuais: para assinar, use o formulário acima.",
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
    body: "PDF assinado no padrão da ICP-Brasil, com carimbo visível e rubricas opcionais.",
  },
  {
    term: "XML-DSig",
    body: "Documentos XML assinados com o mesmo certificado e a mesma API.",
  },
  {
    term: "Navegador e servidor",
    body: "O mesmo código roda no Node, no Bun e no navegador. A chave privada fica onde você a carregou.",
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
              "Assine PDF (PAdES) e XML (XML-DSig) com certificado ICP-Brasil, no servidor ou no navegador. Biblioteca open source em TypeScript.",
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
              "Passe os bytes do PDF e do certificado A1 e receba o documento assinado. Cada falha volta como um erro tipado.",
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
    [...sx(h, landing.block, landing.blockTight)],
    [
      h.a(
        [
          ...sx(h, landing.engine),
          h.Href(pageRoute({ path: "pdf-core" })),
          h.Attribute("data-reveal", ""),
        ],
        [
          h.span(
            [...sx(h, landing.engineCopy)],
            [
              h.span([...sx(h, landing.engineKicker)], ["@signature-kit/pdf-core"]),
              h.strong(
                [...sx(h, landing.engineTitle)],
                ["Por baixo, um motor de PDF próprio em Rust e WebAssembly."],
              ),
              h.span(
                [...sx(h, landing.engineBody)],
                [
                  "Texto em ordem de leitura, renderização e escrita incremental sem biblioteca de PDF de terceiros. Veja os benchmarks e teste com um arquivo seu.",
                ],
              ),
            ],
          ),
          h.span(
            [...sx(h, landing.engineFigure)],
            [
              h.span([...sx(h, landing.engineNumber)], ["2,42 ms"]),
              h.span(
                [...sx(h, landing.engineUnit)],
                ["por página para converter editais inteiros em Markdown"],
              ),
              h.span([...sx(h, landing.engineLink)], ["Conhecer o pdf-core →"]),
            ],
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
                    : "ou escolha no computador (até 100 PDFs)",
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
