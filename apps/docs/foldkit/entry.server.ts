import { homeRoute, legacyLocaleRedirect, pageRoute, parsePublicUrl } from "./routes";
export { parsePublicUrl } from "./routes";
import { Effect, Schema } from "effect";
import { DOMImplementation, XMLSerializer } from "@xmldom/xmldom";
import * as Server from "foldkit/experimental/server";
import { Flags, init, createView } from "./main";
import { createArticleCatalog } from "./articles";
import { contentPaths, resolveContent } from "./content";
import { createFeeds } from "./feeds";
import { SearchQuery } from "./search";
import {
  captureServerEvent,
  captureServerEventWithoutRequestEffect,
  defaultServerAnalyticsLayer,
} from "../lib/posthog/server";
import { feedbackResponse } from "./feedback-server";
import { agentMeta, agentResponse } from "./agents";
import { signFreeDescription, signFreeFaqs, signFreeSteps } from "./home";
import { siteOrigin } from "./site-origin";
import geistFont from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import geistMonoFont from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url";

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
    homeRoute({}),
    pageRoute({ path: "assine-documentos-gratis" }),
    ...articlePaths(),
    ...tagPaths(),
    ...source
      .paths()
      .filter((path) => path.startsWith("docs/"))
      .map((path) => {
        const slug = path.slice(5);
        return pageRoute({ path: slug === "index" ? "docs" : `docs/${slug}` });
      }),
  ];
  const MetadataSchema = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("meta"),
      key: Schema.String,
      value: Schema.String,
      property: Schema.Boolean,
    }),
  ]);
  type Metadata = typeof MetadataSchema.Type;

  const metadata = (application: Parameters<Server.DocumentRenderer>[0]) => {
    const url =
      application.canonical !== undefined && application.canonical !== ""
        ? new URL(application.canonical)
        : undefined;
    if (url === undefined) return undefined;
    const route = parsePublicUrl(url.href);
    const path = route?._tag === "Page" ? `/${route.path}` : "";
    const articleMatch = /^\/(blog|changelog)\/([^/]+)$/.exec(path);
    const section = articleMatch?.[1] === "blog" ? "blog" : "changelog";
    const slug =
      articleMatch !== null
        ? (articles(section).find((entry) => encodeURIComponent(entry.slug) === articleMatch[2])
            ?.slug ?? "")
        : "";
    const article =
      articleMatch !== null && slug !== "tags" ? source.resolve(section, slug) : undefined;
    const docs =
      path === "/docs" || path.startsWith("/docs/")
        ? source.resolve("docs", path.slice(6))
        : undefined;
    const tagPath = path === "/blog/tags" || path.startsWith("/blog/tags/");
    const description =
      article?.description ??
      docs?.description ??
      (tagPath
        ? "Explore os artigos por assunto."
        : path === "/blog"
          ? "Artigos sobre assinaturas digitais, TypeScript e infraestrutura Effect-native."
          : path === "/changelog"
            ? "Notas de versão dos pacotes SignatureKit."
            : path === "/assine-documentos-gratis"
              ? signFreeDescription
              : path === "/search"
                ? "Busque na documentação do SignatureKit."
                : "PAdES e XML-DSig com certificado ICP-Brasil, no servidor ou no navegador. Tipado, testado e open source.");
    const meta = (key: string, value: string, property = false): Metadata => ({
      kind: "meta",
      key,
      value,
      property,
    });
    const elements = [
      meta("og:site_name", "SignatureKit", true),
      meta("og:type", article !== undefined ? "article" : "website", true),
      meta("og:locale", "pt_BR", true),
      meta("og:title", application.title, true),
      meta("og:image", `${siteOrigin}${url.pathname === "/" ? "/index" : url.pathname}.webp`, true),
      meta("twitter:card", "summary"),
      meta("twitter:title", application.title),
      ...(description !== ""
        ? [
            meta("description", description),
            meta("og:description", description, true),
            meta("twitter:description", description),
          ]
        : []),
      ...(path === "/search" ? [meta("robots", "noindex")] : []),
    ];
    return { elements, description };
  };
  const renderDocument: Server.DocumentRenderer = (application, assets) => {
    const data = metadata(application);
    if (data === undefined) return Server.renderDocument(application, assets);
    const document = new DOMImplementation().createDocument(null, "metadata", null);
    const serializer = new XMLSerializer();
    const head = data.elements
      .map((metadata) => {
        const element = document.createElement(metadata.kind);
        element.setAttribute(metadata.property ? "property" : "name", metadata.key);
        element.setAttribute("content", metadata.value);
        return serializer.serializeToString(element);
      })
      .join("");
    const signFreeUrl = `${siteOrigin}/assine-documentos-gratis`;
    const structuredData =
      application.canonical === signFreeUrl
        ? {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "SoftwareApplication",
                name: "SignatureKit — Assinador de PDF grátis",
                applicationCategory: "BusinessApplication",
                operatingSystem: "Web",
                url: signFreeUrl,
                description: signFreeDescription,
                offers: { "@type": "Offer", price: "0", priceCurrency: "BRL" },
              },
              {
                "@type": "HowTo",
                name: "Como assinar um documento PDF grátis com certificado A1",
                description: signFreeDescription,
                totalTime: "PT2M",
                step: signFreeSteps.map((step, index) => ({
                  "@type": "HowToStep",
                  position: index + 1,
                  name: step.title,
                  text: step.body,
                  url: `${signFreeUrl}#assinar`,
                })),
              },
              {
                "@type": "FAQPage",
                mainEntity: signFreeFaqs.map((item) => ({
                  "@type": "Question",
                  name: item.question,
                  acceptedAnswer: { "@type": "Answer", text: item.answer },
                })),
              },
            ],
          }
        : undefined;
    const jsonLd =
      structuredData === undefined
        ? ""
        : `<script type="application/ld+json">${JSON.stringify(structuredData).replaceAll("<", "\\u003c")}</script>`;
    const pathname = new URL(application.canonical ?? siteOrigin).pathname;
    const markdownLink =
      pathname === "/docs" || pathname.startsWith("/docs/")
        ? `<link rel="alternate" type="text/markdown" href="${pathname}.md">`
        : "";
    const agentTags = Object.entries(agentMeta)
      .map(
        ([key, value]) =>
          `<meta name="agent:${key}" content="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">`,
      )
      .join("");
    const agentHead = `<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preload" as="image" href="/landing/hero-chapada.webp" fetchpriority="high"><link rel="preload" as="font" type="font/woff2" href="${geistFont}" crossorigin><link rel="preload" as="font" type="font/woff2" href="${geistMonoFont}" crossorigin>${agentTags}${markdownLink}<link rel="help" type="text/plain" href="/llms.txt"><script type="module" src="/webmcp.js"></script>`;
    return Server.renderDocument(application, assets, { head: head + jsonLd + agentHead });
  };
  const renderPage = async (request: Request, buildId?: string): Promise<Server.EntryResult> => {
    const agent = await Effect.runPromise(agentResponse(request));
    if (agent !== undefined) return Server.Responded(agent);
    const feedback = await Effect.runPromise(feedbackResponse(request));
    if (feedback !== undefined) return Server.Responded(feedback);
    const feed = await Effect.runPromise(feedResponse(request));
    if (feed !== undefined) {
      const parsed = parsePublicUrl(request.url);
      if (parsed?._tag === "Page" && parsed.path === "blog/rss.xml" && feed.status === 200)
        await captureServerEvent("blog_rss_requested", request, {});
      return Server.Responded(feed);
    }
    const path = new URL(request.url).pathname;
    const parsedImage = parsePublicUrl(request.url);
    if (
      parsedImage?._tag === "Page" &&
      parsedImage.path.endsWith(".webp") &&
      !path.startsWith("/landing/")
    ) {
      const imagePath = parsedImage.path.slice(0, -5);
      if (imagePath === "") return Server.Responded(new Response("Not found", { status: 404 }));
      const pagePath = imagePath === "index" ? homeRoute({}) : pageRoute({ path: imagePath });
      const page = await renderPage(new Request(`${siteOrigin}${pagePath}`), buildId);
      if (page._tag !== "Rendered")
        return Server.Responded(new Response("Not found", { status: 404 }));
      if (request.method !== "GET" && request.method !== "HEAD")
        return Server.Responded(
          new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }),
        );
      const data = metadata(page.application);
      if (data === undefined) return Server.Responded(new Response("Not found", { status: 404 }));
      const { SocialImage, socialImageLayer } = await import("./social-image");
      const bytes = await Effect.runPromise(
        Effect.gen(function* () {
          const social = yield* SocialImage;
          return yield* social.render({
            title: page.application.title
              .replace(/^SignatureKit — /, "")
              .replace(/ (\||—) SignatureKit$/, ""),
            description: data.description,
            eyebrow: imagePath.startsWith("docs")
              ? "Documentação"
              : imagePath.startsWith("blog")
                ? "Blog"
                : imagePath.startsWith("changelog")
                  ? "Notas de versão"
                  : imagePath === "assine-documentos-gratis"
                    ? "Assinar PDF grátis"
                    : "Open source · TypeScript · ICP-Brasil",
            site: new URL(siteOrigin).host,
          });
        }).pipe(Effect.provide(socialImageLayer)),
        { signal: request.signal },
      );
      return Server.Responded(
        new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
          headers: { "Content-Type": "image/webp" },
        }),
      );
    }
    const legacy = legacyLocaleRedirect(path);
    if (legacy !== undefined) {
      const target = new URL(legacy, request.url);
      target.search = new URL(request.url).search;
      return Server.Responded(Response.redirect(target, 301));
    }
    const parsedRoute = parsePublicUrl(request.url);
    if (parsedRoute === undefined)
      return Server.Responded(new Response("Not found", { status: 404 }));
    const route = parsedRoute._tag === "Page" ? `/${parsedRoute.path}` : "";
    const docs = route === "/docs" || route.startsWith("/docs/");
    const section =
      route === "/blog" || route.startsWith("/blog/")
        ? "blog"
        : route === "/changelog" || route.startsWith("/changelog/")
          ? "changelog"
          : undefined;
    const signing = route === "/assine-documentos-gratis";
    if (route !== "" && route !== "/search" && !docs && section === undefined && !signing)
      return Server.Responded(new Response("Not found", { status: 404 }));
    if (docs && source.resolve("docs", route.slice(6)) === undefined)
      return Server.Responded(new Response("Not found", { status: 404 }));
    const tagRoute = route === "/blog/tags" || route.startsWith("/blog/tags/");
    if (
      tagRoute &&
      route !== "/blog/tags" &&
      !blogTags().some((tag) => encodeURIComponent(tag.slug) === route.slice(11))
    )
      return Server.Responded(new Response("Not found", { status: 404 }));
    if (
      section !== undefined &&
      !tagRoute &&
      route !== `/${section}` &&
      !articles(section).some((entry) => entry.href === pageRoute({ path: route.slice(1) }))
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
      Server.renderToString({ Flags, init, view }, { flags: { path: route, query }, buildId }),
    );
    return Server.Rendered(application);
  };

  return { prerenderPaths, renderDocument, renderPage };
};
export const { prerenderPaths, renderDocument, renderPage } = createServerComposition({
  paths: contentPaths,
  resolve: resolveContent,
});
