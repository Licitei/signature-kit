import { toolPages } from "./tool-pages";
import { homeRoute, pageRoute, parsePublicUrl } from "./routes";
import { Effect } from "effect";
import { createArticleCatalog } from "./articles";
import { contentPaths, resolveContent } from "./content";
import { siteOrigin } from "./site-origin";

const origin = siteOrigin;
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const url = (path: string) => `${origin}${path.split("/").map(encodeURIComponent).join("/")}`;
const articleUrl = (href: string) =>
  `${origin}${href
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/")}`;

export const renderRss = (
  entries: ReturnType<ReturnType<typeof createArticleCatalog>["articles"]>,
) => {
  const items = entries
    .map(
      (entry) =>
        `<item><title>${escapeXml(entry.title)}</title><link>${escapeXml(articleUrl(entry.href))}</link><guid>${escapeXml(articleUrl(entry.href))}</guid><pubDate>${new Date(entry.timestamp).toUTCString()}</pubDate><description>${escapeXml(entry.description ?? "")}</description></item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Blog do SignatureKit</title><link>${url(pageRoute({ path: "blog" }))}</link><description>Histórias e decisões de engenharia sobre assinatura digital no Brasil.</description><language>pt-BR</language><atom:link href="${url(pageRoute({ path: "blog/rss.xml" }))}" rel="self" type="application/rss+xml" />${items}</channel></rss>`;
};

export const createFeeds = (source: {
  paths: typeof contentPaths;
  resolve: typeof resolveContent;
}) => {
  const { articles, blogTags } = createArticleCatalog(source);
  const renderSitemap = () => {
    const staticPaths = [
      "/blog",
      "/blog/tags",
      "/changelog",
      ...toolPages.map((page) => `/${page.path}`),
      "/pdf-core",
      ...blogTags().map(({ slug }) => `/blog/tags/${slug}`),
    ];
    const docs = source
      .paths()
      .filter((path) => path.startsWith("docs/"))
      .map((path) => {
        const slug = path.slice(5);
        return slug === "index" ? "/docs" : `/docs/${slug}`;
      });
    const articlePages = (["blog", "changelog"] satisfies ("blog" | "changelog")[]).flatMap(
      (section) =>
        articles(section).map((entry) => ({ path: `/${section}/${entry.slug}`, date: entry.date })),
    );
    const pages = [
      { path: "", date: undefined },
      ...[...staticPaths, ...docs].map((path) => ({ path, date: undefined })),
      ...articlePages,
    ];
    const entries = pages
      .map(
        (page) =>
          `<url><loc>${escapeXml(url(page.path === "" ? homeRoute({}) : pageRoute({ path: page.path.slice(1) })))}</loc>${page.date !== undefined && page.date !== "" ? `<lastmod>${page.date}</lastmod>` : ""}</url>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
  };

  const feedResponse = (request: Request): Effect.Effect<Response | undefined> =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const parsed = parsePublicUrl(request.url);
      const rss = parsed?._tag === "Page" && parsed.path === "blog/rss.xml";
      if (path !== "/sitemap.xml" && !rss) return undefined;
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      const body = rss ? renderRss(articles("blog")) : renderSitemap();
      return new Response(request.method === "HEAD" ? null : body, {
        headers: {
          "Content-Type": rss ? "application/rss+xml; charset=utf-8" : "application/xml",
        },
      });
    });

  return { renderSitemap, feedResponse };
};
export const { renderSitemap, feedResponse } = createFeeds({
  paths: contentPaths,
  resolve: resolveContent,
});
