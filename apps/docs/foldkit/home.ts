import { pageRoute } from "./routes";
import { Animation, Button, Disclosure, Tabs, Toast } from "@foldkit/ui";
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
export const HomeCopyTarget = Schema.Literals([
  "install",
  "npm",
  "pnpm",
  "yarn",
  "provider",
  "first",
]);
export const HomeCopyLocation = Schema.Literals(["hero", "final_cta", "get_started", "providers"]);
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
        else if (location === "hero" || location === "final_cta")
          captureDocsEvent("install_command_copied", { analytics_location: location });
        return HomeCopyFinished.make({ target, request, provider, ok: true });
      },
      catch: () => {
        if (target === "provider")
          captureDocsEvent("provider_snippet_copy_failed", { filename, provider });
        else if (location === "hero" || location === "final_cta")
          captureDocsEvent("install_command_copy_failed", { analytics_location: location });
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
      h.p([...sx(h, landing.eyebrow)], ["Ferramenta grátis"]),
      h.h1([...sx(h, landing.sectionTitle)], ["Assine documentos grátis com A1 no navegador."]),
      h.p(
        [...sx(h, landing.lead)],
        [
          "Assinatura PAdES com certificado digital A1, direto no navegador. O PDF não sobe para servidor e a senha não é armazenada.",
        ],
      ),
      h.div(
        [...sx(h, landing.actions)],
        [
          h.a([...sx(h, shell.primary), h.Href("#assinar")], ["Assinar agora"]),
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
        ].map((item) => h.li([...sx(h, landing.cell)], [item])),
      ),
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
    [...sx(h, landing.section), h.Id("assinar")],
    [
      h.h2([...sx(h, landing.sectionTitle)], ["Assine seu documento agora."]),
      h.p(
        [...sx(h, landing.lead)],
        ["Tenha o PDF, o certificado A1 (.p12 ou .pfx) e a senha em mãos."],
      ),
      signer,
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

export const homeView = <Message>(
  h: HtmlBuilder<Message>,
  state: {
    locale: Locale;
    provider: typeof HomeProvider.Type;
    copied: typeof HomeCopyTarget.Type | "none" | "failed";
    installManager: typeof InstallManager.Type;
    providerTabs: Tabs.Model;
    installTabs: Tabs.Model;
    heroMotion: Animation.Model;
    copyToast: typeof CopyToast.Model.Type;
  },
  signer: Html,
  demo: Html,
  messages: {
    select: (provider: typeof HomeProvider.Type) => Message;
    copy: (target: typeof HomeCopyTarget.Type, location: typeof HomeCopyLocation.Type) => Message;
    gotProviderTabs: (message: Tabs.Message) => Message;
    gotInstallTabs: (message: Tabs.Message) => Message;
    gotHeroMotion: (message: Animation.Message) => Message;
    gotCopyToast: (message: typeof CopyToast.Message.Type) => Message;
  },
) => {
  const copy = state.locale === "pt-BR" ? pt : en;
  const heroSnippet = firstSignature.split("\n").slice(0, 8).join("\n");
  const copyButton = (
    target: typeof HomeCopyTarget.Type,
    location: typeof HomeCopyLocation.Type,
    label?: string,
  ) =>
    Button.view(
      {
        onClick: messages.copy(target, location),
        toView: (attributes) =>
          h.button(
            [
              ...attributes.button,
              ...sx(h, "home-copy", landing.copy),
              h.Attribute(
                "aria-label",
                target === "provider"
                  ? `${copy.showcase_copy} ${state.provider}`
                  : target === "first"
                    ? `${copy.showcase_copy} first-signature.ts`
                    : `${copy.install_copy_label} ${target === "install" ? "bun" : target}`,
              ),
            ],
            [label ?? (state.copied === target ? copy.showcase_copied : copy.showcase_copy)],
          ),
      },
      h,
    );
  const capabilities = [
    [
      copy.cap1_title,
      copy.cap1_desc,
      "signing/signers",
      'import { signatures } from "@signature-kit/signatures"',
    ],
    [
      copy.cap2_title,
      copy.cap2_desc,
      "get-started/quickstart",
      "a1SignaturesLayer({ pfx, password: Redacted.make(password) })",
    ],
    [
      copy.cap3_title,
      copy.cap3_desc,
      "signing/pdf",
      'signPdf({ pdf, policy: "pades-icp-brasil" })',
    ],
    [copy.cap4_title, copy.cap4_desc, "signing/xml", 'signXml({ xml, referenceId: "nfe-1" })'],
    [
      copy.cap5_title,
      copy.cap5_desc,
      "providers/request-shape",
      'ClicksignSignatureRequest("contract", props)',
    ],
    [
      copy.cap6_title,
      state.locale === "pt-BR"
        ? "Falhas usam códigos tipados no canal de erros do Effect."
        : "Failures use typed codes in the Effect error channel.",
      "signing/errors",
      'Effect.catchTag("SignatureKitError", handle)',
    ],
    [
      copy.cap7_title,
      copy.cap7_desc,
      "a1-signing/browser-pdf-flow",
      'import { signPdfSignatureField } from "@signature-kit/pdf/workflow"',
    ],
  ];
  const marks = [landing.markNw, landing.markNe, landing.markSw, landing.markSe];
  return [
    h.section(
      [...sx(h, landing.hero, shell.rise)],
      [
        h.div(
          [],
          [
            h.a(
              [...sx(h, landing.eyebrow), h.Href("https://github.com/Licitei/signature-kit")],
              [copy.hero_badge],
            ),
            h.h1([...sx(h, landing.title)], [copy.hero_title]),
            h.p([...sx(h, landing.lead)], [copy.hero_subhead]),
            h.div(
              [...sx(h, landing.actions)],
              [
                h.a(
                  [
                    ...sx(h, shell.primary),
                    h.Href(pageRoute({ locale: state.locale, path: "docs" })),
                  ],
                  [copy.hero_cta_docs],
                ),
                Button.view(
                  {
                    onClick: messages.copy("install", "hero"),
                    toView: ({ button }) =>
                      h.button(
                        [
                          ...button,
                          ...sx(h, landing.pill),
                          h.Attribute("aria-label", `${copy.install_copy_label} bun`),
                        ],
                        [h.span([...sx(h, landing.pillMark)], ["$"]), installCommand],
                      ),
                  },
                  h,
                ),
              ],
            ),
          ],
        ),
        h.submodel({
          slotId: "home-hero",
          model: state.heroMotion,
          view: Animation.view,
          viewInputs: {
            content: h.div(
              [...sx(h, landing.frame)],
              [
                h.div([...sx(h, landing.glow)]),
                ...marks.map((place) => h.span([...sx(h, landing.mark, place)], ["+"])),
                h.div(
                  [...sx(h, landing.terminal)],
                  [
                    h.div([...sx(h, landing.terminalBar)], ["first-signature.ts"]),
                    h.pre([...sx(h, landing.terminalBody)], [heroSnippet]),
                  ],
                ),
                h.div([...sx(h, landing.stamp)], ["PAdES", h.br([]), "A1"]),
              ],
            ),
          },
          toParentMessage: messages.gotHeroMotion,
        }),
      ],
    ),
    h.section(
      [...sx(h, landing.marquee), h.Attribute("aria-label", copy.showcase_eyebrow)],
      [
        h.div(
          [...sx(h, landing.marqueeTrack)],
          [...providerNames, ...providerNames].map((name, index) =>
            h.span(
              [
                ...sx(h, landing.wordmark),
                ...(index >= providerNames.length ? [h.AriaHidden(true)] : []),
              ],
              [name],
            ),
          ),
        ),
      ],
    ),
    h.section(
      [...sx(h, landing.section), h.Id("signer")],
      [
        h.p([...sx(h, landing.eyebrow)], [copy.signer_eyebrow]),
        h.h2([...sx(h, landing.sectionTitle), h.Id("signer-heading")], [copy.signer_title]),
        h.p([...sx(h, landing.lead)], [copy.signer_lead]),
        h.div(
          [...sx(h, landing.grid)],
          [
            h.div(
              [...sx(h, landing.cell)],
              [
                h.h3([...sx(h, landing.cellTitle)], [copy.signer_step1_title]),
                h.p(
                  [...sx(h, landing.cellBody)],
                  [
                    state.locale === "pt-BR"
                      ? "Prévia local, sem upload."
                      : "Local preview, without upload.",
                  ],
                ),
              ],
            ),
            h.div(
              [...sx(h, landing.cell)],
              [
                h.h3([...sx(h, landing.cellTitle)], [copy.signer_step2_title]),
                h.p([...sx(h, landing.cellBody)], [copy.signer_step2_body]),
              ],
            ),
            h.div(
              [...sx(h, landing.cell)],
              [
                h.h3([...sx(h, landing.cellTitle)], [copy.signer_step3_title]),
                h.p([...sx(h, landing.cellBody)], [copy.signer_step3_body]),
              ],
            ),
          ],
        ),
        h.p([...sx(h, landing.lead)], [copy.signer_assurance]),
        h.p(
          [...sx(h, landing.lead)],
          [
            state.locale === "pt-BR"
              ? "A assinatura e os downloads usam o assinador real no seu dispositivo."
              : "Signing and downloads use the real signer on your device.",
          ],
        ),
        h.div([...sx(h, landing.signerSlot)], [signer]),
        h.a(
          [
            ...sx(h, shell.ghost),
            h.Href(
              pageRoute({
                locale: state.locale,
                path: state.locale === "pt-BR" ? "assine-documentos-gratis" : "sign-free",
              }),
            ),
          ],
          [copy.signer_open],
        ),
      ],
    ),
    h.section(
      [...sx(h, landing.section), h.Id("auto-sign")],
      [
        h.p([...sx(h, landing.eyebrow)], [copy.autosign_eyebrow]),
        h.h2([...sx(h, landing.sectionTitle), h.Id("auto-sign-heading")], [copy.autosign_title]),
        h.p(
          [...sx(h, landing.lead)],
          [
            state.locale === "pt-BR"
              ? "Posicione e assine vários PDFs em sequência com seu certificado A1 no navegador."
              : "Place and sign several PDFs in sequence with your A1 certificate in the browser.",
          ],
        ),
        demo,
      ],
    ),
    h.section(
      [...sx(h, landing.section), h.Id("providers")],
      [
        h.p([...sx(h, landing.eyebrow)], [copy.showcase_eyebrow]),
        h.h2([...sx(h, landing.sectionTitle), h.Id("providers-heading")], [copy.showcase_title]),
        h.p(
          [...sx(h, landing.lead)],
          [
            state.locale === "pt-BR"
              ? "Cinco provedores remotos, com contratos próprios e uma fronteira HTTP compartilhada."
              : "Five remote providers, each with its own contract and a shared HTTP boundary.",
          ],
        ),
        h.submodel({
          slotId: "home-providers",
          model: state.providerTabs,
          view: HomeProviderTabs.view,
          viewInputs: {
            tabs: providerNames,
            selectedValue: state.provider,
            ariaLabel: copy.showcase_card_provider,
            panelMount: "ActiveOnly",
            toView: ({ tablist, tabs }) =>
              h.div(
                [],
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
                  ...tabs
                    .filter((tab) => tab.isActive)
                    .map((tab) =>
                      h.div(
                        [...tab.panel, ...sx(h, "home-code", landing.window)],
                        [
                          h.div(
                            [...sx(h, landing.windowBar)],
                            [
                              h.span(
                                [...sx(h, landing.filename)],
                                [homeProviders[tab.index]?.filename ?? ""],
                              ),
                              copyButton("provider", "providers"),
                            ],
                          ),
                          h.pre(
                            [...sx(h, landing.code)],
                            [
                              h.code(
                                [...sx(h, landing.codeText)],
                                [homeProviders[tab.index]?.code ?? ""],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                ],
              ),
          },
          toParentMessage: messages.gotProviderTabs,
        }),
        h.div(
          [...sx(h, landing.grid)],
          [
            [copy.showcase_feature_adapters_label, copy.showcase_feature_adapters_desc],
            [copy.showcase_feature_errors_label, copy.showcase_feature_errors_desc],
            [copy.showcase_feature_redacted_label, copy.showcase_feature_redacted_desc],
            [copy.showcase_feature_shape_label, copy.showcase_feature_shape_desc],
          ].map(([title, description]) =>
            h.article(
              [...sx(h, landing.cell)],
              [
                h.h3([...sx(h, landing.cellTitle)], [title ?? ""]),
                h.p([...sx(h, landing.cellBody)], [description ?? ""]),
              ],
            ),
          ),
        ),
        h.a(
          [
            ...sx(h, shell.ghost),
            h.Href(pageRoute({ locale: state.locale, path: "docs/providers/request-shape" })),
          ],
          [copy.showcase_cta_browse],
        ),
      ],
    ),
    h.section(
      [...sx(h, landing.section), h.Id("capabilities")],
      [
        h.p([...sx(h, landing.eyebrow)], [copy.cap_eyebrow]),
        h.h2([...sx(h, landing.sectionTitle), h.Id("capabilities-heading")], [copy.cap_title]),
        h.p(
          [...sx(h, landing.lead)],
          [
            state.locale === "pt-BR"
              ? "A1, PDF, XML e provedores remotos com erros tipados."
              : "A1, PDF, XML and remote providers with typed errors.",
          ],
        ),
        h.div(
          [...sx(h, landing.grid)],
          capabilities.map(([title, description, path, code]) =>
            h.article(
              [...sx(h, landing.cell)],
              [
                h.h3([...sx(h, landing.cellTitle)], [title ?? ""]),
                h.p([...sx(h, landing.cellBody)], [description ?? ""]),
                h.code([...sx(h, landing.snippet)], [code ?? ""]),
                h.a(
                  [
                    h.Href(pageRoute({ locale: state.locale, path: `docs/${path}` })),
                    ...sx(h, shell.navLink),
                  ],
                  [copy.cap_read_docs],
                ),
              ],
            ),
          ),
        ),
      ],
    ),
    h.section(
      [...sx(h, landing.section), h.Id("get-started")],
      [
        h.p([...sx(h, landing.eyebrow)], [copy.gs_eyebrow]),
        h.h2([...sx(h, landing.sectionTitle), h.Id("get-started-heading")], [copy.gs_title]),
        h.p([...sx(h, landing.lead)], [copy.gs_lead]),
        h.h3([], [copy.gs_step1_heading]),
        h.submodel({
          slotId: "home-install",
          model: state.installTabs,
          view: HomeInstallTabs.view,
          viewInputs: {
            tabs: installManagers,
            selectedValue: state.installManager,
            ariaLabel: copy.gs_step1_heading,
            panelMount: "All",
            toView: ({ tablist, tabs }) =>
              h.div(
                [...sx(h, landing.window)],
                [
                  h.div(
                    [...tablist, ...sx(h, landing.windowBar)],
                    [
                      h.div(
                        [...sx(h, landing.tabs)],
                        tabs.map((tab) =>
                          h.button(
                            [...tab.tab, ...sx(h, landing.tab, tab.isActive && landing.tabOn)],
                            [tab.value],
                          ),
                        ),
                      ),
                      copyButton(installCopyTarget(state.installManager), "get_started"),
                    ],
                  ),
                  ...tabs.map((tab) =>
                    h.pre(
                      [
                        ...tab.panel,
                        ...sx(h, landing.code),
                        ...(tab.isActive ? [] : [h.Hidden(true)]),
                      ],
                      [installSnippets[tab.value]],
                    ),
                  ),
                ],
              ),
          },
          toParentMessage: messages.gotInstallTabs,
        }),
        h.p([...sx(h, landing.lead)], [copy.gs_note1, " /a1 · /pdf · /xml"]),
        h.h3([], [copy.gs_step2_heading]),
        h.div(
          [...sx(h, landing.window)],
          [
            h.div(
              [...sx(h, landing.windowBar)],
              [
                h.span([...sx(h, landing.filename)], ["first-signature.ts"]),
                copyButton("first", "get_started"),
              ],
            ),
            h.pre([...sx(h, landing.code)], [firstSignature]),
          ],
        ),
      ],
    ),
    h.section(
      [...sx(h, landing.band), h.Id("sponsors")],
      [
        h.div(
          [...sx(h, landing.bandInner)],
          [
            h.p([...sx(h, landing.eyebrow)], [copy.sponsors_eyebrow]),
            h.a([...sx(h, landing.bandLink), h.Href("https://licitei.com.br")], ["Licitei"]),
          ],
        ),
      ],
    ),
    h.section(
      [...sx(h, landing.final)],
      [
        h.p([...sx(h, landing.eyebrow)], [copy.final_eyebrow]),
        h.h2([...sx(h, landing.sectionTitle)], [copy.final_title]),
        h.p([...sx(h, landing.lead)], [copy.final_lead]),
        h.div(
          [...sx(h, landing.actions)],
          [
            h.a(
              [
                ...sx(h, shell.primary),
                h.Href(pageRoute({ locale: state.locale, path: "docs/get-started/quickstart" })),
              ],
              [copy.final_cta],
            ),
            Button.view(
              {
                onClick: messages.copy("install", "final_cta"),
                toView: ({ button }) =>
                  h.button(
                    [
                      ...button,
                      ...sx(h, landing.pill),
                      h.Attribute("aria-label", `${copy.install_copy_label} bun`),
                    ],
                    [h.span([...sx(h, landing.pillMark)], ["$"]), installCommand],
                  ),
              },
              h,
            ),
          ],
        ),
      ],
    ),
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
    }),
  ];
};
