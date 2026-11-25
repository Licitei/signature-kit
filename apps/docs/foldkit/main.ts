import { homeRoute, pageRoute, Locale } from "./routes";
import { Button, Dialog, Input, Nav, Popover, Switch, Textarea, Tooltip } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Dom, Subscription, Update } from "foldkit";
import * as Mount from "foldkit/mount";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import en from "../messages/en-US.json";
import pt from "../messages/pt-BR.json";
import { createArticleCatalog } from "./articles";
import { contentPaths, docsNavigation, renderContent, resolveContent } from "./content";
import { SearchQuery, SearchResults, searchDocs } from "./search";
import { SubmitFeedback, SubmitTextFeedback } from "./feedback";
import { brandMark, homeView, SaveTheme, Theme, ThemeMount } from "./home";
import { OverlayKind, overlayView } from "./overlay";
import { siteOrigin } from "./site-origin";
import { overlay } from "./styles/overlay";
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
  theme: Theme,
  query: SearchQuery,
  results: SearchResults,
  feedbackStatus: Schema.Literals(["idle", "sending", "success", "error"]),
  overlay: Dialog.Model,
  overlayKind: OverlayKind,
  themeTip: Tooltip.Model,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  GotLanguagePopoverMessage: { message: Popover.Message },
  ThemeToggled: {},
  ThemeLoaded: { theme: Theme },
  ThemeSaved: {},
  QueryChanged: { value: Schema.String },
  SearchSubmitted: {},
  TextFeedbackSubmitted: {},
  FeedbackSubmitted: { opinion: Schema.Literals(["good", "bad"]) },
  FeedbackFinished: { ok: Schema.Boolean },
  OverlayRequested: { kind: OverlayKind },
  OverlayCloseRequested: {},
  GotOverlayMessage: { message: Dialog.Message },
  GotThemeTipMessage: { message: Tooltip.Message },
});
export type Message = typeof Message.Type;
export const init = (flags: typeof Flags.Type): { model: Model } => ({
  model: {
    locale: flags.locale,
    path: flags.path,
    languagePopover: Popover.init({ id: "language" }),
    theme: "light",
    query: flags.query ?? "",
    results: searchDocs(flags.locale, flags.query ?? ""),
    feedbackStatus: "idle",
    overlay: Dialog.init({
      id: "site-overlay",
      isAnimated: true,
      focusSelector: "[data-overlay-focus]",
    }),
    overlayKind: "menu",
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
const foldOverlay = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.overlay),
  write: (model, overlay) => ({ ...model, overlay }),
  toParentMessage: (message) => Message.GotOverlayMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
const openOverlay = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.overlay),
  write: (model, overlay) => ({ ...model, overlay }),
  toParentMessage: (message) => Message.GotOverlayMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
const closeOverlay = Update.foldChildStep({
  update: Dialog.close,
  read: (model: Model) => Option.some(model.overlay),
  write: (model, overlay) => ({ ...model, overlay }),
  toParentMessage: (message) => Message.GotOverlayMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  searchShortcut: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Dom.streamFromEventFilterMapPreventDefault({
          target: () => document,
          type: "keydown",
          filterMapEvent: (event) =>
            (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"
              ? Option.some(Message.OverlayRequested({ kind: "search" }))
              : Option.none(),
        }),
    },
  ),
}));
const foldThemeTip = Update.foldChild({
  update: Tooltip.update,
  read: (model: Model) => Option.some(model.themeTip),
  write: (model, themeTip) => ({ ...model, themeTip }),
  toParentMessage: (message) => Message.GotThemeTipMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
});
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotOverlayMessage: ({ message }) => foldOverlay(model, message),
    OverlayRequested: ({ kind }) =>
      model.overlay.isOpen
        ? { model: { ...model, overlayKind: kind } }
        : openOverlay({ ...model, overlayKind: kind }),
    OverlayCloseRequested: () => closeOverlay(model),
    GotThemeTipMessage: ({ message }) => foldThemeTip(model, message),
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
      if (
        tagRoute &&
        model.path !== "/blog/tags" &&
        !blogTags(locale).some((entry) => encodeURIComponent(entry.slug) === model.path.slice(11))
      )
        return "/blog/tags";
      return model.path;
    };
    const heading = section === "blog" ? "Blog" : "Changelog";
    const currentRoute =
      model.path === ""
        ? homeRoute({ locale: model.locale })
        : pageRoute({ locale: model.locale, path: model.path.slice(1) });
    const footerColumns = [
      {
        title: copy.footer_nav_product,
        links: [{ label: copy.nav_docs, href: pageRoute({ locale: model.locale, path: "docs" }) }],
      },
      {
        title: copy.footer_nav_resources,
        links: [
          { label: "Blog", href: pageRoute({ locale: model.locale, path: "blog" }) },
          { label: "Changelog", href: pageRoute({ locale: model.locale, path: "changelog" }) },
          { label: copy.footer_search, href: pageRoute({ locale: model.locale, path: "search" }) },
        ],
      },
      {
        title: copy.footer_nav_project,
        links: [
          { label: "GitHub", href: "https://github.com/Licitei/signature-kit" },
          { label: copy.footer_issues, href: "https://github.com/Licitei/signature-kit/issues" },
          { label: "Licitei", href: "https://licitei.com.br" },
        ],
      },
    ];
    return {
      title: tagRoute
        ? `${tag?.tag ?? (model.locale === "pt-BR" ? "Tags do blog" : "Blog tags")} | SignatureKit`
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
                [brandMark(h), "SignatureKit"],
              ),
              Nav.view({
                items: [
                  pageRoute({ locale: model.locale, path: "docs" }),
                  pageRoute({ locale: model.locale, path: "blog" }),
                  pageRoute({ locale: model.locale, path: "changelog" }),
                ],
                ariaLabel: model.locale === "pt-BR" ? "Navegação principal" : "Primary navigation",
                toHref: (item) => item,
                isItemCurrent: (item) => item === currentRoute,
                toView: ({ nav, items }) =>
                  h.nav(
                    [...nav, ...sx(h, "navigation", shell.navigation)],
                    items.map((item) =>
                      h.a(
                        [...item.link, ...sx(h, shell.navLink)],
                        [[copy.nav_docs, "Blog", "Changelog"][item.index] ?? ""],
                      ),
                    ),
                  ),
              }),
              h.div(
                [...sx(h, shell.headerEnd)],
                [
                  h.a(
                    [
                      ...sx(h, shell.searchButton),
                      h.Href(pageRoute({ locale: model.locale, path: "search" })),
                      h.Attribute("data-overlay", "search"),
                      h.AriaKeyshortcuts("Meta+K Control+K"),
                      h.OnClick(Message.OverlayRequested({ kind: "search" }), {
                        defaultAction: "Prevent",
                      }),
                    ],
                    [
                      h.span([...sx(h, shell.wideOnly)], [copy.footer_search]),
                      h.kbd([...sx(h, shell.kbd)], ["⌘K"]),
                    ],
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
                                        model.locale === "pt-BR" ? "Alternar tema" : "Toggle theme",
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
                                          ...sx(h, shell.languageLink),
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
                                          ...sx(h, shell.languageLink),
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
                    toParentMessage: (message) => Message.GotLanguagePopoverMessage({ message }),
                  }),
                  h.a(
                    [
                      ...sx(h, shell.pill, shell.wideOnly),
                      h.Href("https://github.com/Licitei/signature-kit"),
                    ],
                    ["GitHub"],
                  ),
                  h.a(
                    [
                      ...sx(h, shell.pill, shell.compactOnly),
                      h.Href("#site-footer"),
                      h.Attribute("data-overlay", "menu"),
                      h.AriaLabel(copy.menu),
                      h.OnClick(Message.OverlayRequested({ kind: "menu" }), {
                        defaultAction: "Prevent",
                      }),
                    ],
                    ["☰"],
                  ),
                ],
              ),
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
                                    ...sx(h, "ph-no-capture", prose.feedback),
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
                                          h.button(
                                            [...attributes.button, ...sx(h, shell.ghost)],
                                            [model.locale === "pt-BR" ? "Bom" : "Good"],
                                          ),
                                      },
                                      h,
                                    ),
                                    Button.view(
                                      {
                                        onClick: Message.FeedbackSubmitted({ opinion: "bad" }),
                                        toView: (attributes) =>
                                          h.button(
                                            [...attributes.button, ...sx(h, shell.ghost)],
                                            [model.locale === "pt-BR" ? "Ruim" : "Bad"],
                                          ),
                                      },
                                      h,
                                    ),
                                    Button.view(
                                      {
                                        onClick: Message.TextFeedbackSubmitted(),
                                        toView: (attributes) =>
                                          h.button(
                                            [...attributes.button, ...sx(h, shell.ghost)],
                                            [
                                              model.locale === "pt-BR"
                                                ? "Enviar sobre texto selecionado"
                                                : "Send about selected text",
                                            ],
                                          ),
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
                    : [homeView(h, model.locale)],
          ),
          h.footer(
            [...sx(h, "footer", shell.footer), h.Id("site-footer")],
            [
              h.div(
                [...sx(h, shell.footerColumns)],
                footerColumns.map((column) =>
                  Nav.view({
                    items: column.links.map((link) => link.href),
                    ariaLabel: column.title,
                    toHref: (item) => item,
                    isItemCurrent: (item) => item === currentRoute,
                    toView: ({ nav, items }) =>
                      h.nav(
                        [...nav, ...sx(h, shell.footerNav)],
                        [
                          h.h2([...sx(h, shell.footerTitle)], [column.title]),
                          ...items.map((item) =>
                            h.a(
                              [...item.link, ...sx(h, shell.footerLink)],
                              [column.links[item.index]?.label ?? ""],
                            ),
                          ),
                        ],
                      ),
                  }),
                ),
              ),
              h.div(
                [...sx(h, shell.footerBottom)],
                [
                  h.a(
                    [...sx(h, shell.brand), h.Href(homeRoute({ locale: model.locale }))],
                    [brandMark(h), "SignatureKit"],
                  ),
                  h.p([...sx(h, shell.footerMeta)], [copy.footer_copyright]),
                ],
              ),
            ],
          ),
          overlayView(h, {
            model: model.overlay,
            kind: model.overlayKind,
            title: {
              menu: copy.menu,
              search: copy.footer_search,
            }[model.overlayKind],
            closeLabel: copy.overlay_close,
            toParentMessage: (message) => Message.GotOverlayMessage({ message }),
            panels: [
              [
                "menu",
                h.div(
                  [...sx(h, overlay.stack)],
                  [
                    h.ul(
                      [...sx(h, overlay.links)],
                      [
                        [copy.nav_docs, pageRoute({ locale: model.locale, path: "docs" })],
                        ["Blog", pageRoute({ locale: model.locale, path: "blog" })],
                        ["Changelog", pageRoute({ locale: model.locale, path: "changelog" })],
                        ["GitHub", "https://github.com/Licitei/signature-kit"],
                      ].map(([label, href]) =>
                        h.li(
                          [],
                          [
                            h.a(
                              [
                                ...sx(h, overlay.link),
                                h.Href(href ?? ""),
                                h.OnClick(Message.OverlayCloseRequested()),
                              ],
                              [label ?? ""],
                            ),
                          ],
                        ),
                      ),
                    ),
                    ...(docs
                      ? docsNavigation(model.locale).map((group) =>
                          h.div(
                            [],
                            [
                              h.p([...sx(h, overlay.group)], [group.title]),
                              h.ul(
                                [...sx(h, overlay.links)],
                                group.links.map((link) =>
                                  h.li(
                                    [],
                                    [
                                      h.a(
                                        [
                                          ...sx(h, overlay.link),
                                          h.Href(link.href),
                                          ...(link.href === currentRoute
                                            ? [h.AriaCurrent("page")]
                                            : []),
                                        ],
                                        [link.title],
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ],
                          ),
                        )
                      : []),
                  ],
                ),
              ],
              [
                "search",
                h.form(
                  [
                    ...sx(h, overlay.stack),
                    h.Attribute("method", "get"),
                    h.Attribute("action", pageRoute({ locale: model.locale, path: "search" })),
                    h.Attribute("role", "search"),
                  ],
                  [
                    Input.view(
                      {
                        id: "overlay-search",
                        name: "q",
                        type: "text",
                        value: model.query,
                        onInput: (value) => Message.QueryChanged({ value }),
                        toView: ({ input }) =>
                          h.input([
                            ...input,
                            ...sx(h, "ph-no-capture", overlay.search),
                            h.DataAttribute("overlay-focus", ""),
                            h.Attribute("maxlength", "200"),
                            h.AriaLabel(copy.footer_search),
                            h.Attribute("placeholder", copy.search_placeholder),
                            h.EnterKeyHint("search"),
                          ]),
                      },
                      h,
                    ),
                    model.query.trim() === ""
                      ? h.p([...sx(h, overlay.hint)], [copy.search_hint])
                      : h.ul(
                          [...sx(h, overlay.links)],
                          model.results
                            .slice(0, 8)
                            .map((result) =>
                              h.li(
                                [],
                                [
                                  h.a(
                                    [...sx(h, overlay.result), h.Href(result.href)],
                                    [
                                      h.span(
                                        [],
                                        [
                                          result.title,
                                          ...(result.heading !== ""
                                            ? [` — ${result.heading}`]
                                            : []),
                                        ],
                                      ),
                                      h.span([...sx(h, overlay.excerpt)], [result.excerpt]),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                        ),
                  ],
                ),
              ],
            ],
          }),
        ],
      ),
    };
  };
};
export const view = createView({ paths: contentPaths, resolve: resolveContent });
