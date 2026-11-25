import { homeRoute, pageRoute } from "./routes";
import { Button, Dialog, Input, Menu, Nav, Popover, Textarea } from "@foldkit/ui";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { Command, Dom, File, Html as FoldkitHtml, Subscription, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import type { ContentNode } from "./content-parse";
import { defineMessageUnion } from "foldkit/message";
import { articleCrop, createArticleCatalog, tagSlug } from "./articles";
import { groupReleases, releaseView } from "./changelog";
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
import {
  contentPaths,
  docsNavigation,
  loadContentTargets,
  readingMinutes,
  renderContent,
  resolveContent,
  tableOfContents,
} from "./content";
import { SearchQuery, SearchResults, searchDocs, searchResultView } from "./search";
import { SubmitFeedback, SubmitTextFeedback } from "./feedback";
import {
  CopyHome,
  CopyToast,
  ExpireHomeCopy,
  HomeCopyRequest,
  autoSignSection,
  brandMark,
  copyToastView,
  githubLink,
  homeView,
  installPill,
  signFreeCta,
  signFreePath,
} from "./home";
import { FaqIndex, toolLanding, toolPageAt, toolPages } from "./tool-pages";
import { pdfCorePath, pdfCoreTitle, pdfCoreView } from "./pdf-core-page";
import { ToolsModel, Message as ToolMessage, toolView, toolsInit, toolsUpdate } from "./tool-view";
import { OverlayKind, overlayView } from "./overlay";
import { siteOrigin } from "./site-origin";
import { brand, groupIcon, icon } from "./icons";
import type { IconName } from "./icons";
import { NavMenuKind, mobileMenuView, navMenuInit, navMenuView } from "./navbar";
import { overlay } from "./styles/overlay";
import { prose } from "./styles/prose";
import { shell } from "./styles/shell";
import { className, sx } from "./styles/sx";

export const PageCopyMode = Schema.Literals(["markdown", "prompt"]);
export const PageMarkdownCopied = Schema.TaggedStruct("PageMarkdownCopied", {
  ok: Schema.Boolean,
  mode: PageCopyMode,
});
export const CopyPageMarkdown = Command.define("CopyPageMarkdown", {
  args: { path: Schema.String, mode: PageCopyMode },
  messages: [PageMarkdownCopied],
  execute: ({ path, mode }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${path}.md`);
        if (!response.ok) return PageMarkdownCopied.make({ ok: false, mode });
        const markdown = await response.text();
        await navigator.clipboard.writeText(
          mode === "markdown"
            ? markdown
            : [
                "Você vai me ajudar a usar o SignatureKit, biblioteca open source de assinatura digital com certificado A1 em TypeScript.",
                `Use a página da documentação abaixo como referência. Para outras páginas, consulte ${siteOrigin}/llms.txt.`,
                `<pagina url="${siteOrigin}${path}">`,
                markdown,
                "</pagina>",
                "Minha pergunta: ",
              ].join("\n\n"),
        );
        return PageMarkdownCopied.make({ ok: true, mode });
      },
      catch: () => PageMarkdownCopied.make({ ok: false, mode }),
    }).pipe(Effect.catch((failure) => Effect.succeed(failure))),
});

export const PageMenuItem = Schema.Literals([
  "markdown",
  "view",
  "chatgpt",
  "claude",
  "perplexity",
  "llms",
]);
export type PageMenuItem = typeof PageMenuItem.Type;
const PageMenu = Menu.create<PageMenuItem>();
export const PageTargetOpened = Schema.TaggedStruct("PageTargetOpened", {});
export const OpenPageTarget = Command.define("OpenPageTarget", {
  args: { url: Schema.String, external: Schema.Boolean },
  messages: [PageTargetOpened],
  execute: ({ url, external }) =>
    Effect.sync(() => {
      if (external) window.open(url, "_blank", "noopener,noreferrer");
      else window.location.assign(url);
      return PageTargetOpened.make({});
    }),
});

export const SearchContentLoaded = Schema.TaggedStruct("SearchContentLoaded", {});
export const LoadSearchContent = Command.define("LoadSearchContent", {
  messages: [SearchContentLoaded],
  execute: Effect.promise(() => loadContentTargets(["docs"])).pipe(
    Effect.as(SearchContentLoaded.make({})),
  ),
});

export const DroppedPdfsDelivered = Schema.TaggedStruct("DroppedPdfsDelivered", {
  ok: Schema.Boolean,
});
export const DeliverDroppedPdfs = Command.define("DeliverDroppedPdfs", {
  args: { files: Schema.Array(File.File) },
  messages: [DroppedPdfsDelivered],
  execute: ({ files }) =>
    Effect.suspend(() => {
      const input = document.querySelector<HTMLInputElement>("dialog input[name=pdf]");
      return input === null ? Effect.fail("missing") : Effect.succeed(input);
    }).pipe(
      Effect.retry({ times: 40, schedule: Schedule.spaced("50 millis") }),
      Effect.map((input) => {
        const transfer = new DataTransfer();
        for (const file of files)
          if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
            transfer.items.add(file);
        if (transfer.files.length === 0) return DroppedPdfsDelivered.make({ ok: false });
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return DroppedPdfsDelivered.make({ ok: true });
      }),
      Effect.orElseSucceed(() => DroppedPdfsDelivered.make({ ok: false })),
    ),
});

export const Flags = Schema.Struct({
  path: Schema.String,
  query: Schema.optional(SearchQuery),
});
export const Model = Schema.Struct({
  path: Schema.String,
  signingForm: SigningFormModel,
  homeDemo: HomeDemoModel,
  query: SearchQuery,
  results: SearchResults,
  feedbackStatus: Schema.Literals(["idle", "sending", "success", "error"]),
  homeCopied: Schema.Boolean,
  pageMenu: Menu.Model,
  navDocs: Popover.Model,
  navResources: Popover.Model,
  navTools: Popover.Model,
  tools: ToolsModel,
  homeCopyRequest: HomeCopyRequest,
  openFaq: Schema.Option(FaqIndex),
  copyToast: CopyToast.Model,
  overlay: Dialog.Model,
  overlayKind: OverlayKind,
  signerRequested: Schema.Boolean,
  signerMounted: Schema.Boolean,
  homeDragOver: Schema.Boolean,
  pendingPdfs: Schema.Array(File.File),
  tocActive: Schema.String,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  GotSigningFormMessage: { message: SigningFormMessage },
  GotHomeDemoMessage: { message: HomeDemoMessage },
  GotToolMessage: { message: ToolMessage },
  HomeCopyRequested: {},
  GotPageMenuMessage: { message: Menu.Message },
  GotNavMenuMessage: { menuId: NavMenuKind, message: Popover.Message },
  PageTargetOpened: {},
  PageMarkdownRequested: { mode: PageCopyMode },
  PageMarkdownCopied: { ok: Schema.Boolean, mode: PageCopyMode },
  HomeCopyFinished: { request: HomeCopyRequest, ok: Schema.Boolean },
  HomeCopyExpired: { request: HomeCopyRequest },
  QueryChanged: { value: Schema.String },
  SearchSubmitted: {},
  TextFeedbackSubmitted: {},
  FeedbackSubmitted: { opinion: Schema.Literals(["good", "bad"]) },
  FeedbackFinished: { ok: Schema.Boolean },
  FaqToggled: { index: FaqIndex, open: Schema.Boolean },
  GotCopyToastMessage: { message: CopyToast.Message },
  OverlayRequested: { kind: OverlayKind },
  OverlayCloseRequested: {},
  GotOverlayMessage: { message: Dialog.Message },
  HomeDragChanged: { over: Schema.Boolean },
  HomeFilesDropped: { files: Schema.Array(File.File) },
  DroppedPdfsDelivered: { ok: Schema.Boolean },
  TocMoved: { id: Schema.String },
  SearchContentLoaded: {},
  SignerWarmed: {},
});
export type Message = typeof Message.Type;
export const init = (flags: typeof Flags.Type): { model: Model } => ({
  model: {
    path: flags.path,
    signingForm: signingFormInit(toolPageAt(flags.path)?.preset),
    homeDemo: homeDemoInit(),
    query: flags.query ?? "",
    results: searchDocs(flags.query ?? ""),
    feedbackStatus: "idle",
    homeCopied: false,
    pageMenu: Menu.init({ id: "page-actions", isAnimated: true }),
    navDocs: navMenuInit("docs"),
    navResources: navMenuInit("resources"),
    navTools: navMenuInit("tools"),
    tools: toolsInit(),
    homeCopyRequest: 0,
    openFaq: Option.none(),
    copyToast: CopyToast.init({ id: "home-toast", defaultDuration: "1800 millis" }),
    overlay: Dialog.init({
      id: "site-overlay",
      isAnimated: true,
      focusSelector: "[data-overlay-focus]",
    }),
    overlayKind: "menu",
    signerRequested: false,
    signerMounted: false,
    homeDragOver: false,
    pendingPdfs: [],
    tocActive: "",
  },
});
const foldHomeDemo = Update.foldChild({
  update: homeDemoUpdate,
  read: (model: Model) => Option.some(model.homeDemo),
  write: (model, homeDemo) => ({ ...model, homeDemo }),
  toParentMessage: (message) => Message.GotHomeDemoMessage({ message }),
});
const foldTools = Update.foldChild({
  update: toolsUpdate,
  read: (model: Model) => Option.some(model.tools),
  write: (model, tools) => ({ ...model, tools }),
  toParentMessage: (message) => Message.GotToolMessage({ message }),
});
const pagePromptUrl = (target: string, path: string) =>
  `${target}${encodeURIComponent(
    `Leia ${siteOrigin}${path}.md e me ajude a usar o SignatureKit. Para outras páginas, use ${siteOrigin}/llms.txt.`,
  )}`;
const foldPageMenu = Update.foldChild({
  update: PageMenu.update,
  read: (model: Model) => Option.some(model.pageMenu),
  write: (model, pageMenu) => ({ ...model, pageMenu }),
  toParentMessage: (message) => Message.GotPageMenuMessage({ message }),
  foldOutMessage: Menu.OutMessage.match<Update.Step<Model, Message>>({
    Selected:
      ({ value }) =>
      (model) => {
        const item = Schema.decodeUnknownOption(PageMenuItem)(value);
        if (Option.isNone(item)) return { model };
        if (item.value === "markdown")
          return { model, commands: [CopyPageMarkdown({ path: model.path, mode: "markdown" })] };
        const targets: Record<
          Exclude<PageMenuItem, "markdown">,
          { url: string; external: boolean }
        > = {
          view: { url: `${model.path}.md`, external: false },
          llms: { url: "/llms.txt", external: false },
          chatgpt: { url: pagePromptUrl("https://chatgpt.com/?q=", model.path), external: true },
          claude: { url: pagePromptUrl("https://claude.ai/new?q=", model.path), external: true },
          perplexity: {
            url: pagePromptUrl("https://www.perplexity.ai/search?q=", model.path),
            external: true,
          },
        };
        return { model, commands: [OpenPageTarget(targets[item.value])] };
      },
  }),
});
const navField = {
  docs: "navDocs",
  resources: "navResources",
  tools: "navTools",
} satisfies Record<NavMenuKind, "navDocs" | "navResources" | "navTools">;
const foldNavMenu = (kind: NavMenuKind) =>
  Update.foldChild({
    update: Popover.update,
    read: (model: Model) => Option.some(model[navField[kind]]),
    write: (model, next) => ({ ...model, [navField[kind]]: next }),
    toParentMessage: (message) => Message.GotNavMenuMessage({ menuId: kind, message }),
    foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
      Opened: () => (model) => ({ model }),
      Closed: () => (model) => ({ model }),
    }),
  });
const navFolds = {
  docs: foldNavMenu("docs"),
  resources: foldNavMenu("resources"),
  tools: foldNavMenu("tools"),
};
const foldCopyToast = Update.foldChild({
  update: CopyToast.update,
  read: (model: Model) => Option.some(model.copyToast),
  write: (model, copyToast) => ({ ...model, copyToast }),
  toParentMessage: (message) => Message.GotCopyToastMessage({ message }),
  foldOutMessage: () => (model) => ({ model }),
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
export const signerReadyEvent = "signaturekit:signer-ready";
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
  signerWarmup: entry(
    { pending: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ pending: model.path === "" && !model.signerRequested }),
      dependenciesToStream: ({ pending }) =>
        pending
          ? Stream.fromEventListener(document, signerReadyEvent).pipe(
              Stream.take(1),
              Stream.map(() => Message.SignerWarmed()),
            )
          : Stream.empty,
    },
  ),
  tocSpy: entry(
    { docs: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        docs: model.path === "/docs" || model.path.startsWith("/docs/"),
      }),
      dependenciesToStream: ({ docs }) =>
        docs
          ? Dom.streamFromEventFilterMap({
              target: () => document,
              type: "scroll",
              filterMapEvent: () => {
                let current = "";
                for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-toc] a")) {
                  const id = decodeURIComponent(link.hash.slice(1));
                  const heading = document.getElementById(id);
                  if (heading !== null && heading.getBoundingClientRect().top <= 128) current = id;
                }
                return Option.some(current);
              },
            }).pipe(
              Stream.changes,
              Stream.map((id) => Message.TocMoved({ id })),
            )
          : Stream.empty,
    },
  ),
}));
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotSigningFormMessage: ({ message }) => {
      const next = { ...model, signingForm: signingFormUpdate(model.signingForm, message).model };
      if (message._tag !== "SigningMounted") return { model: next };
      return model.pendingPdfs.length === 0
        ? { model: { ...next, signerMounted: true } }
        : {
            model: { ...next, signerMounted: true, pendingPdfs: [] },
            commands: [DeliverDroppedPdfs({ files: model.pendingPdfs })],
          };
    },
    HomeDragChanged: ({ over }) => ({ model: { ...model, homeDragOver: over } }),
    HomeFilesDropped: ({ files }) => {
      const next: Model = {
        ...model,
        homeDragOver: false,
        overlayKind: "signer",
        signerRequested: true,
      };
      const opened: Update.Return<Model, Message> = model.overlay.isOpen
        ? { model: next }
        : openOverlay(next);
      return model.signerMounted
        ? {
            model: opened.model,
            commands: [...(opened.commands ?? []), DeliverDroppedPdfs({ files })],
          }
        : { model: { ...opened.model, pendingPdfs: files }, commands: opened.commands ?? [] };
    },
    DroppedPdfsDelivered: () => ({ model }),
    TocMoved: ({ id }) => ({ model: { ...model, tocActive: id } }),
    SignerWarmed: () => ({ model: { ...model, signerRequested: true } }),
    GotHomeDemoMessage: ({ message }) => foldHomeDemo(model, message),
    GotToolMessage: ({ message }) => foldTools(model, message),
    GotCopyToastMessage: ({ message }) => foldCopyToast(model, message),
    GotOverlayMessage: ({ message }) => foldOverlay(model, message),
    OverlayRequested: ({ kind }) => {
      const next = {
        ...model,
        overlayKind: kind,
        signerRequested: model.signerRequested || kind === "signer",
      };
      const opened: Update.Return<Model, Message> = model.overlay.isOpen
        ? { model: next }
        : openOverlay(next);
      return kind === "search"
        ? { model: opened.model, commands: [...(opened.commands ?? []), LoadSearchContent()] }
        : opened;
    },
    SearchContentLoaded: () => ({ model: { ...model, results: searchDocs(model.query) } }),
    OverlayCloseRequested: () => closeOverlay(model),
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
    GotPageMenuMessage: ({ message }) => foldPageMenu(model, message),
    GotNavMenuMessage: ({ menuId, message }) => navFolds[menuId](model, message),
    PageTargetOpened: () => ({ model }),
    PageMarkdownRequested: ({ mode }) => ({
      model,
      commands: [CopyPageMarkdown({ path: model.path, mode })],
    }),
    PageMarkdownCopied: ({ ok, mode }) => {
      const shown = CopyToast.show(model.copyToast, {
        payload: {
          text: !ok
            ? "Não foi possível copiar."
            : mode === "prompt"
              ? "Prompt copiado. Cole no seu agente."
              : "Markdown da página copiado.",
        },
        variant: "Info",
        duration: "1800 millis",
      });
      return {
        model: { ...model, copyToast: shown.model },
        commands: Command.mapMessages(shown.commands, (message) =>
          Message.GotCopyToastMessage({ message }),
        ),
      };
    },
    HomeCopyRequested: () => ({
      model: { ...model, homeCopied: false, homeCopyRequest: model.homeCopyRequest + 1 },
      commands: [CopyHome({ request: model.homeCopyRequest + 1 })],
    }),
    HomeCopyFinished: ({ ok, request }) => {
      if (request !== model.homeCopyRequest) return { model };
      const shown = CopyToast.show(model.copyToast, {
        payload: { text: ok ? "Comando copiado." : "Não foi possível copiar." },
        variant: "Info",
        duration: "1800 millis",
      });
      return {
        model: { ...model, homeCopied: ok, copyToast: shown.model },
        commands: [
          ExpireHomeCopy({ request }),
          ...Command.mapMessages(shown.commands, (message) =>
            Message.GotCopyToastMessage({ message }),
          ),
        ],
      };
    },
    HomeCopyExpired: ({ request }) => ({
      model: request === model.homeCopyRequest ? { ...model, homeCopied: false } : model,
    }),
    TextFeedbackSubmitted: () => ({
      model: { ...model, feedbackStatus: "sending" },
      commands: [
        SubmitTextFeedback({
          route: model.path === "" ? homeRoute({}) : pageRoute({ path: model.path.slice(1) }),
        }),
      ],
    }),
    FeedbackSubmitted: ({ opinion }) => ({
      model: { ...model, feedbackStatus: "sending" },
      commands: [
        SubmitFeedback({
          route: model.path === "" ? homeRoute({}) : pageRoute({ path: model.path.slice(1) }),
          opinion,
        }),
      ],
    }),
    FeedbackFinished: ({ ok }) => ({
      model: { ...model, feedbackStatus: ok ? "success" : "error" },
    }),
    QueryChanged: ({ value }) => {
      const query = value.slice(0, 200);
      return { model: { ...model, query, results: searchDocs(query) } };
    },
    SearchSubmitted: () => ({
      model: { ...model, results: searchDocs(model.query) },
    }),
  });
const signerSlot = FoldkitHtml.createLazy();
const articleSlot = FoldkitHtml.createLazy();
const navSlot = FoldkitHtml.createLazy();
const footerSlot = FoldkitHtml.createLazy();
const renderSigner = (h: HtmlBuilder<Message>, signingForm: Model["signingForm"]) =>
  h.submodel({
    slotId: "signing-form",
    model: signingForm,
    view: signingFormView,
    toParentMessage: (message) => Message.GotSigningFormMessage({ message }),
  });
const renderBody = (h: HtmlBuilder<Message>, nodes: Array<ContentNode>, post: boolean) =>
  h.div(
    post ? [...sx(h, "docs-content", prose.postBody)] : [h.Attribute("data-feedback-content", "")],
    renderContent(nodes, h),
  );
const renderDocsNav = (h: HtmlBuilder<Message>, currentRoute: string) =>
  h.div(
    [...sx(h, "docs-navigation", prose.navigation)],
    docsNavigation().map((group, index) =>
      Nav.view({
        items: group.links.map((link) => link.href),
        ariaLabel: group.title,
        toHref: (href) => href,
        isItemCurrent: (href) => href === currentRoute,
        toView: ({ nav, items }) =>
          h.nav(
            [...nav],
            [
              h.h2(
                [...sx(h, prose.navTitle, index === 0 && prose.navTitleFirst)],
                [icon(h, groupIcon(group.title)), group.title],
              ),
              h.ul(
                [...sx(h, prose.navList)],
                items.map((item) =>
                  h.li(
                    [],
                    [
                      h.a(
                        [...item.link, ...sx(h, prose.navLink, item.isCurrent && prose.navLinkOn)],
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
  );
const footerColumns = [
  {
    title: "Ferramentas",
    links: toolPages.map((page) => ({ label: page.nav.label, href: `/${page.path}` })),
  },
  {
    title: "Recursos",
    links: [
      { label: "Documentação", href: pageRoute({ path: "docs" }) },
      { label: "pdf-core", href: pdfCorePath },
      { label: "Blog", href: pageRoute({ path: "blog" }) },
      { label: "Changelog", href: pageRoute({ path: "changelog" }) },
      { label: "GitHub", href: "https://github.com/Licitei/signature-kit" },
    ],
  },
  {
    title: "Projeto",
    links: [
      { label: "Licitei", href: "https://licitei.com.br" },
      {
        label: "Licença MIT",
        href: "https://github.com/Licitei/signature-kit/blob/main/LICENSE",
      },
      { label: "Créditos das imagens", href: "/landing/CREDITS.md" },
    ],
  },
];
const renderFooter = (h: HtmlBuilder<Message>, currentRoute: string, homeCopied: boolean) =>
  h.footer(
    [...sx(h, "footer", shell.footer), h.Id("site-footer")],
    [
      h.div(
        [...sx(h, shell.footerGrid)],
        [
          h.div(
            [...sx(h, shell.footerBrand)],
            [
              h.a([...sx(h, shell.brand), h.Href(homeRoute({}))], [brandMark(h), "SignatureKit"]),
              h.p(
                [...sx(h, shell.footerTag)],
                ["Assinatura digital com certificado A1, em TypeScript."],
              ),
              installPill(h, {
                copied: homeCopied,
                onCopy: Message.HomeCopyRequested(),
              }),
              h.p(
                [...sx(h, shell.footerMeta)],
                [
                  "© 2026 · Um projeto open source da",
                  h.a(
                    [...sx(h, shell.footerLicitei), h.Href("https://licitei.com.br")],
                    [
                      h.img([
                        h.Src("/landing/licitei.webp"),
                        h.Alt("Licitei"),
                        h.Height("13"),
                        h.Width("59"),
                        ...sx(h, shell.footerLiciteiLogo),
                      ]),
                    ],
                  ),
                ],
              ),
              h.p(
                [...sx(h, shell.footerCredits)],
                [
                  "Fotos: Maria Eduarda Trajano Mangueira de Melo e Edison Aquiles, ",
                  h.a(
                    [
                      ...sx(h, shell.footerCreditsLink),
                      h.Href("https://creativecommons.org/licenses/by-sa/4.0/deed.pt-br"),
                    ],
                    ["CC BY-SA 4.0"],
                  ),
                  ", modificadas.",
                ],
              ),
            ],
          ),
          ...footerColumns.map((column) =>
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
        ],
      ),
    ],
  );
export const createView = (source: {
  paths: typeof contentPaths;
  resolve: typeof resolveContent;
}) => {
  const { articles, blogTags, resolveArticle } = createArticleCatalog(source);
  return (model: Model, h: HtmlBuilder<Message>): Document => {
    const toolPage = toolPageAt(model.path);
    const signing = toolPage !== undefined;
    const engine = model.path === pdfCorePath;
    const docs = model.path === "/docs" || model.path.startsWith("/docs/");
    const home = model.path === "";
    const content = docs ? source.resolve("docs", model.path.slice(6)) : undefined;
    const section =
      model.path === "/blog" || model.path.startsWith("/blog/")
        ? "blog"
        : model.path === "/changelog" || model.path.startsWith("/changelog/")
          ? "changelog"
          : undefined;
    const tagRoute = model.path === "/blog/tags" || model.path.startsWith("/blog/tags/");
    const tag =
      tagRoute && model.path !== "/blog/tags"
        ? blogTags().find((entry) => encodeURIComponent(entry.slug) === model.path.slice(11))
        : undefined;
    const currentRoute = home ? homeRoute({}) : pageRoute({ path: model.path.slice(1) });
    const articleSlug =
      section !== undefined
        ? articles(section).find((entry) => entry.href === currentRoute)?.slug
        : undefined;
    const article =
      section !== undefined && articleSlug !== undefined && articleSlug !== "" && !tagRoute
        ? resolveArticle(section, articleSlug)
        : undefined;
    const canonical = `${siteOrigin}${currentRoute}`;
    const heading = section === "blog" ? "Blog" : "Changelog";
    const overlayHeader =
      home ||
      (toolPage !== undefined ? toolPage.tone === "dark" : docs ? content !== undefined : true);
    const docsGroup = docs
      ? docsNavigation().find((group) => group.links.some((link) => link.href === currentRoute))
          ?.title
      : undefined;
    const toc = content !== undefined ? tableOfContents(content.nodes) : [];
    const formatDate = (value: string) =>
      new Date(value).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
    const pageMenuItems: ReadonlyArray<PageMenuItem> = [
      "markdown",
      "view",
      "chatgpt",
      "claude",
      "perplexity",
      "llms",
    ];
    const pageMenuLabel: Record<PageMenuItem, { title: string; hint: string; glyph: Html }> = {
      markdown: {
        title: "Copiar Markdown",
        hint: "A página em Markdown puro",
        glyph: icon(h, "copy"),
      },
      view: { title: "Ver como Markdown", hint: "Abre o .md desta página", glyph: icon(h, "file") },
      chatgpt: {
        title: "Abrir no ChatGPT",
        hint: "Pergunte sobre esta página",
        glyph: brand(h, "openai"),
      },
      claude: {
        title: "Abrir no Claude",
        hint: "Pergunte sobre esta página",
        glyph: brand(h, "claude"),
      },
      perplexity: {
        title: "Abrir no Perplexity",
        hint: "Pesquise com esta página",
        glyph: brand(h, "perplexity"),
      },
      llms: {
        title: "llms.txt",
        hint: "Índice da documentação para agentes",
        glyph: icon(h, "terminal"),
      },
    };
    const pageActions = h.div(
      [...sx(h, prose.pageActions)],
      [
        Button.view(
          {
            onClick: Message.PageMarkdownRequested({ mode: "prompt" }),
            toView: (attributes) =>
              h.button(
                [...attributes.button, ...sx(h, prose.pageAction, prose.pageActionMain)],
                [icon(h, "sparkles"), "Copiar como prompt"],
              ),
          },
          h,
        ),
        h.submodel({
          slotId: "page-actions",
          model: model.pageMenu,
          view: PageMenu.view,
          viewInputs: {
            items: pageMenuItems,
            ariaLabel: "Mais formas de usar esta página com IA",
            anchor: { placement: "bottom-end", gap: 6, padding: 8 },
            buttonContent: icon(h, "chevron"),
            buttonClassName: className(prose.pageAction, prose.pageActionToggle),
            itemsClassName: className(
              prose.menu,
              (model.pageMenu.animation.transitionState === "EnterStart" ||
                model.pageMenu.animation.transitionState === "LeaveAnimating") &&
                prose.menuClosed,
            ),
            itemGroupKey: (item) =>
              item === "markdown" || item === "view" ? "copy" : item === "llms" ? "agents" : "open",
            groupToHeading: (key) =>
              key === "open"
                ? { content: h.span([], ["Abrir com IA"]), className: className(prose.menuHeading) }
                : undefined,
            separatorClassName: className(prose.menuSeparator),
            itemToConfig: (item, { isActive }) => ({
              className: className(prose.menuItem, isActive && prose.menuItemOn),
              content: h.span(
                [...sx(h, prose.menuRow)],
                [
                  h.span([...sx(h, prose.menuGlyph)], [pageMenuLabel[item].glyph]),
                  h.span(
                    [...sx(h, prose.menuText)],
                    [
                      h.span([...sx(h, prose.menuTitle)], [pageMenuLabel[item].title]),
                      h.span([...sx(h, prose.menuHint)], [pageMenuLabel[item].hint]),
                    ],
                  ),
                ],
              ),
            }),
          },
          toParentMessage: (message) => Message.GotPageMenuMessage({ message }),
        }),
      ],
    );
    const banner = (input: {
      title: string;
      lead: string;
      crumbs: ReadonlyArray<{ label: string; href: string | undefined }>;
      meta?: string | undefined;
      narrow?: boolean;
      releases?: boolean;
      actions?: boolean;
      crop?: number;
      tags?: ReadonlyArray<string>;
    }) =>
      h.section(
        [
          ...sx(
            h,
            prose.banner,
            input.crop === 1 && prose.bannerCrop1,
            input.crop === 2 && prose.bannerCrop2,
            input.crop === 3 && prose.bannerCrop3,
            input.crop === 4 && prose.bannerCrop4,
          ),
        ],
        [
          h.div(
            [
              ...sx(
                h,
                prose.bannerInner,
                input.narrow === true && prose.bannerNarrow,
                input.releases === true && prose.bannerReleases,
              ),
            ],
            [
              ...(input.crumbs.length > 0 || input.meta !== undefined
                ? [
                    h.p(
                      [...sx(h, prose.crumbs)],
                      [
                        ...input.crumbs.flatMap((crumb, index) => [
                          ...(index > 0 ? [h.span([...sx(h, prose.crumbSep)], ["/"])] : []),
                          crumb.href !== undefined
                            ? h.a([...sx(h, prose.crumbLink), h.Href(crumb.href)], [crumb.label])
                            : h.span([], [crumb.label]),
                        ]),
                        ...(input.meta !== undefined
                          ? [
                              ...(input.crumbs.length > 0
                                ? [h.span([...sx(h, prose.crumbSep)], ["·"])]
                                : []),
                              h.span([], [input.meta]),
                            ]
                          : []),
                      ],
                    ),
                  ]
                : []),
              h.h1([...sx(h, prose.bannerTitle)], [input.title]),
              ...(input.lead !== "" ? [h.p([...sx(h, prose.bannerLead)], [input.lead])] : []),
              ...(input.actions === true ? [pageActions] : []),
              ...(input.tags !== undefined && input.tags.length > 0
                ? [
                    h.ul(
                      [...sx(h, prose.bannerTags), h.AriaLabel("Assuntos")],
                      input.tags.map((name) =>
                        h.keyed("li")(
                          name,
                          [],
                          [
                            h.a(
                              [
                                ...sx(h, prose.bannerTag),
                                h.Href(
                                  pageRoute({
                                    path: `blog/tags/${encodeURIComponent(tagSlug(name))}`,
                                  }),
                                ),
                              ],
                              [`#${name}`],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ]
                : []),
            ],
          ),
        ],
      );
    const signer = () => signerSlot(renderSigner, [h, model.signingForm]);
    const signerPanel = (): readonly [OverlayKind, Html] => ["signer", signer()];
    const toast = copyToastView(h, {
      model: model.copyToast,
      toParentMessage: (message) => Message.GotCopyToastMessage({ message }),
    });
    return {
      title: tagRoute
        ? `${tag?.tag ?? "Tags do blog"} | SignatureKit`
        : toolPage !== undefined
          ? `${toolPage.title} | SignatureKit`
          : engine
            ? `${pdfCoreTitle} | SignatureKit`
            : model.path === "/search"
              ? "Buscar na documentação | SignatureKit"
              : article !== undefined
                ? `${article.title} | SignatureKit`
                : section !== undefined
                  ? `${heading} | SignatureKit`
                  : content !== undefined
                    ? `${content.title} | SignatureKit`
                    : "Assinatura digital com certificado A1 em TypeScript | SignatureKit",
      lang: "pt-BR",
      canonical,
      ogUrl: canonical,
      body: h.div(
        [...sx(h, "site", shell.site)],
        [
          h.a([...sx(h, shell.skipLink), h.Href("#conteudo")], ["Pular para o conteúdo"]),
          h.header(
            [
              ...sx(
                h,
                "header",
                shell.header,
                shell.headerWide,
                overlayHeader && shell.headerOverlay,
              ),
            ],
            [
              h.a(
                [...sx(h, "brand", shell.brand), h.Href(homeRoute({}))],
                [brandMark(h), "SignatureKit"],
              ),
              h.nav(
                [
                  ...sx(h, "navigation", shell.navigation, overlayHeader && shell.navigationLight),
                  h.AriaLabel("Navegação principal"),
                ],
                [
                  navMenuView(h, {
                    kind: "docs",
                    model: model.navDocs,
                    current: docs,
                    toParentMessage: (message) =>
                      Message.GotNavMenuMessage({ menuId: "docs", message }),
                  }),
                  navMenuView(h, {
                    kind: "tools",
                    model: model.navTools,
                    current: signing,
                    toParentMessage: (message) =>
                      Message.GotNavMenuMessage({ menuId: "tools", message }),
                  }),
                  navMenuView(h, {
                    kind: "resources",
                    model: model.navResources,
                    current: section !== undefined,
                    toParentMessage: (message) =>
                      Message.GotNavMenuMessage({ menuId: "resources", message }),
                  }),
                ],
              ),
              h.div(
                [...sx(h, shell.headerEnd)],
                [
                  h.a(
                    [
                      ...sx(
                        h,
                        shell.searchButton,
                        shell.wideOnly,
                        overlayHeader && shell.searchButtonLight,
                      ),
                      h.Href(pageRoute({ path: "search" })),
                      h.Attribute("data-overlay", "search"),
                      h.AriaKeyshortcuts("Meta+K Control+K"),
                      h.OnClick(Message.OverlayRequested({ kind: "search" }), {
                        defaultAction: "Prevent",
                      }),
                    ],
                    ["Buscar", h.kbd([...sx(h, shell.kbd)], ["⌘K"])],
                  ),
                  githubLink(h, overlayHeader ? "light" : "dark"),
                  h.a(
                    [
                      ...sx(h, shell.primary, shell.primarySmall, shell.wideOnly),
                      h.Href(pageRoute({ path: "docs/get-started/quickstart" })),
                    ],
                    ["Começar"],
                  ),
                  h.a(
                    [
                      ...sx(
                        h,
                        shell.iconButton,
                        shell.compactOnly,
                        overlayHeader && shell.iconLinkLight,
                      ),
                      h.Href(pageRoute({ path: "search" })),
                      h.Attribute("data-overlay", "search"),
                      h.AriaLabel("Buscar"),
                      h.OnClick(Message.OverlayRequested({ kind: "search" }), {
                        defaultAction: "Prevent",
                      }),
                    ],
                    [icon(h, "search")],
                  ),
                  h.a(
                    [
                      ...sx(
                        h,
                        shell.iconButton,
                        shell.compactOnly,
                        overlayHeader && shell.iconLinkLight,
                      ),
                      h.Href("#site-footer"),
                      h.Attribute("data-overlay", "menu"),
                      h.AriaLabel("Menu"),
                      h.OnClick(Message.OverlayRequested({ kind: "menu" }), {
                        defaultAction: "Prevent",
                      }),
                    ],
                    [icon(h, "menu")],
                  ),
                ],
              ),
            ],
          ),
          h.main(
            [h.Id("conteudo"), h.Attribute("tabindex", "-1")],
            model.path === "/search"
              ? [
                  banner({
                    title: "Buscar na documentação",
                    narrow: true,
                    lead: "Encontre guias, conceitos e referências da API.",
                    crumbs: [{ label: "Docs", href: pageRoute({ path: "docs" }) }],
                  }),
                  h.section(
                    [...sx(h, "docs-content", prose.plain)],
                    [
                      h.form(
                        [
                          h.Attribute("method", "get"),
                          h.Attribute("action", pageRoute({ path: "search" })),
                          h.Attribute("role", "search"),
                          h.OnSubmit(Message.SearchSubmitted()),
                          ...sx(h, prose.searchForm),
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
                                h.label(
                                  [...attributes.label, h.Class(className(prose.searchField))],
                                  [
                                    h.span([...sx(h, prose.srOnly)], ["Termos de busca"]),
                                    h.span([...sx(h, prose.searchIcon)], [icon(h, "search")]),
                                    h.input([
                                      ...attributes.input,
                                      h.Class(`ph-no-capture ${className(prose.searchInput)}`),
                                      h.Attribute("placeholder", "Ex.: PAdES, certificado, XML"),
                                      h.Attribute("maxlength", "200"),
                                    ]),
                                  ],
                                ),
                            },
                            h,
                          ),
                          Button.view(
                            {
                              type: "submit",
                              toView: (attributes) =>
                                h.button(
                                  [...attributes.button, ...sx(h, shell.primary)],
                                  ["Buscar"],
                                ),
                            },
                            h,
                          ),
                        ],
                      ),
                      model.query.trim() === ""
                        ? h.p([...sx(h, prose.searchEmpty)], ["Digite um termo para buscar."])
                        : model.results.length === 0
                          ? h.p(
                              [...sx(h, prose.searchEmpty)],
                              [`Nenhum resultado para “${model.query.trim()}”. Tente outro termo.`],
                            )
                          : h.ul(
                              [...sx(h, overlay.links)],
                              model.results.map((result) =>
                                h.keyed("li")(
                                  `${result.href} ${result.heading}`,
                                  [],
                                  [searchResultView(h, result, model.query)],
                                ),
                              ),
                            ),
                    ],
                  ),
                ]
              : tagRoute
                ? [
                    banner({
                      title: tag !== undefined ? tag.tag : "Tags do blog",
                      narrow: true,
                      lead: "Explore os artigos por assunto.",
                      crumbs: [
                        { label: "Blog", href: pageRoute({ path: "blog" }) },
                        ...(tag !== undefined
                          ? [{ label: "Tags", href: pageRoute({ path: "blog/tags" }) }]
                          : []),
                      ],
                    }),
                    h.section(
                      [...sx(h, "docs-content", prose.plain)],
                      [
                        h.ul(
                          [...sx(h, prose.articleList)],
                          tag !== undefined
                            ? tag.entries.map((entry) =>
                                h.li(
                                  [...sx(h, prose.articleItem)],
                                  [
                                    h.a(
                                      [...sx(h, prose.articleLink), h.Href(entry.href)],
                                      [entry.title],
                                    ),
                                  ],
                                ),
                              )
                            : blogTags().map((entry) =>
                                h.li(
                                  [...sx(h, prose.articleItem)],
                                  [
                                    h.a(
                                      [
                                        ...sx(h, prose.articleLink),
                                        h.Href(
                                          pageRoute({
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
                : engine
                  ? [
                      h.div(
                        [h.Class("ph-no-capture"), h.Attribute("data-analytics-sensitive", "true")],
                        pdfCoreView(
                          h,
                          h.submodel({
                            slotId: "tool",
                            model: model.tools,
                            view: toolView,
                            viewInputs: { tool: "pdfcore" },
                            toParentMessage: (message) => Message.GotToolMessage({ message }),
                          }),
                        ),
                      ),
                    ]
                  : toolPage !== undefined
                    ? [
                        h.div(
                          [
                            h.Class("ph-no-capture"),
                            h.Attribute("data-analytics-sensitive", "true"),
                          ],
                          [
                            ...toolLanding(
                              h,
                              toolPage,
                              toolPage.kind === "signer"
                                ? signer()
                                : h.submodel({
                                    slotId: "tool",
                                    model: model.tools,
                                    view: toolView,
                                    viewInputs: { tool: toolPage.kind },
                                    toParentMessage: (message) =>
                                      Message.GotToolMessage({ message }),
                                  }),
                              {
                                open: model.openFaq,
                                toggle: (index, open) => Message.FaqToggled({ index, open }),
                              },
                            ),
                            ...(`/${toolPage.path}` === signFreePath
                              ? [
                                  autoSignSection(
                                    h,
                                    h.submodel({
                                      slotId: "home-demo",
                                      model: model.homeDemo,
                                      view: homeDemoView,
                                      toParentMessage: (message) =>
                                        Message.GotHomeDemoMessage({ message }),
                                    }),
                                  ),
                                ]
                              : []),
                            signFreeCta(h),
                          ],
                        ),
                      ]
                    : section === "changelog"
                      ? [
                          banner({
                            title: article !== undefined ? article.title : "Changelog",
                            lead:
                              article !== undefined
                                ? ""
                                : "O que mudou em cada versão dos pacotes do SignatureKit.",
                            crumbs:
                              article !== undefined
                                ? [{ label: "Changelog", href: pageRoute({ path: "changelog" }) }]
                                : [],
                            releases: true,
                          }),
                          h.div(
                            [...sx(h, "docs-content", prose.releases)],
                            [h.span([...sx(h, prose.releaseRail), h.AriaHidden(true)])].concat(
                              groupReleases(
                                article !== undefined
                                  ? [{ ...article, slug: articleSlug ?? "", href: currentRoute }]
                                  : articles("changelog"),
                              ).map((release) =>
                                releaseView(h, {
                                  release,
                                  formatDate,
                                  linkTitles: article === undefined,
                                }),
                              ),
                            ),
                          ),
                        ]
                      : section === "blog"
                        ? article !== undefined
                          ? [
                              banner({
                                title: article.title,
                                lead: article.description ?? "",
                                crumbs: [{ label: "Blog", href: pageRoute({ path: "blog" }) }],
                                meta: [
                                  article.author ?? "",
                                  article.date !== "" ? formatDate(article.date) : "",
                                  `${readingMinutes(article.nodes)} min de leitura`,
                                ]
                                  .filter((part) => part !== "")
                                  .join(" · "),
                                narrow: true,
                                crop: articleCrop(articleSlug ?? ""),
                                tags: article.tags ?? [],
                              }),
                              h.article(
                                [...sx(h, prose.post)],
                                [articleSlot(renderBody, [h, article.nodes, true])],
                              ),
                            ]
                          : [
                              banner({
                                title: "Blog",
                                lead: "Artigos e decisões de engenharia sobre assinatura digital no Brasil.",
                                crumbs: [],
                                narrow: true,
                              }),
                              h.section(
                                [...sx(h, prose.post)],
                                [
                                  h.ul(
                                    [
                                      ...sx(h, prose.postList),
                                      h.Attribute("data-reveal", ""),
                                      h.Attribute("data-reveal-stagger", ""),
                                    ],
                                    articles("blog").map((entry, index) =>
                                      h.keyed("li")(
                                        entry.href,
                                        [],
                                        [
                                          h.a(
                                            [
                                              ...sx(
                                                h,
                                                prose.postRow,
                                                index === 0 && prose.postRowFeatured,
                                              ),
                                              h.Href(entry.href),
                                            ],
                                            [
                                              h.img([
                                                h.Src(`${entry.href}.webp`),
                                                h.Alt(""),
                                                h.Width("1200"),
                                                h.Height("630"),
                                                h.Loading(index === 0 ? "eager" : "lazy"),
                                                h.Decoding("async"),
                                                ...sx(h, prose.postThumb),
                                              ]),
                                              h.div(
                                                [...sx(h, prose.postRowText)],
                                                [
                                                  h.p(
                                                    [...sx(h, prose.postMeta)],
                                                    [
                                                      [
                                                        entry.date !== ""
                                                          ? formatDate(entry.date)
                                                          : "",
                                                        `${readingMinutes(entry.nodes)} min de leitura`,
                                                      ]
                                                        .filter((part) => part !== "")
                                                        .join(" · "),
                                                    ],
                                                  ),
                                                  h.h2(
                                                    [
                                                      ...sx(
                                                        h,
                                                        prose.postRowTitle,
                                                        index === 0 && prose.postRowTitleFeatured,
                                                      ),
                                                    ],
                                                    [entry.title],
                                                  ),
                                                  ...(entry.description !== undefined &&
                                                  entry.description !== ""
                                                    ? [
                                                        h.p(
                                                          [...sx(h, prose.postRowDescription)],
                                                          [entry.description],
                                                        ),
                                                      ]
                                                    : []),
                                                ],
                                              ),
                                            ],
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ]
                        : docs && content !== undefined
                          ? [
                              banner({
                                title: content.title,
                                lead: content.description ?? "",
                                actions: true,
                                crumbs: [
                                  { label: "Docs", href: pageRoute({ path: "docs" }) },
                                  ...(docsGroup !== undefined && docsGroup !== "Docs"
                                    ? [{ label: docsGroup, href: undefined }]
                                    : []),
                                ],
                              }),
                              h.div(
                                [...sx(h, "docs-layout", prose.layout)],
                                [
                                  navSlot(renderDocsNav, [h, currentRoute]),
                                  h.article(
                                    [...sx(h, "docs-content", prose.content)],
                                    [
                                      articleSlot(renderBody, [h, content.nodes, false]),
                                      h.section(
                                        [
                                          ...sx(h, "ph-no-capture", prose.feedback),
                                          h.Attribute("data-analytics-sensitive", "true"),
                                        ],
                                        [
                                          h.div(
                                            [...sx(h, prose.feedbackHead)],
                                            [
                                              h.h2(
                                                [...sx(h, prose.feedbackTitle)],
                                                ["Esta página ajudou?"],
                                              ),
                                              h.div(
                                                [...sx(h, prose.feedbackActions)],
                                                (
                                                  [
                                                    ["good", "Sim", "thumbsUp"],
                                                    ["bad", "Não", "thumbsDown"],
                                                  ] satisfies ReadonlyArray<
                                                    readonly ["good" | "bad", string, IconName]
                                                  >
                                                ).map(([opinion, label, glyph]) =>
                                                  h.keyed("span")(
                                                    opinion,
                                                    [],
                                                    [
                                                      Button.view(
                                                        {
                                                          onClick: Message.FeedbackSubmitted({
                                                            opinion,
                                                          }),
                                                          toView: (attributes) =>
                                                            h.button(
                                                              [
                                                                ...attributes.button,
                                                                ...sx(h, prose.feedbackButton),
                                                              ],
                                                              [icon(h, glyph), label],
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
                                          Textarea.view(
                                            {
                                              id: "feedback-message",
                                              toView: (attributes) =>
                                                h.textarea([
                                                  ...attributes.textarea,
                                                  h.Class(className(prose.feedbackInput)),
                                                  h.Attribute("data-feedback-message", ""),
                                                  h.Attribute("maxlength", "2000"),
                                                  h.Attribute("rows", "3"),
                                                  h.Attribute(
                                                    "placeholder",
                                                    "Faltou algo ou encontrou um erro? Conte para nós.",
                                                  ),
                                                  h.Attribute("aria-label", "Comentário"),
                                                ]),
                                            },
                                            h,
                                          ),
                                          h.div(
                                            [...sx(h, prose.feedbackFoot)],
                                            [
                                              h.p(
                                                [
                                                  ...sx(h, prose.feedbackStatus),
                                                  h.Attribute("role", "status"),
                                                ],
                                                [
                                                  model.feedbackStatus === "success"
                                                    ? "Obrigado pelo feedback!"
                                                    : model.feedbackStatus === "error"
                                                      ? "Não foi possível enviar. Tente novamente."
                                                      : model.feedbackStatus === "sending"
                                                        ? "Enviando…"
                                                        : "",
                                                ],
                                              ),
                                              Button.view(
                                                {
                                                  onClick: Message.TextFeedbackSubmitted(),
                                                  toView: (attributes) =>
                                                    h.button(
                                                      [
                                                        ...attributes.button,
                                                        ...sx(h, prose.feedbackSend),
                                                      ],
                                                      ["Enviar comentário"],
                                                    ),
                                                },
                                                h,
                                              ),
                                            ],
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                  ...(toc.length > 1
                                    ? [
                                        h.nav(
                                          [
                                            ...sx(h, prose.toc),
                                            h.AriaLabel("Nesta página"),
                                            h.Attribute("data-toc", ""),
                                          ],
                                          [
                                            h.p(
                                              [...sx(h, prose.tocTitle)],
                                              [icon(h, "list"), "Nesta página"],
                                            ),
                                            h.ul(
                                              [...sx(h, prose.tocList)],
                                              toc.map((entry) =>
                                                h.keyed("li")(
                                                  entry.id,
                                                  [],
                                                  [
                                                    h.a(
                                                      [
                                                        ...sx(
                                                          h,
                                                          prose.tocLink,
                                                          model.tocActive === entry.id &&
                                                            prose.tocLinkOn,
                                                        ),
                                                        h.Href(`#${entry.id}`),
                                                      ],
                                                      [entry.title],
                                                    ),
                                                  ],
                                                ),
                                              ),
                                            ),
                                          ],
                                        ),
                                      ]
                                    : []),
                                ],
                              ),
                            ]
                          : homeView(h, {
                              open: (kind) => Message.OverlayRequested({ kind }),
                              dragOver: model.homeDragOver,
                              drag: (over) => Message.HomeDragChanged({ over }),
                              drop: (files) => Message.HomeFilesDropped({ files }),
                            }),
          ),
          footerSlot(renderFooter, [h, currentRoute, model.homeCopied]),
          ...(model.overlay.isOpen ? [] : [toast]),
          overlayView(h, {
            model: model.overlay,
            kind: model.overlayKind,
            wide: model.signingForm.mode === "completa",
            title: {
              signer: "Assinar PDF",
              menu: "Menu",
              search: "Buscar",
            }[model.overlayKind],
            closeLabel: "Fechar",
            layer: model.overlay.isOpen ? [toast] : [],
            toParentMessage: (message) => Message.GotOverlayMessage({ message }),
            panels: [
              ...(home && model.signerRequested ? [signerPanel()] : []),
              [
                "menu",
                mobileMenuView(h, {
                  docs,
                  currentRoute,
                  search: Message.OverlayRequested({ kind: "search" }),
                  close: Message.OverlayCloseRequested(),
                }),
              ],
              [
                "search",
                h.form(
                  [
                    ...sx(h, overlay.stack),
                    h.Attribute("method", "get"),
                    h.Attribute("action", pageRoute({ path: "search" })),
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
                            h.Class(`ph-no-capture ${className(overlay.search)}`),
                            h.DataAttribute("overlay-focus", ""),
                            h.Attribute("maxlength", "200"),
                            h.AriaLabel("Buscar"),
                            h.Attribute("placeholder", "Buscar na documentação"),
                            h.EnterKeyHint("search"),
                          ]),
                      },
                      h,
                    ),
                    model.query.trim() === ""
                      ? h.p(
                          [...sx(h, overlay.hint)],
                          ["Digite para buscar guias e páginas de API."],
                        )
                      : model.results.length === 0
                        ? h.p(
                            [...sx(h, overlay.hint)],
                            [`Nenhum resultado para “${model.query.trim()}”.`],
                          )
                        : h.ul(
                            [...sx(h, overlay.links)],
                            model.results
                              .slice(0, 8)
                              .map((result) =>
                                h.keyed("li")(
                                  `${result.href} ${result.heading}`,
                                  [],
                                  [searchResultView(h, result, model.query)],
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
