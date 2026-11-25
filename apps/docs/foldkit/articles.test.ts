import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { DOMParser } from "@xmldom/xmldom";
import { Effect, Schema } from "effect";
import * as Server from "foldkit/experimental/server";
import { renderContent } from "./content";
import { parseContent } from "./content-parse";
import { Flags, init } from "./main";
import type { HtmlBuilder } from "foldkit/html";
import {
  ArticleDate,
  articles,
  blogTags,
  indexArticles,
  indexTags,
  resolveArticle,
  tagSlug,
} from "./articles";
import {
  createServerComposition,
  prerenderPaths,
  renderDocument,
  renderPage,
} from "./entry.server";

const alternateLanguages = (html: string) => {
  const document = new DOMParser({ onError: () => {} }).parseFromString(html, "text/html");
  return Array.from(document.getElementsByTagName("link")).flatMap((link) =>
    Array.from(link.attributes)
      .filter((attribute) => attribute.name.toLowerCase() === "hreflang")
      .map((attribute) => attribute.value),
  );
};

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const fixtureSource = () => {
  const sources = new Map([
    [
      "blog/ação & api",
      parseContent(
        '---\ntitle: Artigo português\ndate: 2026-01-02\ntags: ["São Paulo & 100%", "Só Brasil"]\n---\nPortuguês',
      ),
    ],
    [
      "blog/outro",
      parseContent('---\ntitle: Outro artigo\ndate: 2026-01-03\ntags: ["Só Outro"]\n---\nOutro'),
    ],
  ]);
  return {
    paths: () => [...sources.keys()],
    resolve: (section: string, slug: string) => sources.get(`${section}/${slug || "index"}`),
  };
};

describe("Foldkit articles", () => {
  it(
    "renders fixture tags through the production server composition",
    { timeout: 15_000 },
    async () => {
      const server = createServerComposition(fixtureSource());
      const assets = { entryScript: "/entry.js", stylesheets: [], modulePreloads: [] };
      const shared = "s%C3%A3o-paulo-%26-100%25";
      const portuguese = "s%C3%B3-brasil";
      const other = "s%C3%B3-outro";
      const render = async (path: string) => {
        const result = await server.renderPage(new Request(`https://example.test${path}`), "test");
        if (result._tag !== "Rendered") return expect.fail(`Missing ${path}`);
        return server.renderDocument(result.application, assets);
      };
      const index = await render("/blog/tags");
      for (const tag of [shared, portuguese, other]) {
        expect(index).toContain(`/blog/tags/${tag}`);
        expect(server.prerenderPaths).toContain(`/blog/tags/${tag}`);
      }
      const head = await server.renderPage(
        new Request(`https://example.test/blog/tags/${shared}`, { method: "HEAD" }),
        "test",
      );
      expect(head._tag).toBe("Rendered");
      if (head._tag === "Rendered")
        expect(server.renderDocument(head.application, assets)).toContain(
          `rel="canonical" href="https://signaturekit.dev/blog/tags/${shared}"`,
        );
      const detail = await render(`/blog/tags/${shared}`);
      expect(detail).toContain("Artigo português");
      expect(detail).not.toContain("Outro artigo");
      expect(detail).toContain("/blog/a%C3%A7%C3%A3o%20%26%20api");
      expect(detail).toContain(
        `rel="canonical" href="https://signaturekit.dev/blog/tags/${shared}"`,
      );
      expect(alternateLanguages(detail)).toEqual([]);
      expect(detail).not.toContain('name="robots"');
      const missing = await server.renderPage(
        new Request("https://example.test/blog/tags/not-a-real-tag"),
        "test",
      );
      expect(missing._tag).toBe("Responded");
      if (missing._tag === "Responded") expect(missing.response.status).toBe(404);
      const sitemapHead = await server.renderPage(
        new Request("https://example.test/sitemap.xml", { method: "HEAD" }),
        "test",
      );
      expect(sitemapHead._tag).toBe("Responded");
      if (sitemapHead._tag === "Responded") {
        expect(sitemapHead.response.status).toBe(200);
        expect(await sitemapHead.response.text()).toBe("");
      }
      const sitemap = await server.renderPage(
        new Request("https://example.test/sitemap.xml"),
        "test",
      );
      if (sitemap._tag !== "Responded") return expect.fail("Missing sitemap");
      const xml = new DOMParser().parseFromString(await sitemap.response.text(), "application/xml");
      const tagUrls = Array.from(xml.getElementsByTagName("url")).filter((item) =>
        item.getElementsByTagName("loc")[0]?.textContent?.includes("/blog/tags/"),
      );
      expect(
        tagUrls
          .map((item) => item.getElementsByTagName("loc")[0]?.textContent)
          .sort((left, right) => String(left).localeCompare(String(right))),
      ).toEqual(
        [shared, portuguese, other]
          .map((tag) => `https://signaturekit.dev/blog/tags/${tag}`)
          .sort(),
      );
      for (const item of tagUrls) expect(item.getElementsByTagName("xhtml:link").length).toBe(0);
    },
  );
  it("serves fixture canonical images and page HEAD over HTTP", async () => {
    const app = createServerComposition(fixtureSource());
    const assets = { entryScript: "/entry.js", stylesheets: [], modulePreloads: [] };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const failures: unknown[] = [];
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((request, reply) => {
                const handle = async () => {
                  const webRequest = new Request(`http://localhost${request.url ?? "/"}`, {
                    method: request.method,
                  });
                  const response = new URL(webRequest.url).pathname.endsWith(".webp")
                    ? Server.toResponse(
                        (application) => app.renderDocument(application, assets),
                        await app.renderPage(webRequest, "test"),
                      )
                    : await Server.handleRequest(webRequest, {
                        renderPage: (input) => app.renderPage(input, "test"),
                        renderDocument: (application) => app.renderDocument(application, assets),
                      });
                  reply.writeHead(response.status, Object.fromEntries(response.headers.entries()));
                  reply.end(Buffer.from(await response.arrayBuffer()));
                };
                handle().catch((error: unknown) => {
                  failures.push(error);
                  reply.writeHead(500).end();
                });
              }),
            ),
            (server) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => {
                    server.closeAllConnections();
                    server.close((error) => (error !== undefined ? reject(error) : resolve()));
                  }),
              ).pipe(Effect.timeout("3 seconds"), Effect.orDie),
          );
          server.listen(0, "127.0.0.1");
          yield* Effect.promise(() => once(server, "listening"));
          const address = server.address();
          if (address === null || typeof address === "string")
            return expect.fail("Missing server address");
          yield* Effect.promise(async (signal) => {
            const base = `http://127.0.0.1:${address.port}`;
            for (const [page, image] of [
              ["/blog/outro", "/blog/outro.webp"],
              ["/blog/a%C3%A7%C3%A3o%20%26%20api", "/blog/a%C3%A7%C3%A3o%20%26%20api.webp"],
              ["/blog/tags/s%C3%A3o-paulo-%26-100%25", "/blog/tags/s%C3%A3o-paulo-%26-100%25.webp"],
            ]) {
              const pageResponse = await fetch(`${base}${page}`, { signal });
              if (pageResponse.status !== 200)
                return expect.fail(`Page failed: ${String(failures[0])}`);
              expect(await pageResponse.text()).toContain(
                `property="og:image" content="https://signaturekit.dev${image}"`,
              );
              const head = await fetch(`${base}${page}`, { method: "HEAD", signal });
              expect(head.status).toBe(200);
              expect(await head.text()).toBe("");
              const imageResponse = await fetch(`${base}${image}`, { signal });
              if (imageResponse.status !== 200)
                return expect.fail(`Image failed: ${String(failures[0])}`);
              expect(imageResponse.headers.get("content-type")).toBe("image/webp");
              const bytes = new Uint8Array(await imageResponse.arrayBuffer());
              expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
              expect(new TextDecoder().decode(bytes.subarray(8, 16))).toBe("WEBPVP8 ");
              const size = new DataView(bytes.buffer);
              expect([
                size.getUint16(26, true) & 0x3fff,
                size.getUint16(28, true) & 0x3fff,
              ]).toEqual([1200, 630]);
            }
          });
        }),
      ).pipe(Effect.timeout("30 seconds")),
    );
  }, 35000);
  it("groups parsed articles into tags", () => {
    const first = parseContent(
      '---\ntitle: Primeiro\ndate: 2026-01-01\ntags: ["São Paulo & Effect", TypeScript]\n---\n',
    );
    const second = parseContent(
      '---\ntitle: Segundo\ndate: 2026-01-02\ntags: ["São Paulo & Effect"]\n---\n',
    );
    const instant = (content: typeof first) => {
      const date = Effect.runSync(Schema.decodeUnknownEffect(ArticleDate)(content)).date;
      return { ...content, date: date.toISOString(), timestamp: date.getTime() };
    };
    const entries = indexArticles("blog", [
      { slug: "ação & api", content: instant(first) },
      { slug: "segundo", content: instant(second) },
    ]);
    const tags = indexTags(entries, (slug) =>
      slug === "ação & api" ? first : slug === "segundo" ? second : undefined,
    );
    expect(tags.map(({ slug }) => slug)).toEqual(["são-paulo-&-effect", "typescript"]);
    expect(tags[0]?.entries.map(({ title, href }) => ({ title, href }))).toEqual([
      { title: "Segundo", href: "/blog/segundo" },
      { title: "Primeiro", href: "/blog/a%C3%A7%C3%A3o%20%26%20api" },
    ]);
    expect(indexTags(entries, () => undefined)).toEqual([]);
  });
  it("indexes legacy tag slugs and exposes only real tag routes", async () => {
    expect(
      parseContent('---\ntitle: Example\ntags: ["São Paulo & Effect", TypeScript]\n---\n').tags,
    ).toEqual(["São Paulo & Effect", "TypeScript"]);
    expect(tagSlug("São Paulo & Effect")).toBe("são-paulo-&-effect");
    const index = await renderPage(new Request("https://example.test/blog/tags"), "test");
    expect(index._tag).toBe("Rendered");
    expect(prerenderPaths).toContain("/blog/tags");
    for (const tag of blogTags()) {
      const path = `/blog/tags/${encodeURIComponent(tag.slug)}`;
      expect(prerenderPaths).toContain(path);
      expect((await renderPage(new Request(`https://example.test${path}`), "test"))._tag).toBe(
        "Rendered",
      );
    }
    const missing = await renderPage(
      new Request("https://example.test/blog/tags/not-a-real-tag"),
      "test",
    );
    expect(missing._tag).toBe("Responded");
    if (missing._tag === "Responded") expect(missing.response.status).toBe(404);
  });

  it("indexes Portuguese articles in reverse chronological order", () => {
    expect(articles("blog")[0]?.title).toContain("assinar com A1");
    const changelog = articles("changelog");
    expect(changelog.length).toBeGreaterThan(1);
    expect(changelog.map((entry) => entry.timestamp)).toEqual(
      changelog.map((entry) => entry.timestamp).sort((a, b) => b - a),
    );
    expect(resolveArticle("changelog", "a1-node-esm-release")?.title).toBe(
      "Publicar o A1 com imports resolvíveis pelo Node",
    );
    expect(changelog.some((entry) => entry.href === "/changelog/a1-node-esm-release")).toBe(true);
    expect(prerenderPaths).toContain("/changelog/a1-node-esm-release");
  });

  for (const section of ["blog", "changelog"] satisfies ("blog" | "changelog")[]) {
    it(`renders every ${section} article and index through the server`, async () => {
      const index = await renderPage(new Request(`https://signaturekit.dev/${section}`), "test");
      expect(index._tag).toBe("Rendered");
      const indexHtml = JSON.stringify(index);
      for (const entry of articles(section)) {
        expect(indexHtml).toContain(entry.title);
        expect(indexHtml).toContain(entry.href);
        const result = await renderPage(
          new Request(`https://signaturekit.dev${entry.href}`),
          "test",
        );
        expect(result._tag).toBe("Rendered");
        const html = JSON.stringify(result);
        expect(html).toContain(entry.title);
        expect(html).toContain(
          section === "changelog"
            ? new Date(entry.date)
                .toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "UTC" })
                .replace(".", "")
            : formatDate(entry.date),
        );
        expect(html).toContain(`https://signaturekit.dev/${section}/${entry.slug}`);
        if (section === "blog" && entry.slug === "signature-kit-x-licitei")
          expect(html).toContain("/docs/signing/certificates");
      }
    }, 30_000);
  }

  it("renders canonical metadata without translation alternates", async () => {
    const assets = { entryScript: "/entry.js", stylesheets: [], modulePreloads: [] };
    for (const path of ["/changelog/a1-node-esm-release", "/blog/signature-kit-x-licitei"]) {
      const result = await renderPage(new Request(`https://signaturekit.dev${path}`), "test");
      if (result._tag !== "Rendered") return expect.fail(`Missing ${path}`);
      const html = renderDocument(result.application, assets);
      expect(html).toContain(`rel="canonical" href="https://signaturekit.dev${path}"`);
      expect(html).toContain('lang="pt-BR"');
      expect(html).not.toContain('name="robots"');
      expect(alternateLanguages(html)).toEqual([]);
    }
  });

  it("renders social metadata with a fixed origin", async () => {
    const assets = { entryScript: "/entry.js", stylesheets: [], modulePreloads: [] };
    for (const path of [
      "/",
      "/blog",
      "/blog/tags",
      "/assine-documentos-gratis",
      "/blog/signature-kit-x-licitei",
    ]) {
      const result = await renderPage(new Request(`https://hostile.example${path}`), "test");
      if (result._tag !== "Rendered") return expect.fail(`Missing ${path}`);
      const html = renderDocument(result.application, assets);
      expect(html).toContain('name="description"');
      expect(html).toContain('property="og:title"');
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:url"');
      expect(html).toContain('property="og:locale" content="pt_BR"');
      expect(html).toContain('property="og:site_name"');
      expect(html).toContain('name="twitter:title"');
      expect(html).not.toContain("hostile.example");
    }
    const search = await renderPage(new Request("https://hostile.example/search?q=test"), "test");
    if (search._tag !== "Rendered") return expect.fail("Missing search");
    expect(renderDocument(search.application, assets)).toContain('name="robots" content="noindex"');
    const escaped = renderDocument({ ...search.application, title: 'A & "<script>' }, assets);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("A &amp; &quot;&lt;script&gt;");
  });

  it("validates required dates and compares actual instants", () => {
    expect(Schema.decodeUnknownOption(ArticleDate)({})._tag).toBe("None");
    for (const date of ["invalid", "1", "2026-02-30"]) {
      expect(Schema.decodeUnknownOption(ArticleDate)({ date })._tag).toBe("None");
    }
    const entries = [
      { slug: "older", date: "2026-01-01T01:00:00+02:00" },
      { slug: "same-b", date: "2026-01-01T02:00:00+02:00" },
      { slug: "same-a", date: "2026-01-01T00:00:00Z" },
      { slug: "newest", date: "2026-01-01T00:30:00Z" },
    ].map(({ slug, date }) => {
      const content = parseContent(`---\ntitle: ${slug}\ndate: "${date}"\n---\n`);
      const instant = Effect.runSync(Schema.decodeUnknownEffect(ArticleDate)(content)).date;
      return { slug, content: { ...content, date, timestamp: instant.getTime() } };
    });
    const indexed = indexArticles("blog", entries);
    expect(indexed.map((entry) => entry.slug)).toEqual(["newest", "same-a", "same-b", "older"]);
    expect(indexed[0]?.href).toBe("/blog/newest");
    expect(indexed[1]?.timestamp).toBe(indexed[2]?.timestamp);
    const first = entries[0];
    if (first === undefined) return expect.fail("Missing entry");
    expect(indexArticles("blog", [{ ...first, slug: "ação & api" }])[0]?.href).toBe(
      "/blog/a%C3%A7%C3%A3o%20%26%20api",
    );
  });

  it("fails malformed article metadata", () => {
    for (const source of ["---\ntitle: Português\ndate: 123\n---\n", "---\ntitle: [\n---\n"]) {
      expect(() => parseContent(source)).toThrow();
    }
  });

  it("preserves relative links in article content", async () => {
    const page = parseContent(
      "---\ntitle: Relative links\n---\n\n[Next](next-page) [Unsafe](javascript:alert%281%29)",
    );
    expect(page).toBeDefined();
    const view = (_model: object, h: HtmlBuilder<never>) => ({
      title: "Relative links",
      body: h.main([], renderContent(page?.nodes ?? [], h)),
    });
    const result = await Effect.runPromise(
      Server.renderToString(
        { Flags, init, view },
        { flags: { path: "/blog" }, isHydratable: false },
      ),
    );
    expect(JSON.stringify(result)).toContain('href=\\"next-page\\"');
    expect(JSON.stringify(result)).not.toContain('href=\\"javascript:');
  });

  it("rejects unknown articles and unsupported locale paths", async () => {
    for (const path of [
      "/blog/missing",
      "/changelog/missing",
      "/pt-br/blog",
      "/blog/signature-kit-x-licitei.pt-BR",
    ]) {
      const result = await renderPage(new Request(`https://signaturekit.dev${path}`), "test");
      expect(result._tag).toBe("Responded");
      if (result._tag === "Responded") expect(result.response.status).toBe(404);
    }
  });
});
