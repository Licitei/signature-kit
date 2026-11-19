import { pageRoute } from "./routes";
import { Button, Disclosure, Tabs, Toast } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import * as Mount from "foldkit/mount";
import type { Html, HtmlBuilder } from "foldkit/html";
import { landing } from "./styles/landing";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";
import en from "../messages/en-US.json";
import pt from "../messages/pt-BR.json";
import { captureDocsEvent } from "../lib/posthog/client";
import type { Locale } from "./content";
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

export const HomeProvider = Schema.Literals([
  "Clicksign",
  "Assinafy",
  "ZapSign",
  "DocuSeal",
  "Documenso",
]);
export const HomeProviderSelected = Schema.TaggedStruct("HomeProviderSelected", {
  provider: HomeProvider,
});
export const SelectHomeProvider = Command.define("SelectHomeProvider", {
  args: { provider: HomeProvider },
  messages: [HomeProviderSelected],
  execute: ({ provider }) =>
    Effect.sync(() => {
      captureDocsEvent("provider_showcase_selected", { method: "tab", provider });
      return HomeProviderSelected.make({ provider });
    }),
});
export const HomeCopyTarget = Schema.Literals(["install", "npm", "pnpm", "yarn", "provider"]);
export const HomeCopyLocation = Schema.Literals(["get_started", "providers"]);
export const HomeCopyRequest = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const HomeCopyFinished = Schema.TaggedStruct("HomeCopyFinished", {
  target: HomeCopyTarget,
  request: HomeCopyRequest,
  provider: HomeProvider,
  ok: Schema.Boolean,
});
export const HomeCopyExpired = Schema.TaggedStruct("HomeCopyExpired", {
  request: HomeCopyRequest,
  provider: HomeProvider,
});
export const ExpireHomeCopy = Command.define("ExpireHomeCopy", {
  args: { request: HomeCopyRequest, provider: HomeProvider },
  messages: [HomeCopyExpired],
  execute: ({ request, provider }) =>
    Effect.sleep("1800 millis").pipe(Effect.as(HomeCopyExpired.make({ request, provider }))),
});
export const CopyHome = Command.define("CopyHome", {
  args: {
    text: Schema.String,
    target: HomeCopyTarget,
    provider: HomeProvider,
    filename: Schema.String,
    location: HomeCopyLocation,
    request: HomeCopyRequest,
  },
  messages: [HomeCopyFinished],
  execute: ({ text, target, provider, filename, location, request }) =>
    Effect.tryPromise({
      try: async () => {
        await navigator.clipboard.writeText(text);
        if (target === "provider")
          captureDocsEvent("provider_snippet_copied", { filename, provider });
        else captureDocsEvent("install_command_copied", { analytics_location: location });
        return HomeCopyFinished.make({ target, request, provider, ok: true });
      },
      catch: () => {
        if (target === "provider")
          captureDocsEvent("provider_snippet_copy_failed", { filename, provider });
        else captureDocsEvent("install_command_copy_failed", { analytics_location: location });
        return HomeCopyFinished.make({ target, request, provider, ok: false });
      },
    }).pipe(Effect.catch((failure) => Effect.succeed(failure))),
});

export const homeProviders: ReadonlyArray<{
  name: typeof HomeProvider.Type;
  filename: string;
  code: string;
}> = [
  {
    name: "Clicksign",
    filename: "clicksign.ts",
    code: 'import * as Alchemy from "alchemy"\nimport { ClicksignSignatureRequest, providers as clicksignProviders } from "@signature-kit/clicksign"\nimport { signatureHttpClientLive } from "@signature-kit/http"\nimport { Effect, Layer, Redacted } from "effect"\n\nexport default class Contracts extends Alchemy.Stack<Contracts>()(\n  "Contracts",\n  {\n    providers: Layer.merge(\n      clicksignProviders({\n        accessToken: Redacted.make(process.env.CLICKSIGN_TOKEN ?? ""),\n        environment: "sandbox",\n        locale: "pt-BR",\n        autoClose: true,\n      }),\n      signatureHttpClientLive,\n    ),\n    state: Alchemy.inMemoryState(),\n  },\n  Effect.gen(function* () {\n    return yield* ClicksignSignatureRequest("membership-agreement", {\n      title: "Membership agreement",\n      documents: [{ fileName: "agreement.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }],\n      recipients: [{ name: "Bruno Lima", email: "bruno@example.com", role: "signer" }],\n    })\n  }),\n) {}',
  },
  {
    name: "Assinafy",
    filename: "assinafy.ts",
    code: 'import * as Alchemy from "alchemy"\nimport { AssinafySignatureRequest, providers as assinafyProviders } from "@signature-kit/assinafy"\nimport { signatureHttpClientLive } from "@signature-kit/http"\nimport { Effect, Layer, Redacted } from "effect"\n\nexport default class Contracts extends Alchemy.Stack<Contracts>()(\n  "Contracts",\n  {\n    providers: Layer.merge(\n      assinafyProviders({\n        accountId: process.env.ASSINAFY_ACCOUNT_ID ?? "",\n        apiKey: Redacted.make(process.env.ASSINAFY_API_KEY ?? ""),\n        environment: "sandbox",\n      }),\n      signatureHttpClientLive,\n    ),\n    state: Alchemy.inMemoryState(),\n  },\n  Effect.gen(function* () {\n    return yield* AssinafySignatureRequest("contract", {\n      title: "Contract",\n      documents: [{ fileName: "contract.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }],\n      recipients: [{ name: "Carla Nunes", email: "carla@example.com" }],\n    })\n  }),\n) {}',
  },
  {
    name: "ZapSign",
    filename: "zapsign.ts",
    code: 'import * as Alchemy from "alchemy"\nimport { ZapSignSignatureRequest, providers as zapSignProviders } from "@signature-kit/zapsign"\nimport { signatureHttpClientLive } from "@signature-kit/http"\nimport { Effect, Layer, Redacted } from "effect"\n\nexport default class Contracts extends Alchemy.Stack<Contracts>()(\n  "Contracts",\n  {\n    providers: Layer.merge(\n      zapSignProviders({\n        apiToken: Redacted.make(process.env.ZAPSIGN_API_TOKEN ?? ""),\n        environment: "sandbox",\n        locale: "pt-br",\n      }),\n      signatureHttpClientLive,\n    ),\n    state: Alchemy.inMemoryState(),\n  },\n  Effect.gen(function* () {\n    return yield* ZapSignSignatureRequest("contract", {\n      title: "Contract",\n      documents: [{ fileName: "contract.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }],\n      recipients: [{ name: "Davi Rocha", email: "davi@example.com" }],\n    })\n  }),\n) {}',
  },
  {
    name: "DocuSeal",
    filename: "docuseal.ts",
    code: 'import * as Alchemy from "alchemy"\nimport { DocuSealSignatureRequest, providers as docuSealProviders } from "@signature-kit/docuseal"\nimport { signatureHttpClientLive } from "@signature-kit/http"\nimport { Effect, Layer, Redacted } from "effect"\n\nexport default class Contracts extends Alchemy.Stack<Contracts>()(\n  "Contracts",\n  {\n    providers: Layer.merge(\n      docuSealProviders({\n        apiKey: Redacted.make(process.env.DOCUSEAL_API_KEY ?? ""),\n        baseUrl: "https://api.docuseal.com",\n        submittersOrder: "preserved",\n      }),\n      signatureHttpClientLive,\n    ),\n    state: Alchemy.inMemoryState(),\n  },\n  Effect.gen(function* () {\n    return yield* DocuSealSignatureRequest("service-agreement", {\n      title: "Service agreement",\n      documents: [{ fileName: "agreement.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }],\n      recipients: [{ name: "Ana Silva", email: "ana@example.com", role: "signer" }],\n    })\n  }),\n) {}',
  },
  {
    name: "Documenso",
    filename: "documenso.ts",
    code: 'import * as Alchemy from "alchemy"\nimport { DocumensoSignatureRequest, providers as documensoProviders } from "@signature-kit/documenso"\nimport { signatureHttpClientLive } from "@signature-kit/http"\nimport { Effect, Layer, Redacted } from "effect"\n\nexport default class Contracts extends Alchemy.Stack<Contracts>()(\n  "Contracts",\n  {\n    providers: Layer.merge(\n      documensoProviders({\n        apiKey: Redacted.make(process.env.DOCUMENSO_API_KEY ?? ""),\n        baseUrl: "https://app.documenso.com/api/v2",\n      }),\n      signatureHttpClientLive,\n    ),\n    state: Alchemy.inMemoryState(),\n  },\n  Effect.gen(function* () {\n    return yield* DocumensoSignatureRequest("service-agreement", {\n      title: "Service agreement",\n      documents: [{ fileName: "agreement.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }],\n      recipients: [{ name: "Ana Silva", email: "ana@example.com", role: "approver", routingOrder: 1 }],\n    })\n  }),\n) {}',
  },
];
export const firstSignature =
  'import { a1SignaturesLayer } from "@signature-kit/a1/signer"\nimport { signatures } from "@signature-kit/signatures"\nimport { Effect, Redacted } from "effect"\n\nconst layer = a1SignaturesLayer({\n  pfx,\n  password: Redacted.make(process.env.A1_PASSWORD ?? ""),\n})\n\nconst program = Effect.gen(function* () {\n  const identity = yield* signatures.inspect()\n\n  const artifact = yield* signatures.sign({\n    content,\n    algorithm: "rsa-sha256",\n  })\n\n  return { identity, artifact }\n}).pipe(Effect.provide(layer))\n\nconst { identity, artifact } = await Effect.runPromise(program)';
export const installCommand = "bun add @signature-kit/signatures @signature-kit/a1";
export const InstallManager = Schema.Literals(["bun", "npm", "pnpm", "yarn"]);
export const installSnippets: Record<typeof InstallManager.Type, string> = {
  bun: installCommand,
  npm: "npm install @signature-kit/signatures @signature-kit/a1",
  pnpm: "pnpm add @signature-kit/signatures @signature-kit/a1",
  yarn: "yarn add @signature-kit/signatures @signature-kit/a1",
};
export const installCopyTarget = (
  manager: typeof InstallManager.Type,
): typeof HomeCopyTarget.Type => (manager === "bun" ? "install" : manager);
export const HomeProviderTabs = Tabs.create<typeof HomeProvider.Type>();
export const HomeInstallTabs = Tabs.create<typeof InstallManager.Type>();
export const CopyToast = Toast.make(Schema.Struct({ text: Schema.String }));
const installManagers = ["bun", "npm", "pnpm", "yarn"] satisfies ReadonlyArray<
  typeof InstallManager.Type
>;
const providerNames = [
  "Clicksign",
  "Assinafy",
  "ZapSign",
  "DocuSeal",
  "Documenso",
] satisfies ReadonlyArray<typeof HomeProvider.Type>;

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
              h.Href(pageRoute({ locale: "pt-BR", path: "docs/a1-signing/browser-pdf-flow" })),
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

export const autoSignSection = <Message>(h: HtmlBuilder<Message>, locale: Locale, demo: Html) => {
  const copy = locale === "pt-BR" ? pt : en;
  return h.section(
    [...sx(h, landing.section), h.Id("auto-sign")],
    [
      h.div(
        [...sx(h, landing.head)],
        [
          h.h2([...sx(h, landing.sectionTitle), h.Id("auto-sign-heading")], [copy.autosign_title]),
          h.p([...sx(h, landing.lead)], [copy.autosign_lead]),
        ],
      ),
      demo,
    ],
  );
};

export const brandMark = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 24 24"), h.AriaHidden(true), ...sx(h, landing.brandMark)],
    [
      h.circle([h.Cx("12"), h.Cy("12"), h.R("11"), ...sx(h, landing.markDisc)]),
      h.path([h.D("M7 12.5l3.2 3.2L17 9"), ...sx(h, landing.markCheck)]),
    ],
  );

const seal = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox("0 0 240 240"), h.AriaHidden(true), ...sx(h, landing.seal)],
    [
      h.defs(
        [],
        [h.path([h.Id("seal-orbit"), h.D("M120 120m-88 0a88 88 0 1 1 176 0a88 88 0 1 1 -176 0")])],
      ),
      h.circle([h.Cx("120"), h.Cy("120"), h.R("112"), ...sx(h, landing.sealRing)]),
      h.circle([h.Cx("120"), h.Cy("120"), h.R("100"), ...sx(h, landing.sealDash)]),
      h.text(
        [...sx(h, landing.sealText)],
        [
          h.textPath(
            [h.Attribute("href", "#seal-orbit"), h.Attribute("textLength", "548")],
            ["PAdES · ICP-BRASIL · XML-DSIG · A1 · PKCS#12 · "],
          ),
        ],
      ),
      h.circle([h.Cx("120"), h.Cy("120"), h.R("64"), ...sx(h, landing.sealCore)]),
      h.path([h.D("M96 122l16 16 32-34"), ...sx(h, landing.sealCheck)]),
    ],
  );

const providerSnippet =
  'yield* ClicksignSignatureRequest("contract", {\n  title: "Contract",\n  documents: [{ fileName: "contract.pdf", mimeType: "application/pdf", contentBase64 }],\n  recipients: [{ name: "Ana Silva", email: "ana@example.com", role: "signer" }],\n})';

type HomeState = {
  locale: Locale;
  provider: typeof HomeProvider.Type;
  copied: typeof HomeCopyTarget.Type | "none" | "failed";
  installManager: typeof InstallManager.Type;
  providerTabs: Tabs.Model;
  installTabs: Tabs.Model;
  copyToast: typeof CopyToast.Model.Type;
};
type HomeMessages<Message> = {
  open: (kind: OverlayKind) => Message;
  copy: (target: typeof HomeCopyTarget.Type, location: typeof HomeCopyLocation.Type) => Message;
  gotProviderTabs: (message: Tabs.Message) => Message;
  gotInstallTabs: (message: Tabs.Message) => Message;
  gotCopyToast: (message: typeof CopyToast.Message.Type) => Message;
};

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

const signFreePath = (locale: Locale) =>
  pageRoute({ locale, path: locale === "pt-BR" ? "assine-documentos-gratis" : "sign-free" });

export const homeOverlayPanels = <Message>(
  h: HtmlBuilder<Message>,
  state: HomeState,
  signer: Html,
  messages: HomeMessages<Message>,
): ReadonlyArray<readonly [OverlayKind, Html]> => {
  const copy = state.locale === "pt-BR" ? pt : en;
  const copyButton = (
    target: typeof HomeCopyTarget.Type,
    location: typeof HomeCopyLocation.Type,
    label: string,
  ) =>
    Button.view(
      {
        onClick: messages.copy(target, location),
        toView: (attributes) =>
          h.button(
            [...attributes.button, ...sx(h, "home-copy", landing.copy), h.AriaLabel(label)],
            [copyIcon(h), state.copied === target ? copy.showcase_copied : copy.showcase_copy],
          ),
      },
      h,
    );
  return [
    ["signer", signer],
    [
      "providers",
      h.submodel({
        slotId: "home-providers",
        model: state.providerTabs,
        view: HomeProviderTabs.view,
        viewInputs: {
          tabs: providerNames,
          selectedValue: state.provider,
          ariaLabel: copy.nav_providers,
          panelMount: "ActiveOnly",
          toView: ({ tablist, tabs }) =>
            h.div(
              [...sx(h, "home-code", landing.mockup)],
              [
                h.div(
                  [...sx(h, landing.chrome)],
                  [
                    h.div(
                      [...tablist, ...sx(h, "home-providers", landing.tabs)],
                      tabs.map((tab) =>
                        h.button(
                          [...tab.tab, ...sx(h, landing.tab, tab.isActive && landing.tabOn)],
                          [tab.value],
                        ),
                      ),
                    ),
                    copyButton("provider", "providers", `${copy.showcase_copy} ${state.provider}`),
                  ],
                ),
                ...tabs
                  .filter((tab) => tab.isActive)
                  .map((tab) =>
                    h.div(tab.panel, [
                      h.p([...sx(h, landing.filename)], [homeProviders[tab.index]?.filename ?? ""]),
                      h.pre(
                        [...sx(h, landing.code)],
                        [
                          h.code(
                            [...sx(h, landing.codeText)],
                            [homeProviders[tab.index]?.code ?? ""],
                          ),
                        ],
                      ),
                    ]),
                  ),
              ],
            ),
        },
        toParentMessage: messages.gotProviderTabs,
      }),
    ],
    [
      "quickstart",
      h.div(
        [...sx(h, landing.sheetStack)],
        [
          h.h3([...sx(h, landing.step)], [copy.install_step]),
          h.submodel({
            slotId: "home-install",
            model: state.installTabs,
            view: HomeInstallTabs.view,
            viewInputs: {
              tabs: installManagers,
              selectedValue: state.installManager,
              ariaLabel: copy.install_copy_label,
              panelMount: "All",
              toView: ({ tablist, tabs }) =>
                h.div(
                  [...sx(h, landing.mockup)],
                  [
                    h.div(
                      [...sx(h, landing.chrome)],
                      [
                        h.div(
                          [...tablist, ...sx(h, landing.tabs)],
                          tabs.map((tab) =>
                            h.button(
                              [...tab.tab, ...sx(h, landing.tab, tab.isActive && landing.tabOn)],
                              [tab.value],
                            ),
                          ),
                        ),
                        copyButton(
                          installCopyTarget(state.installManager),
                          "get_started",
                          `${copy.install_copy_label} ${state.installManager}`,
                        ),
                      ],
                    ),
                    ...tabs.map((tab) =>
                      h.pre(
                        [
                          ...tab.panel,
                          ...sx(h, landing.code),
                          ...(tab.isActive ? [] : [h.Hidden(true)]),
                        ],
                        [h.code([...sx(h, landing.codeText)], [installSnippets[tab.value]])],
                      ),
                    ),
                  ],
                ),
            },
            toParentMessage: messages.gotInstallTabs,
          }),
          h.h3([...sx(h, landing.step)], [copy.first_call]),
          h.div(
            [...sx(h, landing.mockup)],
            [
              h.pre(
                [...sx(h, landing.code)],
                [h.code([...sx(h, landing.codeText)], [firstSignature])],
              ),
            ],
          ),
          h.a(
            [
              ...sx(h, landing.feature),
              h.Href(pageRoute({ locale: state.locale, path: "docs/get-started/quickstart" })),
            ],
            [copy.quickstart_docs],
          ),
        ],
      ),
    ],
  ];
};

export const homeView = <Message>(
  h: HtmlBuilder<Message>,
  state: HomeState,
  messages: HomeMessages<Message>,
) => {
  const copy = state.locale === "pt-BR" ? pt : en;
  const docs = (path: string) => pageRoute({ locale: state.locale, path: `docs/${path}` });
  const signFree = signFreePath(state.locale);
  const trigger = (
    kind: OverlayKind,
    href: string,
    label: string,
    tone: "primary" | "ghost" | "feature",
  ) =>
    h.a(
      [
        ...sx(
          h,
          tone === "primary" ? shell.primary : tone === "ghost" ? shell.ghost : landing.feature,
          tone !== "feature" && landing.wide,
        ),
        h.Href(href),
        h.Attribute("data-overlay", kind),
        h.OnClick(messages.open(kind), { defaultAction: "Prevent" }),
      ],
      [label],
    );
  const showcase = (config: {
    id: string;
    title: string;
    lead: string;
    rest: string;
    links: ReadonlyArray<Html>;
    mockup: Html;
    flip: boolean;
  }) =>
    h.section(
      [...sx(h, landing.showcase, config.flip && landing.showcaseFlip), h.Id(config.id)],
      [
        h.h2([...sx(h, landing.showcaseTitle), h.Id(`${config.id}-heading`)], [config.title]),
        h.div([...sx(h, landing.mockup, landing.mockupArea)], [config.mockup]),
        h.div(
          [...sx(h, landing.aside)],
          [
            h.p(
              [...sx(h, landing.statement)],
              [config.lead, " ", h.span([...sx(h, landing.quiet)], [config.rest])],
            ),
            h.ul(
              [...sx(h, landing.features)],
              config.links.map((link) => h.li([], [link])),
            ),
          ],
        ),
      ],
    );
  const link = (label: string, href: string) =>
    h.a([...sx(h, landing.feature), h.Href(href)], [label]);
  const checks = (rows: ReadonlyArray<string>) =>
    h.ul(
      [...sx(h, landing.checks)],
      rows.map((row) =>
        h.li(
          [...sx(h, landing.check)],
          [h.span([...sx(h, landing.tick), h.AriaHidden(true)], ["✓"]), row],
        ),
      ),
    );
  return [
    h.section(
      [...sx(h, landing.hero)],
      [
        h.div(
          [...sx(h, landing.heroGrid)],
          [
            h.div(
              [...sx(h, landing.heroCopy)],
              [
                h.h1([...sx(h, landing.title)], [copy.hero_title]),
                h.div(
                  [...sx(h, landing.actions)],
                  [
                    h.a(
                      [
                        ...sx(h, shell.primary, landing.wide),
                        h.Href(pageRoute({ locale: state.locale, path: "docs" })),
                      ],
                      [copy.hero_cta_docs],
                    ),
                    trigger("signer", signFree, copy.hero_cta_sign, "ghost"),
                  ],
                ),
              ],
            ),
            h.div([...sx(h, landing.visual)], [seal(h)]),
            h.ul(
              [...sx(h, landing.taglines)],
              [copy.hero_line1, copy.hero_line2, copy.hero_line3].map((line) => h.li([], [line])),
            ),
          ],
        ),
        h.ul(
          [...sx(h, landing.logos), h.AriaLabel(copy.nav_providers)],
          [...providerNames, "ICP-Brasil"].map((name) => h.li([...sx(h, landing.logo)], [name])),
        ),
      ],
    ),
    showcase({
      id: "signer",
      title: copy.signer_title,
      lead: copy.signer_lead,
      rest: copy.signer_rest,
      flip: false,
      links: [
        trigger("signer", signFree, copy.nav_sign, "feature"),
        link(copy.feature_browser_flow, docs("a1-signing/browser-pdf-flow")),
        link(copy.feature_certificates, docs("signing/certificates")),
        link(copy.feature_batch, signFree),
      ],
      mockup: h.div(
        [],
        [
          h.div(
            [...sx(h, landing.chrome)],
            [h.span([...sx(h, landing.chromeUrl)], [`signaturekit.dev${signFree}`])],
          ),
          h.div(
            [...sx(h, landing.signerMock)],
            [
              h.div(
                [...sx(h, landing.paper), h.AriaHidden(true)],
                [
                  h.span([...sx(h, landing.paperLine)]),
                  h.span([...sx(h, landing.paperLine, landing.paperShort)]),
                  h.span([...sx(h, landing.paperLine)]),
                  h.span([...sx(h, landing.stamp)], [copy.mock_stamp]),
                ],
              ),
              checks([copy.mock_certificate, copy.mock_document, copy.mock_signed]),
            ],
          ),
        ],
      ),
    }),
    showcase({
      id: "providers",
      title: copy.showcase_title,
      lead: copy.showcase_lead,
      rest: copy.showcase_rest,
      flip: true,
      links: [
        trigger("providers", docs("providers/request-shape"), copy.view_providers, "feature"),
        link(copy.feature_request_shape, docs("providers/request-shape")),
        link(copy.feature_remote, docs("concepts/remote-signature-requests")),
        link(copy.feature_errors, docs("signing/errors")),
      ],
      mockup: h.div(
        [],
        [
          h.div(
            [...sx(h, landing.chrome)],
            [h.span([...sx(h, landing.chromeUrl)], ["clicksign.ts"])],
          ),
          h.pre(
            [...sx(h, landing.code, landing.codeArea)],
            [h.code([...sx(h, landing.codeText)], [providerSnippet])],
          ),
        ],
      ),
    }),
    showcase({
      id: "formats",
      title: copy.formats_title,
      lead: copy.formats_lead,
      rest: copy.formats_rest,
      flip: false,
      links: [
        link(copy.feature_pdf, docs("signing/pdf")),
        link(copy.feature_xml, docs("signing/xml")),
        link(copy.feature_signers, docs("signing/signers")),
      ],
      mockup: h.div(
        [],
        [
          h.div(
            [...sx(h, landing.chrome)],
            [
              h.span([...sx(h, landing.chromeUrl)], [copy.verify_file]),
              h.span([...sx(h, landing.badge)], [copy.verify_valid]),
            ],
          ),
          h.div(
            [...sx(h, landing.verify)],
            [
              checks([
                copy.verify_signature,
                copy.verify_coverage,
                copy.verify_chain,
                copy.verify_policy,
              ]),
            ],
          ),
        ],
      ),
    }),
    h.section(
      [...sx(h, landing.closing), h.Id("get-started")],
      [
        h.h2([...sx(h, landing.closingTitle), h.Id("get-started-heading")], [copy.gs_title]),
        h.div(
          [...sx(h, landing.actions, landing.centered)],
          [
            trigger("quickstart", docs("get-started/quickstart"), copy.final_cta, "primary"),
            Button.view(
              {
                onClick: messages.copy("install", "get_started"),
                toView: ({ button }) =>
                  h.button(
                    [
                      ...button,
                      ...sx(h, "home-install", landing.pill),
                      h.AriaLabel(`${copy.install_copy_label} bun`),
                    ],
                    [
                      h.span([...sx(h, landing.pillMark)], ["$"]),
                      h.code([...sx(h, landing.pillText)], [installCommand]),
                      copyIcon(h),
                    ],
                  ),
              },
              h,
            ),
          ],
        ),
      ],
    ),
  ];
};

export const copyToastView = <Message>(
  h: HtmlBuilder<Message>,
  state: HomeState,
  messages: HomeMessages<Message>,
) =>
  h.submodel({
    slotId: "home-toast",
    model: state.copyToast,
    view: CopyToast.view,
    viewInputs: {
      position: "BottomRight",
      ariaLabel: state.locale === "pt-BR" ? "Avisos" : "Notices",
      entryClassName: "home-status",
      entryToView: (entry) => h.p([...sx(h, landing.toast)], [entry.payload.text]),
    },
    toParentMessage: messages.gotCopyToast,
  });
