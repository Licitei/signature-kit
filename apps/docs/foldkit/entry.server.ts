import { homeRoute, pageRoute, parsePublicUrl } from "./routes";
export { parsePublicUrl } from "./routes";
import { Effect, Schema } from "effect";
import en from "../messages/en-US.json";
import pt from "../messages/pt-BR.json";
import * as Server from "foldkit/experimental/server";
import { Flags, init, createView } from "./main";
import { createArticleCatalog } from "./articles";
import { contentPaths, resolveContent } from "./content";
import { createFeeds, escapeXml } from "./feeds";
import { SearchQuery } from "./search";
import {
  captureServerEvent,
  captureServerEventWithoutRequestEffect,
  defaultServerAnalyticsLayer,
} from "../lib/posthog/server";
import { feedbackResponse } from "./feedback-server";
import { siteOrigin } from "./site-origin";

export const createServerComposition = (
  source: {
    paths: typeof contentPaths;
    resolve: typeof resolveContent;
  },
  analytics = defaultServerAnalyticsLayer,
) => {
  const { articlePaths, articles, blogTags, tagPaths } = createArticleCatalog(source);
  const { feedResponse } = createFeeds(source);
  const view = createView(source);
  const prerenderPaths = [
    homeRoute({ locale: "en-US" }),
    homeRoute({ locale: "pt-BR" }),
    ...articlePaths(),
    ...tagPaths(),
    ...source
      .paths()
      .filter((path) => path.startsWith("docs/"))
      .map((path) => {
        const locale = path.endsWith(".pt-BR") ? "pt-BR" : "en-US";
        const slug = path.slice(5).replace(/\.pt-BR$/, "");
        return pageRoute({ locale, path: slug === "index" ? "docs" : `docs/${slug}` });
      }),
  ];
  const MetadataSchema = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("meta"),
      key: Schema.String,
      value: Schema.String,
      property: Schema.Boolean,
    }),
    Schema.Struct({ kind: Schema.Literal("link"), language: Schema.String, href: Schema.String }),
  ]);
  type Metadata = typeof MetadataSchema.Type;

  const metadata = (application: Parameters<Server.DocumentRenderer>[0]) => {
    const url =
      application.canonical !== undefined && application.canonical !== ""
        ? new URL(application.canonical)
        : undefined;
    if (url === undefined) return undefined;
    const locale = application.lang === "pt-BR" ? "pt-BR" : "en-US";
    const route = parsePublicUrl(url.href);
    const path = route?._tag === "Page" ? `/${route.path}` : "";
    const articleMatch = /^\/(blog|changelog)\/([^/]+)$/.exec(path);
    const section = articleMatch?.[1] === "blog" ? "blog" : "changelog";
    const slug =
      articleMatch !== null
        ? (articles(route?.locale === "pt-BR" ? "pt-BR" : "en-US", section).find(
            (entry) => encodeURIComponent(entry.slug) === articleMatch[2],
          )?.slug ?? "")
        : "";
    const article =
      articleMatch !== null && slug !== "tags"
        ? source.resolve(route?.locale === "pt-BR" ? "pt-BR" : "en-US", section, slug)
        : undefined;
    const docs =
      path === "/docs" || path.startsWith("/docs/")
        ? source.resolve(locale, "docs", path.slice(6))
        : undefined;
    const tagPath = path === "/blog/tags" || path.startsWith("/blog/tags/");
    const descriptions =
      locale === "pt-BR"
        ? {
            blog: "Artigos sobre assinaturas digitais, TypeScript e infraestrutura Effect-native.",
            tags: "Explore os artigos por assunto.",
            changelog: "Notas de versão dos pacotes SignatureKit.",
          }
        : {
            blog: "Articles about digital signatures, TypeScript, and Effect-native infrastructure.",
            tags: "Explore articles by topic.",
            changelog: "Release notes for SignatureKit packages.",
          };
    const description =
      article?.description ??
      docs?.description ??
      (tagPath
        ? descriptions.tags
        : path === "/blog"
          ? descriptions.blog
          : path === "/changelog"
            ? descriptions.changelog
            : path === "/search"
              ? locale === "pt-BR"
                ? "Busque na documentação do SignatureKit."
                : "Search the SignatureKit documentation."
              : locale === "pt-BR"
                ? pt.hero_subhead
                : en.hero_subhead);
    const meta = (key: string, value: string, property = false): Metadata => ({
      kind: "meta",
      key,
      value,
      property,
    });
    const link = (language: string, href: string): Metadata => ({ kind: "link", language, href });
    const candidates = (["en-US", "pt-BR"] satisfies ("en-US" | "pt-BR")[]).filter((candidate) => {
      if (article !== undefined) return Boolean(source.resolve(candidate, section, slug));
      if (tagPath && path !== "/blog/tags")
        return blogTags(candidate).some((tag) => encodeURIComponent(tag.slug) === path.slice(11));
      if (docs !== undefined) return Boolean(source.resolve(candidate, "docs", path.slice(6)));
      return true;
    });
    const alternate = (candidate: "en-US" | "pt-BR") =>
      `${siteOrigin}${path === "" ? homeRoute({ locale: candidate }) : pageRoute({ locale: candidate, path: path.slice(1) })}`;
    const elements = [
      meta("og:site_name", "SignatureKit", true),
      meta("og:type", article !== undefined ? "article" : "website", true),
      meta("og:locale", locale === "pt-BR" ? "pt_BR" : "en_US", true),
      meta("og:title", application.title, true),
      meta("twitter:card", "summary"),
      meta("twitter:title", application.title),
      ...(description !== ""
        ? [
            meta("description", description),
            meta("og:description", description, true),
            meta("twitter:description", description),
          ]
        : []),
      ...candidates.map((candidate) => link(candidate, alternate(candidate))),
      ...(candidates.length > 0
        ? [
            link(
              "x-default",
              alternate(candidates.includes("en-US") ? "en-US" : (candidates[0] ?? "en-US")),
            ),
          ]
        : []),
      ...(path === "/search" || route?.locale !== locale ? [meta("robots", "noindex")] : []),
    ];
    return elements;
  };
  const renderDocument: Server.DocumentRenderer = (application, assets) => {
    const elements = metadata(application);
    if (elements === undefined) return Server.renderDocument(application, assets);
    const head = elements
      .map((item) =>
        item.kind === "meta"
          ? `<meta ${item.property ? "property" : "name"}="${escapeXml(item.key)}" content="${escapeXml(item.value)}" />`
          : `<link rel="alternate" hreflang="${escapeXml(item.language)}" href="${escapeXml(item.href)}" />`,
      )
      .join("");
    return Server.renderDocument(application, assets, { head });
  };
  const renderPage = async (request: Request, buildId?: string): Promise<Server.EntryResult> => {
    const feedback = await Effect.runPromise(feedbackResponse(request));
    if (feedback !== undefined) return Server.Responded(feedback);
    const feed = await Effect.runPromise(feedResponse(request));
    if (feed !== undefined) {
      const parsed = parsePublicUrl(request.url);
      if (parsed?._tag === "Page" && parsed.path === "blog/rss.xml" && feed.status === 200)
        await captureServerEvent("blog_rss_requested", request, { locale: parsed.locale });
      return Server.Responded(feed);
    }
    const path = new URL(request.url).pathname;
    if (path === "/")
      return Server.Responded(
        Response.redirect(new URL(homeRoute({ locale: "en-US" }), request.url), 302),
      );
    const parsedRoute = parsePublicUrl(request.url);
    if (parsedRoute === undefined)
      return Server.Responded(new Response("Not found", { status: 404 }));
    const locale = parsedRoute.locale;
    const route = parsedRoute._tag === "Page" ? `/${parsedRoute.path}` : "";
    const docs = route === "/docs" || route.startsWith("/docs/");
    const section =
      route === "/blog" || route.startsWith("/blog/")
        ? "blog"
        : route === "/changelog" || route.startsWith("/changelog/")
          ? "changelog"
          : undefined;
    if (route !== "" && route !== "/search" && !docs && section === undefined)
      return Server.Responded(new Response("Not found", { status: 404 }));
    if (docs && source.resolve(locale, "docs", route.slice(6)) === undefined)
      return Server.Responded(new Response("Not found", { status: 404 }));
    const tagRoute = route === "/blog/tags" || route.startsWith("/blog/tags/");
    if (
      tagRoute &&
      route !== "/blog/tags" &&
      !blogTags(locale).some((tag) => encodeURIComponent(tag.slug) === route.slice(11))
    )
      return Server.Responded(new Response("Not found", { status: 404 }));
    if (
      section !== undefined &&
      !tagRoute &&
      route !== `/${section}` &&
      !articles(locale, section).some(
        (entry) => entry.href === pageRoute({ locale, path: route.slice(1) }),
      )
    )
      return Server.Responded(new Response("Not found", { status: 404 }));
    const rawQuery = route === "/search" ? (new URL(request.url).searchParams.get("q") ?? "") : "";
    if (route === "/search" && request.method === "GET" && analytics !== undefined)
      await Effect.runPromise(
        captureServerEventWithoutRequestEffect("search_requested", {
          query_present: rawQuery.length > 0,
          query_length: Math.min(rawQuery.length, 200),
        }).pipe(Effect.ignore, Effect.provide(analytics), Effect.orDie),
      );
    const decodedQuery = Schema.decodeUnknownOption(SearchQuery)(rawQuery);
    const query = decodedQuery._tag === "Some" ? decodedQuery.value : "";
    const application = await Effect.runPromise(
      Server.renderToString(
        { Flags, init, view },
        { flags: { locale, path: route, query }, buildId },
      ),
    );
    return Server.Rendered(application);
  };

  return { prerenderPaths, renderDocument, renderPage };
};
export const { prerenderPaths, renderDocument, renderPage } = createServerComposition({
  paths: contentPaths,
  resolve: resolveContent,
});
