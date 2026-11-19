import { homeRoute, pageRoute, Locale } from "./routes";
import {
  Animation,
  Button,
  Input,
  Nav,
  Popover,
  Switch,
  Tabs,
  Textarea,
  Tooltip,
} from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import * as Mount from "foldkit/mount";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import en from "../messages/en-US.json";
import pt from "../messages/pt-BR.json";
import { createArticleCatalog } from "./articles";
import {
  SigningFormModel,
  Message as SigningFormMessage,
  signingFormInit,
  signingFormUpdate,
  signingFormView,
} from "./signing-view";
import {
  HomeDemoModel,
  Message as HomeDemoMessage,
  homeDemoInit,
  homeDemoUpdate,
  homeDemoView,
} from "./home-demo";
import { contentPaths, docsNavigation, renderContent, resolveContent } from "./content";
import { SearchQuery, SearchResults, searchDocs } from "./search";
import { SubmitFeedback, SubmitTextFeedback } from "./feedback";
import {
  CopyHome,
  CopyToast,
  ExpireHomeCopy,
  HomeInstallTabs,
  HomeProviderTabs,
  SelectHomeProvider,
  SaveTheme,
  Theme,
  ThemeMount,
  HomeCopyTarget,
  HomeCopyLocation,
  HomeCopyRequest,
  HomeProvider,
  InstallManager,
  firstSignature,
  homeProviders,
  homeView,
  installSnippets,
  signFreeLanding,
} from "./home";
import { siteOrigin } from "./site-origin";
import { darkTheme } from "./styles/tokens.stylex";
import { prose } from "./styles/prose";
import { shell } from "./styles/shell";
import { sx } from "./styles/sx";

export const Flags = Schema.Struct({
  locale: Locale,
  path: Schema.String,
  query: Schema.optional(SearchQuery),
});
export const Model = Schema.Struct({
  locale: Flags.fields.locale,
  path: Schema.String,
  languagePopover: Popover.Model,
  signingForm: SigningFormModel,
  homeDemo: HomeDemoModel,
  theme: Theme,
  query: SearchQuery,
  results: SearchResults,
  feedbackStatus: Schema.Literals(["idle", "sending", "success", "error"]),
  homeProvider: HomeProvider,
  homeCopied: Schema.Union([HomeCopyTarget, Schema.Literals(["none", "failed"])]),
  homeCopyRequest: HomeCopyRequest,
  providerTabs: Tabs.Model,
  installTabs: Tabs.Model,
  installManager: InstallManager,
  openFaq: Schema.Option(Schema.Literals([0, 1, 2])),
  copyToast: CopyToast.Model,
  heroMotion: Animation.Model,
  themeTip: Tooltip.Model,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  GotLanguagePopoverMessage: { message: Popover.Message },
  ThemeToggled: {},
  ThemeLoaded: { theme: Theme },
  ThemeSaved: {},
  GotSigningFormMessage: { message: SigningFormMessage },
  GotHomeDemoMessage: { message: HomeDemoMessage },
  HomeProviderRequested: { provider: HomeProvider },
  HomeProviderSelected: { provider: HomeProvider },
  HomeCopyRequested: { target: HomeCopyTarget, location: HomeCopyLocation },
  HomeCopyFinished: {
    target: HomeCopyTarget,
    request: HomeCopyRequest,
    provider: HomeProvider,
    ok: Schema.Boolean,
  },
  HomeCopyExpired: { request: HomeCopyRequest, provider: HomeProvider },
  QueryChanged: { value: Schema.String },
  SearchSubmitted: {},
  TextFeedbackSubmitted: {},
  FeedbackSubmitted: { opinion: Schema.Literals(["good", "bad"]) },
  FeedbackFinished: { ok: Schema.Boolean },
  GotProviderTabsMessage: { message: Tabs.Message },
  GotInstallTabsMessage: { message: Tabs.Message },
  FaqToggled: { index: Schema.Literals([0, 1, 2]), open: Schema.Boolean },
  GotCopyToastMessage: { message: CopyToast.Message },
  GotHeroMotionMessage: { message: Animation.Message },
  GotThemeTipMessage: { message: Tooltip.Message },
});
export type Message = typeof Message.Type;
export const init = (flags: typeof Flags.Type): { model: Model } => ({
  model: {
    locale: flags.locale,
    path: flags.path,
    languagePopover: Popover.init({ id: "language" }),
    signingForm: signingFormInit(),
    homeDemo: homeDemoInit(),
    theme: "light",
    query: flags.query ?? "",
    results: searchDocs(flags.locale, flags.query ?? ""),
    feedbackStatus: "idle",
    homeProvider: "Clicksign",
    homeCopied: "none",
    homeCopyRequest: 0,
    providerTabs: Tabs.init({ id: "home-providers" }),
    installTabs: Tabs.init({ id: "home-install" }),
    installManager: "bun",
    openFaq: Option.none(),
    copyToast: CopyToast.init({ id: "home-toast", defaultDuration: "1800 millis" }),
    heroMotion: Animation.init({ id: "home-hero", isShowing: true }),
    themeTip: Tooltip.init({ id: "theme-tip", showDelay: "300 millis" }),
  },
});
const foldLanguagePopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.languagePopover),
  write: (model, languagePopover) => ({ ...model, languagePopover }),
  toParentMessage: (message) => Message.GotLanguagePopoverMessage({ message }),
  foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
});
const foldHomeDemo = Update.foldChild({
  update: homeDemoUpdate,
  read: (model: Model) => Option.some(model.homeDemo),
  write: (model, homeDemo) => ({ ...model, homeDemo }),
  toParentMessage: (message) => Message.GotHomeDemoMessage({ message }),
});
const foldProviderTabs = Update.foldChild({
  update: HomeProviderTabs.update,
  read: (model: Model) => Option.some(model.providerTabs),
  write: (model, providerTabs) => ({ ...model, providerTabs }),
  toParentMessage: (message) => Message.GotProviderTabsMessage({ message }),
  foldOutMessage: Tabs.OutMessage.match<Update.Step<Model, Message>>({
    Selected:
      ({ value }) =>
      (model) => {
        const provider = Schema.decodeUnknownOption(HomeProvider)(value);
        return Option.match(provider, {
          onNone: () => ({ model }),
          onSome: (next) =>
            next === model.homeProvider
              ? { model }
              : {
                  model: {
                    ...model,
                    homeProvider: next,
                    homeCopied: "none",
                    homeCopyRequest: model.homeCopyRequest + 1,
                  },
                  commands: [SelectHomeProvider({ provider: next })],
                },
        });
      },
  }),
});
const foldInstallTabs = Update.foldChild({
  update: HomeInstallTabs.update,
  read: (model: Model) => Option.some(model.installTabs),
  write: (model, installTabs) => ({ ...model, installTabs }),
  toParentMessage: (message) => Message.GotInstallTabsMessage({ message }),
  foldOutMessage: Tabs.OutMessage.match<Update.Step<Model, Message>>({
    Selected:
      ({ value }) =>
      (model) => {
        const manager = Schema.decodeUnknownOption(InstallManager)(value);
        return Option.match(manager, {
          onNone: () => ({ model }),
          onSome: (installManager) =>
            installManager === model.installManager
              ? { model }
              : { model: { ...model, installManager, homeCopied: "none" } },
        });
      },
  }),
});
const foldCopyToast = Update.foldChild({
  update: CopyToast.update,
  read: (model: Model) => Option.some(model.copyToast),
  write: (model, copyToast) => ({ ...model, copyToast }),
  toParentMessage: (message) => Message.GotCopyToastMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
const foldHeroMotion = Update.foldChild({
  update: Animation.update,
  read: (model: Model) => Option.some(model.heroMotion),
  write: (model, heroMotion) => ({ ...model, heroMotion }),
  toParentMessage: (message) => Message.GotHeroMotionMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
const foldThemeTip = Update.foldChild({
  update: Tooltip.update,
  read: (model: Model) => Option.some(model.themeTip),
  write: (model, themeTip) => ({ ...model, themeTip }),
  toParentMessage: (message) => Message.GotThemeTipMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotSigningFormMessage: ({ message }) => ({
      model: { ...model, signingForm: signingFormUpdate(model.signingForm, message).model },
    }),
    GotHomeDemoMessage: ({ message }) => foldHomeDemo(model, message),
    GotProviderTabsMessage: ({ message }) => foldProviderTabs(model, message),
    GotInstallTabsMessage: ({ message }) => foldInstallTabs(model, message),
    GotCopyToastMessage: ({ message }) => foldCopyToast(model, message),
    GotHeroMotionMessage: ({ message }) => foldHeroMotion(model, message),
    GotThemeTipMessage: ({ message }) => foldThemeTip(model, message),
    FaqToggled: ({ index, open }) => ({
      model: {
        ...model,
        openFaq: open
          ? Option.some(index)
          : Option.contains(index)(model.openFaq)
            ? Option.none()
            : model.openFaq,
      },
    }),
    HomeProviderRequested: ({ provider }) => ({
      model: {
        ...model,
        homeProvider: provider,
        homeCopied: "none",
        homeCopyRequest: model.homeCopyRequest + 1,
      },
      commands: [SelectHomeProvider({ provider })],
    }),
    HomeProviderSelected: () => ({ model }),
    HomeCopyRequested: ({ target, location }) => {
      const provider = homeProviders.find((entry) => entry.name === model.homeProvider);
      const snippets: Record<typeof HomeCopyTarget.Type, string> = {
        install: installSnippets.bun,
        npm: installSnippets.npm,
        pnpm: installSnippets.pnpm,
        yarn: installSnippets.yarn,
        first: firstSignature,
        provider: provider?.code ?? "",
      };
      const text = snippets[target];
      return {
        model: { ...model, homeCopied: "none", homeCopyRequest: model.homeCopyRequest + 1 },
        commands: [
          CopyHome({
            text,
            target,
            location,
            provider: model.homeProvider,
            filename: provider?.filename ?? "",
            request: model.homeCopyRequest + 1,
          }),
        ],
      };
    },
    HomeCopyFinished: ({ target, ok, request, provider }) => {
      if (request !== model.homeCopyRequest || provider !== model.homeProvider) return { model };
      const notice = model.locale === "pt-BR" ? pt : en;
      const text = ok
        ? notice.showcase_copied
        : model.locale === "pt-BR"
          ? "Não foi possível copiar."
          : "Could not copy.";
      const shown = CopyToast.show(model.copyToast, {
        payload: { text },
        variant: "Info",
        duration: "1800 millis",
      });
      return {
        model: { ...model, homeCopied: ok ? target : "failed", copyToast: shown.model },
        commands: [
          ExpireHomeCopy({ request, provider }),
          ...Command.mapMessages(shown.commands, (message) =>
            Message.GotCopyToastMessage({ message }),
          ),
        ],
      };
    },
    HomeCopyExpired: ({ request, provider }) => ({
      model:
        request === model.homeCopyRequest && provider === model.homeProvider
          ? { ...model, homeCopied: "none" }
          : model,
    }),
    TextFeedbackSubmitted: () => ({
      model: { ...model, feedbackStatus: "sending" },
      commands: [
        SubmitTextFeedback({
          route:
            model.path === ""
              ? homeRoute({ locale: model.locale })
              : pageRoute({ locale: model.locale, path: model.path.slice(1) }),
        }),
      ],
    }),
    FeedbackSubmitted: ({ opinion }) => ({
      model: { ...model, feedbackStatus: "sending" },
      commands: [
        SubmitFeedback({
          route:
            model.path === ""
              ? homeRoute({ locale: model.locale })
              : pageRoute({ locale: model.locale, path: model.path.slice(1) }),
          opinion,
        }),
      ],
    }),
    FeedbackFinished: ({ ok }) => ({
      model: { ...model, feedbackStatus: ok ? "success" : "error" },
    }),
    QueryChanged: ({ value }) => {
      const query = value.slice(0, 200);
      return { model: { ...model, query, results: searchDocs(model.locale, query) } };
    },
    SearchSubmitted: () => ({
      model: { ...model, results: searchDocs(model.locale, model.query) },
    }),
    GotLanguagePopoverMessage: ({ message }) => foldLanguagePopover(model, message),
    ThemeToggled: () => {
      const theme = model.theme === "light" ? "dark" : "light";
      return { model: { ...model, theme }, commands: [SaveTheme({ theme })] };
    },
    ThemeLoaded: ({ theme }) => ({ model: { ...model, theme } }),
    ThemeSaved: () => ({ model }),
  });
export const createView = (source: {
  paths: typeof contentPaths;
  resolve: typeof resolveContent;
}) => {
  const { articles, blogTags, resolveArticle } = createArticleCatalog(source);
  return (model: Model, h: HtmlBuilder<Message>): Document => {
    const copy = model.locale === "pt-BR" ? pt : en;

    const signing =
      (model.locale === "pt-BR" && model.path === "/assine-documentos-gratis") ||
      (model.locale === "en-US" && model.path === "/sign-free");
    const docs = model.path === "/docs" || model.path.startsWith("/docs/");
    const content = docs ? source.resolve(model.locale, "docs", model.path.slice(6)) : undefined;
    const section =
      model.path === "/blog" || model.path.startsWith("/blog/")
        ? "blog"
        : model.path === "/changelog" || model.path.startsWith("/changelog/")
          ? "changelog"
          : undefined;
    const tagRoute = model.path === "/blog/tags" || model.path.startsWith("/blog/tags/");
    const tag =
      tagRoute && model.path !== "/blog/tags"
        ? blogTags(model.locale).find(
            (entry) => encodeURIComponent(entry.slug) === model.path.slice(11),
          )
        : undefined;
    const articleSlug =
      section !== undefined
        ? articles(model.locale, section).find(
            (entry) =>
              entry.href ===
              (model.path === ""
                ? homeRoute({ locale: model.locale })
                : pageRoute({ locale: model.locale, path: model.path.slice(1) })),
          )?.slug
        : undefined;
    const article =
      section !== undefined && articleSlug !== undefined && articleSlug !== "" && !tagRoute
        ? resolveArticle(model.locale, section, articleSlug)
        : undefined;
    const sourceLocale =
      article !== undefined &&
      model.locale === "pt-BR" &&
      section !== undefined &&
      source.resolve("pt-BR", section, articleSlug ?? "") === undefined
        ? "en-US"
        : model.locale;
    const canonical = `${siteOrigin}${model.path === "" ? homeRoute({ locale: sourceLocale }) : pageRoute({ locale: sourceLocale, path: model.path.slice(1) })}`;
    const searchSuffix =
      model.path === "/search" && model.query !== ""
        ? `?${new URLSearchParams({ q: model.query })}`
        : "";
    const languagePath = (locale: "en-US" | "pt-BR") => {
      if (signing) return locale === "pt-BR" ? "/assine-documentos-gratis" : "/sign-free";
      if (
        tagRoute &&
        model.path !== "/blog/tags" &&
        !blogTags(locale).some((entry) => encodeURIComponent(entry.slug) === model.path.slice(11))
      )
        return "/blog/tags";
      return model.path;
    };
    const heading = section === "blog" ? "Blog" : "Changelog";
    return {
      title: tagRoute
        ? `${tag?.tag ?? (model.locale === "pt-BR" ? "Tags do blog" : "Blog tags")} | SignatureKit`
        : signing
          ? model.locale === "pt-BR"
            ? "Assine documentos grátis com certificado A1 | SignatureKit"
            : "Sign documents for free — SignatureKit"
          : article !== undefined
            ? `${article.title} — SignatureKit`
            : section !== undefined
              ? `${heading} — SignatureKit`
              : content !== undefined
                ? `${content.title} — SignatureKit`
                : model.locale === "pt-BR"
                  ? "SignatureKit — Assinaturas digitais nativas em Effect para TypeScript"
                  : "SignatureKit — Effect-native digital signatures for TypeScript",
      lang: model.locale,
      canonical,
      ogUrl: canonical,
      body: h.div(
        [
          ...sx(h, "site", shell.site, model.theme === "dark" && darkTheme),
          h.Attribute("data-theme", model.theme),
          h.OnMount(Mount.mapMessage(ThemeMount(), ({ theme }) => Message.ThemeLoaded({ theme }))),
        ],
        [
          h.header(
            [...sx(h, "header", shell.header)],
            [
              h.a(
                [...sx(h, "brand", shell.brand), h.Href(homeRoute({ locale: model.locale }))],
                ["SignatureKit"],
              ),
              h.form(
                [
                  ...sx(h, shell.searchForm),
                  h.Attribute("method", "get"),
                  h.Attribute("action", pageRoute({ locale: model.locale, path: "search" })),
                  h.Attribute("role", "search"),
                ],
                [
                  Input.view(
                    {
                      id: "header-search",
                      name: "q",
                      type: "search",
                      toView: ({ input }) =>
                        h.input([
                          ...input,
                          ...sx(h, shell.searchInput),
                          h.Attribute("aria-label", model.locale === "pt-BR" ? "Buscar" : "Search"),
                          h.Attribute(
                            "placeholder",
                            model.locale === "pt-BR" ? "Buscar" : "Search",
                          ),
                        ]),
                    },
                    h,
                  ),
                ],
              ),
              Nav.view({
                items: [
                  `${homeRoute({ locale: model.locale })}#providers`,
                  `${homeRoute({ locale: model.locale })}#capabilities`,
                  pageRoute({ locale: model.locale, path: "docs" }),
                  pageRoute({ locale: model.locale, path: "search" }),
                  pageRoute({ locale: model.locale, path: "blog" }),
                  pageRoute({ locale: model.locale, path: "changelog" }),
                  "https://github.com/Licitei/signature-kit",
                ],
                ariaLabel: model.locale === "pt-BR" ? "Navegação principal" : "Primary navigation",
                toHref: (item) => item,
                isItemCurrent: (item) =>
                  item ===
                  (model.path === ""
                    ? homeRoute({ locale: model.locale })
                    : pageRoute({ locale: model.locale, path: model.path.slice(1) })),
                toView: ({ nav, items }) =>
                  h.nav(
                    [...nav, ...sx(h, "navigation", shell.navigation)],
                    [
                      ...items.map((item) =>
                        h.a(
                          [...item.link, ...sx(h, shell.navLink)],
                          [
                            [
                              copy.nav_providers,
                              model.locale === "pt-BR" ? "Recursos" : "Capabilities",
                              copy.hero_cta_docs,
                              model.locale === "pt-BR" ? "Buscar" : "Search",
                              "Blog",
                              "Changelog",
                              "GitHub",
                            ][item.index] ?? "",
                          ],
                        ),
                      ),
                      h.submodel({
                        slotId: "theme-tip",
                        model: model.themeTip,
                        view: Tooltip.view,
                        viewInputs: {
                          anchor: { placement: "bottom", gap: 8, padding: 8, portal: false },
                          toView: ({ trigger, panel, isVisible }) =>
                            h.span(
                              [],
                              [
                                Switch.view(
                                  {
                                    id: "theme-switch",
                                    isChecked: model.theme === "dark",
                                    onToggle: () => Message.ThemeToggled(),
                                    toView: ({ button }) =>
                                      h.button(
                                        [
                                          ...button,
                                          ...trigger,
                                          ...sx(h, shell.iconButton),
                                          h.Attribute(
                                            "aria-label",
                                            model.locale === "pt-BR"
                                              ? "Alternar tema"
                                              : "Toggle theme",
                                          ),
                                        ],
                                        [model.theme === "light" ? "☾" : "☀"],
                                      ),
                                  },
                                  h,
                                ),
                                ...(isVisible
                                  ? [
                                      h.div(
                                        [...panel, ...sx(h, shell.tooltip)],
                                        [model.locale === "pt-BR" ? "Tema" : "Theme"],
                                      ),
                                    ]
                                  : []),
                              ],
                            ),
                        },
                        toParentMessage: (message) => Message.GotThemeTipMessage({ message }),
                      }),
                      h.submodel({
                        slotId: "language",
                        model: model.languagePopover,
                        view: Popover.view,
                        viewInputs: {
                          ariaLabel: model.locale === "pt-BR" ? "Idioma" : "Language",
                          anchor: { placement: "bottom-start", gap: 4, padding: 8, portal: false },
                          toView: ({ button, panel, backdrop, isVisible }) =>
                            h.div(
                              [],
                              [
                                h.button(
                                  [...button, ...sx(h, "language", shell.language)],
                                  [model.locale],
                                ),
                                ...(isVisible
                                  ? [
                                      h.div(backdrop),
                                      h.div(
                                        [...panel, ...sx(h, "languages", shell.languages)],
                                        [
                                          h.a(
                                            [
                                              h.Href(
                                                (languagePath("en-US") === ""
                                                  ? homeRoute({ locale: "en-US" })
                                                  : pageRoute({
                                                      locale: "en-US",
                                                      path: languagePath("en-US").slice(1),
                                                    })) + searchSuffix,
                                              ),
                                              h.Lang("en-US"),
                                            ],
                                            ["English"],
                                          ),
                                          h.a(
                                            [
                                              h.Href(
                                                (languagePath("pt-BR") === ""
                                                  ? homeRoute({ locale: "pt-BR" })
                                                  : pageRoute({
                                                      locale: "pt-BR",
                                                      path: languagePath("pt-BR").slice(1),
                                                    })) + searchSuffix,
                                              ),
                                              h.Lang("pt-BR"),
                                            ],
                                            ["Português"],
                                          ),
                                        ],
                                      ),
                                    ]
                                  : []),
                              ],
                            ),
                        },
                        toParentMessage: (message) =>
                          Message.GotLanguagePopoverMessage({ message }),
                      }),
                    ],
                  ),
              }),
            ],
          ),
          h.main(
            [],
            model.path === "/search"
              ? [
                  h.section(
                    [...sx(h, "docs-content", prose.content)],
                    [
                      h.h1(
                        [],
                        [
                          model.locale === "pt-BR"
                            ? "Buscar na documentação"
                            : "Search documentation",
                        ],
                      ),
                      h.form(
                        [
                          h.Attribute("method", "get"),
                          h.Attribute(
                            "action",
                            pageRoute({ locale: model.locale, path: "search" }),
                          ),
                          h.Attribute("role", "search"),
                          h.OnSubmit(Message.SearchSubmitted()),
                        ],
                        [
                          Input.view(
                            {
                              id: "docs-search",
                              name: "q",
                              type: "search",
                              value: model.query,
                              onInput: (value) => Message.QueryChanged({ value }),
                              toView: (attributes) =>
                                h.label(attributes.label, [
                                  model.locale === "pt-BR" ? "Termos de busca" : "Search terms",
                                  h.input([
                                    ...attributes.input,
                                    h.Attribute("maxlength", "200"),
                                    h.Class("ph-no-capture"),
                                  ]),
                                ]),
                            },
                            h,
                          ),
                          Button.view(
                            {
                              type: "submit",
                              toView: (attributes) =>
                                h.button(attributes.button, [
                                  model.locale === "pt-BR" ? "Buscar" : "Search",
                                ]),
                            },
                            h,
                          ),
                        ],
                      ),
                      model.query.trim() === ""
                        ? h.p(
                            [],
                            [
                              model.locale === "pt-BR"
                                ? "Digite um termo para buscar."
                                : "Enter a search term.",
                            ],
                          )
                        : model.results.length === 0
                          ? h.p(
                              [],
                              [
                                model.locale === "pt-BR"
                                  ? "Nenhum resultado encontrado."
                                  : "No results found.",
                              ],
                            )
                          : h.ul(
                              [],
                              model.results.map((result) =>
                                h.li(
                                  [],
                                  [
                                    h.a(
                                      [h.Href(result.href)],
                                      [
                                        result.title,
                                        ...(result.heading !== "" ? [` — ${result.heading}`] : []),
                                      ],
                                    ),
                                    h.p([], [result.excerpt]),
                                  ],
                                ),
                              ),
                            ),
                    ],
                  ),
                ]
              : tagRoute
                ? [
                    h.article(
                      [...sx(h, "docs-content", prose.content)],
                      [
                        h.h1(
                          [],
                          [
                            tag !== undefined
                              ? tag.tag
                              : model.locale === "pt-BR"
                                ? "Tags do blog"
                                : "Blog tags",
                          ],
                        ),
                        h.p(
                          [],
                          [
                            model.locale === "pt-BR"
                              ? "Explore os artigos por assunto."
                              : "Explore articles by topic.",
                          ],
                        ),
                        h.ul(
                          [],
                          tag !== undefined
                            ? tag.entries.map((entry) =>
                                h.li([], [h.a([h.Href(entry.href)], [entry.title])]),
                              )
                            : blogTags(model.locale).map((entry) =>
                                h.li(
                                  [],
                                  [
                                    h.a(
                                      [
                                        h.Href(
                                          pageRoute({
                                            locale: model.locale,
                                            path: `blog/tags/${encodeURIComponent(entry.slug)}`,
                                          }),
                                        ),
                                      ],
                                      [entry.tag],
                                    ),
                                  ],
                                ),
                              ),
                        ),
                      ],
                    ),
                  ]
                : signing
                  ? [
                      h.div(
                        [h.Class("ph-no-capture"), h.Attribute("data-analytics-sensitive", "true")],
                        model.locale === "pt-BR"
                          ? signFreeLanding(
                              h,
                              h.submodel({
                                slotId: "signing-form",
                                model: model.signingForm,
                                view: signingFormView,
                                viewInputs: { locale: model.locale, embedded: false },
                                toParentMessage: (message) =>
                                  Message.GotSigningFormMessage({ message }),
                              }),
                              {
                                open: model.openFaq,
                                toggle: (index, open) => Message.FaqToggled({ index, open }),
                              },
                            )
                          : [
                              h.submodel({
                                slotId: "signing-form",
                                model: model.signingForm,
                                view: signingFormView,
                                viewInputs: { locale: model.locale, embedded: false },
                                toParentMessage: (message) =>
                                  Message.GotSigningFormMessage({ message }),
                              }),
                            ],
                      ),
                    ]
                  : section !== undefined
                    ? [
                        h.article(
                          [...sx(h, "docs-content", prose.content)],
                          article !== undefined
                            ? [
                                h.h1([], [article.title]),
                                ...(article.date !== "" ? [h.p([], [article.date])] : []),
                                ...(article.description !== undefined && article.description !== ""
                                  ? [h.p([], [article.description])]
                                  : []),
                                ...renderContent(article.nodes, h),
                              ]
                            : [
                                h.h1([], [heading]),
                                ...(section === "blog"
                                  ? [
                                      h.a(
                                        [
                                          h.Href(
                                            pageRoute({ locale: model.locale, path: "blog/tags" }),
                                          ),
                                        ],
                                        [model.locale === "pt-BR" ? "Tags do blog" : "Blog tags"],
                                      ),
                                    ]
                                  : []),
                                h.p(
                                  [],
                                  [
                                    section === "blog"
                                      ? model.locale === "pt-BR"
                                        ? "Artigos sobre assinaturas digitais e SignatureKit."
                                        : "Articles about digital signatures and SignatureKit."
                                      : model.locale === "pt-BR"
                                        ? "Notas de versão dos pacotes SignatureKit."
                                        : "Release notes for SignatureKit packages.",
                                  ],
                                ),
                                h.ul(
                                  [],
                                  articles(model.locale, section).map((entry) =>
                                    h.li(
                                      [],
                                      [
                                        h.a([h.Href(entry.href)], [entry.title]),
                                        ...(entry.date !== "" ? [h.p([], [entry.date])] : []),
                                        ...(entry.description !== undefined &&
                                        entry.description !== ""
                                          ? [h.p([], [entry.description])]
                                          : []),
                                      ],
                                    ),
                                  ),
                                ),
                              ],
                        ),
                      ]
                    : docs && content !== undefined
                      ? [
                          h.div(
                            [...sx(h, "docs-layout", prose.layout)],
                            [
                              h.div(
                                [...sx(h, "docs-navigation", prose.navigation)],
                                docsNavigation(model.locale).map((group) =>
                                  Nav.view({
                                    items: group.links.map((link) => link.href),
                                    ariaLabel: group.title,
                                    toHref: (href) => href,
                                    isItemCurrent: (href) =>
                                      href ===
                                      pageRoute({
                                        locale: model.locale,
                                        path: model.path.slice(1),
                                      }),
                                    toView: ({ nav, items }) =>
                                      h.nav(
                                        [...nav],
                                        [
                                          h.h2([...sx(h, prose.navTitle)], [group.title]),
                                          h.ul(
                                            [...sx(h, prose.navList)],
                                            items.map((item) =>
                                              h.li(
                                                [],
                                                [
                                                  h.a(
                                                    [...item.link, ...sx(h, prose.navLink)],
                                                    [group.links[item.index]?.title ?? ""],
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                  }),
                                ),
                              ),
                              h.article(
                                [...sx(h, "docs-content", prose.content)],
                                [
                                  h.div(
                                    [h.Attribute("data-feedback-content", "")],
                                    [
                                      h.h1([], [content.title]),
                                      ...(content.description !== undefined &&
                                      content.description !== ""
                                        ? [h.p([], [content.description])]
                                        : []),
                                      ...renderContent(content.nodes, h),
                                    ],
                                  ),
                                  h.section(
                                    [
                                      h.Class("ph-no-capture"),
                                      h.Attribute("data-analytics-sensitive", "true"),
                                    ],
                                    [
                                      h.h2(
                                        [],
                                        [
                                          model.locale === "pt-BR"
                                            ? "Como está este guia?"
                                            : "How is this guide?",
                                        ],
                                      ),
                                      Textarea.view(
                                        {
                                          id: "feedback-message",
                                          toView: (attributes) =>
                                            h.textarea([
                                              ...attributes.textarea,
                                              h.Attribute("data-feedback-message", ""),
                                              h.Attribute("maxlength", "2000"),
                                              h.Attribute(
                                                "aria-label",
                                                model.locale === "pt-BR" ? "Comentário" : "Comment",
                                              ),
                                            ]),
                                        },
                                        h,
                                      ),
                                      Button.view(
                                        {
                                          onClick: Message.FeedbackSubmitted({ opinion: "good" }),
                                          toView: (attributes) =>
                                            h.button(attributes.button, [
                                              model.locale === "pt-BR" ? "Bom" : "Good",
                                            ]),
                                        },
                                        h,
                                      ),
                                      Button.view(
                                        {
                                          onClick: Message.FeedbackSubmitted({ opinion: "bad" }),
                                          toView: (attributes) =>
                                            h.button(attributes.button, [
                                              model.locale === "pt-BR" ? "Ruim" : "Bad",
                                            ]),
                                        },
                                        h,
                                      ),
                                      Button.view(
                                        {
                                          onClick: Message.TextFeedbackSubmitted(),
                                          toView: (attributes) =>
                                            h.button(attributes.button, [
                                              model.locale === "pt-BR"
                                                ? "Enviar sobre texto selecionado"
                                                : "Send about selected text",
                                            ]),
                                        },
                                        h,
                                      ),
                                      h.p(
                                        [h.Attribute("role", "status")],
                                        [
                                          model.feedbackStatus === "success"
                                            ? model.locale === "pt-BR"
                                              ? "Obrigado pelo feedback!"
                                              : "Thank you for your feedback!"
                                            : model.feedbackStatus === "error"
                                              ? model.locale === "pt-BR"
                                                ? "Não foi possível enviar. Tente novamente."
                                                : "Could not send feedback. Please try again."
                                              : model.feedbackStatus === "sending"
                                                ? model.locale === "pt-BR"
                                                  ? "Enviando…"
                                                  : "Sending…"
                                                : "",
                                        ],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ]
                      : [
                          ...homeView(
                            h,
                            {
                              locale: model.locale,
                              provider: model.homeProvider,
                              copied: model.homeCopied,
                              installManager: model.installManager,
                              providerTabs: model.providerTabs,
                              installTabs: model.installTabs,
                              heroMotion: model.heroMotion,
                              copyToast: model.copyToast,
                            },
                            h.submodel({
                              slotId: "signing-form",
                              model: model.signingForm,
                              view: signingFormView,
                              viewInputs: { locale: model.locale, embedded: true },
                              toParentMessage: (message) =>
                                Message.GotSigningFormMessage({ message }),
                            }),
                            h.submodel({
                              slotId: "home-demo",
                              model: model.homeDemo,
                              view: homeDemoView,
                              viewInputs: { locale: model.locale },
                              toParentMessage: (message) => Message.GotHomeDemoMessage({ message }),
                            }),
                            {
                              select: (provider) => Message.HomeProviderRequested({ provider }),
                              copy: (target, location) =>
                                Message.HomeCopyRequested({ target, location }),
                              gotProviderTabs: (message) =>
                                Message.GotProviderTabsMessage({ message }),
                              gotInstallTabs: (message) =>
                                Message.GotInstallTabsMessage({ message }),
                              gotHeroMotion: (message) => Message.GotHeroMotionMessage({ message }),
                              gotCopyToast: (message) => Message.GotCopyToastMessage({ message }),
                            },
                          ),
                        ],
          ),
          h.footer(
            [...sx(h, "footer", shell.footer)],
            [
              h.div([], [h.strong([], ["SignatureKit"]), h.p([], [copy.footer_brand_blurb])]),
              Nav.view({
                items: [
                  pageRoute({ locale: model.locale, path: "docs/get-started/quickstart" }),
                  pageRoute({ locale: model.locale, path: "docs/signing/signers" }),
                  pageRoute({ locale: model.locale, path: "docs/signing/pdf" }),
                  pageRoute({ locale: model.locale, path: "docs/signing/xml" }),
                  pageRoute({ locale: model.locale, path: "docs/signing/errors" }),
                ],
                ariaLabel: copy.footer_col_docs,
                toHref: (item) => item,
                isItemCurrent: (item) =>
                  item ===
                  (model.path === ""
                    ? homeRoute({ locale: model.locale })
                    : pageRoute({ locale: model.locale, path: model.path.slice(1) })),
                toView: ({ nav, items }) =>
                  h.nav(
                    [...nav, ...sx(h, shell.footerNav)],
                    items.map((item) =>
                      h.a(
                        [...item.link, ...sx(h, shell.footerLink)],
                        [
                          [
                            copy.footer_link_quickstart,
                            copy.footer_link_signing_boundary,
                            copy.footer_link_pdf,
                            copy.footer_link_xml,
                            copy.footer_link_errors,
                          ][item.index] ?? "",
                        ],
                      ),
                    ),
                  ),
              }),
              Nav.view({
                items: [
                  pageRoute({ locale: model.locale, path: "docs/providers/request-shape" }),
                  pageRoute({ locale: model.locale, path: "blog" }),
                  pageRoute({ locale: model.locale, path: "changelog" }),
                  "https://github.com/Licitei/signature-kit",
                  "https://github.com/Licitei/signature-kit/issues",
                ],
                ariaLabel: copy.footer_col_project,
                toHref: (item) => item,
                isItemCurrent: (item) =>
                  item ===
                  (model.path === ""
                    ? homeRoute({ locale: model.locale })
                    : pageRoute({ locale: model.locale, path: model.path.slice(1) })),
                toView: ({ nav, items }) =>
                  h.nav(
                    [...nav, ...sx(h, shell.footerNav)],
                    items.map((item) =>
                      h.a(
                        [...item.link, ...sx(h, shell.footerLink)],
                        [
                          [
                            copy.footer_col_providers,
                            copy.footer_link_blog,
                            "Changelog",
                            copy.footer_link_github,
                            copy.footer_link_issues,
                          ][item.index] ?? "",
                        ],
                      ),
                    ),
                  ),
              }),
              h.p(
                [...sx(h, shell.footerMeta)],
                [
                  copy.footer_attribution_prefix,
                  " ",
                  h.a([h.Href("https://licitei.com.br")], ["Licitei"]),
                  " · ",
                  copy.footer_copyright,
                ],
              ),
            ],
          ),
        ],
      ),
    };
  };
};
export const view = createView({ paths: contentPaths, resolve: resolveContent });
