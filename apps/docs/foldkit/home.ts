import { pageRoute } from "./routes";
import { Button, Disclosure, Toast } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import * as Mount from "foldkit/mount";
import type { Html, HtmlBuilder } from "foldkit/html";
import { landing } from "./styles/landing";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";
import { captureDocsEvent } from "../lib/posthog/client";
import type { OverlayKind } from "./overlay";

export const Theme = Schema.Literals(["light", "dark"]);
export const ThemeLoaded = Schema.TaggedStruct("ThemeLoaded", { theme: Theme });
export const ThemeMount = Mount.define("ThemeMount", {
  messages: [ThemeLoaded],
  execute: ({ element }) =>
    Effect.try({
      try: (): typeof Theme.Type => {
        const theme = localStorage.getItem("signaturekit-theme") === "dark" ? "dark" : "light";
        element.setAttribute("data-theme", theme);
        return theme;
      },
      catch: () => "light",
    }).pipe(
      Effect.orElseSucceed((): typeof Theme.Type => "light"),
      Effect.map((theme) => ThemeLoaded.make({ theme })),
    ),
});
export const ThemeSaved = Schema.TaggedStruct("ThemeSaved", {});
export const SaveTheme = Command.define("SaveTheme", {
  args: { theme: Theme },
  messages: [ThemeSaved],
  execute: ({ theme }) =>
    Effect.try({
      try: () => localStorage.setItem("signaturekit-theme", theme),
      catch: () => undefined,
    }).pipe(Effect.ignore, Effect.as(ThemeSaved.make({}))),
});

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

export const homeProviders = [
  { name: "Clicksign", slug: "clicksign", logo: "/landing/clicksign.svg", height: 26 },
  { name: "Assinafy", slug: "assinafy", logo: "/landing/assinafy.png", height: 24 },
  { name: "ZapSign", slug: "zapsign", logo: "/landing/zapsign.svg", height: 30 },
  { name: "DocuSeal", slug: "docuseal", logo: "/landing/docuseal.svg", height: 26 },
  { name: "Documenso", slug: "documenso", logo: "/landing/documenso.svg", height: 21 },
] satisfies ReadonlyArray<{ name: string; slug: string; logo: string; height: number }>;

export const signFreeDescription =
  "Assine documentos PDF grátis no navegador com certificado digital A1. O arquivo, o .p12/.pfx e a senha ficam no seu dispositivo.";
export const signFreeSteps = [
  { title: "Envie o PDF", body: "Lido como bytes no navegador. Nenhum upload acontece." },
  {
    title: "Posicione a assinatura",
    body: "Clique no ponto da assinatura ou use o posicionamento automático.",
  },
  { title: "Carregue o A1", body: "Selecione o .p12 ou .pfx e informe a senha. Tudo fica local." },
  { title: "Baixe assinado", body: "A assinatura PAdES é aplicada na página e o PDF sai pronto." },
];
export const signFreeFaqs: ReadonlyArray<{
  readonly index: 0 | 1 | 2;
  readonly question: string;
  readonly answer: string;
}> = [
  {
    index: 0,
    question: "Precisa de cadastro?",
    answer: "Não. Basta o PDF e um certificado A1 válido.",
  },
  {
    index: 1,
    question: "O documento vai para algum servidor?",
    answer: "Não. PDF, certificado e senha ficam em memória local durante a assinatura.",
  },
  {
    index: 2,
    question: "Funciona com A3?",
    answer: "Ainda não. Esta página assina apenas com A1.",
  },
];
export const signFreeLanding = <Message>(
  h: HtmlBuilder<Message>,
  signer: Html,
  faq: {
    open: Option.Option<0 | 1 | 2>;
    toggle: (index: 0 | 1 | 2, open: boolean) => Message;
  },
) => [
  h.section(
    [...sx(h, landing.section)],
    [
      h.div(
        [...sx(h, landing.head)],
        [
          h.h1([...sx(h, landing.sectionTitle)], ["Assine documentos grátis com A1 no navegador."]),
          h.p(
            [...sx(h, landing.lead)],
            ["Assinatura PAdES direto no navegador. O PDF não sobe e a senha não é armazenada."],
          ),
        ],
      ),
      h.div(
        [...sx(h, landing.actions)],
        [
          h.a(
            [
              ...sx(h, shell.ghost),
              h.Href(pageRoute({ path: "docs/a1-signing/browser-pdf-flow" })),
            ],
            ["Como funciona"],
          ),
        ],
      ),
      h.ul(
        [...sx(h, landing.grid)],
        [
          "Sem upload do PDF",
          "Sem cadastro",
          "Senha nunca sai da página",
          "Assinatura PAdES com A1",
        ].map((item) => h.li([...sx(h, landing.cell, landing.cellTitle)], [item])),
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section), h.Id("assinar")],
    [
      h.div(
        [...sx(h, landing.head)],
        [
          h.h2([...sx(h, landing.sectionTitle)], ["Assine seu documento agora."]),
          h.p(
            [...sx(h, landing.lead)],
            ["Tenha o PDF, o certificado A1 (.p12 ou .pfx) e a senha em mãos."],
          ),
        ],
      ),
      h.div([...sx(h, landing.card)], [signer]),
    ],
  ),
  h.section(
    [...sx(h, landing.section)],
    [
      h.h2([...sx(h, landing.sectionTitle)], ["Quatro passos, tudo no navegador."]),
      h.div(
        [...sx(h, landing.grid)],
        signFreeSteps.map((step) =>
          h.article(
            [...sx(h, landing.cell)],
            [
              h.h3([...sx(h, landing.cellTitle)], [step.title]),
              h.p([...sx(h, landing.cellBody)], [step.body]),
            ],
          ),
        ),
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.section)],
    [
      h.h2([...sx(h, landing.sectionTitle)], ["Perguntas frequentes"]),
      h.div(
        [],
        signFreeFaqs.map((item) =>
          Disclosure.view(
            {
              id: `sign-free-faq-${item.index}`,
              isOpen: Option.contains(item.index)(faq.open),
              onToggle: (open) => faq.toggle(item.index, open),
              toView: ({ button, animatePanel }) =>
                h.div(
                  [...sx(h, landing.faq)],
                  [
                    h.button([...button, ...sx(h, landing.faqButton)], [item.question]),
                    animatePanel(h.p([...sx(h, landing.faqPanel)], [item.answer])),
                  ],
                ),
            },
            h,
          ),
        ),
      ),
    ],
  ),
];
export const autoSignSection = <Message>(h: HtmlBuilder<Message>, demo: Html) =>
  h.section(
    [...sx(h, landing.section), h.Id("auto-sign")],
    [
      h.div(
        [...sx(h, landing.head)],
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

const providerLogo = <Message>(
  h: HtmlBuilder<Message>,
  provider: (typeof homeProviders)[number],
) => [
  h.img([
    h.Src(provider.logo),
    h.Alt(provider.slug === "docuseal" ? "" : provider.name),
    h.Height(String(provider.height)),
    h.Loading("lazy"),
    h.Decoding("async"),
    ...sx(h, landing.providerLogo),
  ]),
  ...(provider.slug === "docuseal" ? [h.span([...sx(h, landing.providerName)], ["DocuSeal"])] : []),
];

export const signFreePath = pageRoute({ path: "assine-documentos-gratis" });

type HomeMessages<Message> = {
  open: (kind: OverlayKind) => Message;
};

export const homeView = <Message>(h: HtmlBuilder<Message>, messages: HomeMessages<Message>) => [
  h.section(
    [...sx(h, landing.hero)],
    [
      h.div(
        [...sx(h, landing.heroCopy)],
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
                    h.Src("/landing/licitei.png"),
                    h.Alt("Licitei"),
                    h.Height("15"),
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
              "Assine PDF e XML no servidor ou no navegador. E integre Clicksign, Assinafy, ZapSign, DocuSeal e Documenso com o mesmo kit, open source.",
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
              h.a([...sx(h, shell.outlineLight), h.Href("#provedores")], ["Ver provedores"]),
            ],
          ),
        ],
      ),
      h.div(
        [...sx(h, landing.strip)],
        [
          h.span([...sx(h, landing.stripLabel)], ["Integra com"]),
          ...homeProviders.map((provider) =>
            h.a(
              [
                ...sx(h, landing.stripCell),
                h.Href(pageRoute({ path: `docs/providers/${provider.slug}` })),
                h.AriaLabel(provider.name),
              ],
              providerLogo(h, provider),
            ),
          ),
        ],
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.block), h.Id("assinar")],
    [
      h.div(
        [...sx(h, landing.blockHead)],
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
          ...sx(h, landing.drop),
          h.Href(signFreePath),
          h.Attribute("data-overlay", "signer"),
          h.OnClick(messages.open("signer"), { defaultAction: "Prevent" }),
        ],
        [
          h.span(
            [...sx(h, landing.dropInner)],
            [
              h.span([...sx(h, landing.dropIcon)], [uploadIcon(h)]),
              h.strong([...sx(h, landing.dropTitle)], ["Solte seus PDFs aqui"]),
              h.span([...sx(h, landing.dropHint)], ["ou escolha no computador · até 100 arquivos"]),
            ],
          ),
        ],
      ),
      h.ul(
        [...sx(h, landing.facts)],
        ["Nada é enviado", "PAdES · ICP-Brasil", "Lote de até 100 PDFs"].map((fact) =>
          h.li([...sx(h, landing.fact)], [fact]),
        ),
      ),
    ],
  ),
  h.section(
    [...sx(h, landing.block, landing.blockSand), h.Id("provedores")],
    [
      h.div(
        [...sx(h, landing.split)],
        [
          h.div(
            [],
            [
              h.h2([...sx(h, landing.blockTitle)], ["Não tem certificado A1?"]),
              h.p(
                [...sx(h, landing.blockLead)],
                [
                  "Mande o documento pelo provedor que você já usa. O signatário assina pelo link, e você recebe o PDF assinado de volta no seu código.",
                ],
              ),
              h.a(
                [
                  ...sx(h, landing.textLink),
                  h.Href(pageRoute({ path: "docs/concepts/remote-signature-requests" })),
                ],
                ["Ver como integrar →"],
              ),
            ],
          ),
          h.div(
            [...sx(h, landing.providerGrid)],
            homeProviders.map((provider, index) =>
              h.a(
                [
                  ...sx(
                    h,
                    landing.providerCard,
                    index === homeProviders.length - 1 && landing.providerWide,
                  ),
                  h.Href(pageRoute({ path: `docs/providers/${provider.slug}` })),
                  h.AriaLabel(provider.name),
                ],
                providerLogo(h, provider),
              ),
            ),
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
      h.code([...sx(h, landing.installText)], [installCommand]),
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
              [copyIcon(h)],
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
