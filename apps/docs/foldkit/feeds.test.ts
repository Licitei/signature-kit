import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createServer } from "node:http";
import { once } from "node:events";
import { JSDOM } from "jsdom";
import { articles } from "./articles";
import { contentPaths, resolveContent } from "./content";
import { renderRss } from "./feeds";
import { renderPage } from "./entry.server";

const response = async (path: string, method = "GET") => {
  const result = await renderPage(new Request(`https://example.test${path}`, { method }), "test");
  if (result._tag !== "Responded") return undefined;
  return result.response;
};
const parse = (xml: string) => new JSDOM(xml, { contentType: "application/xml" }).window.document;

describe("feeds", () => {
  it("renders both localized RSS feeds", async () => {
    for (const locale of ["en-US", "pt-BR"] satisfies ("en-US" | "pt-BR")[]) {
      const result = await response(`/${locale}/blog/rss.xml?secret=ignored`);
      expect(result?.status).toBe(200);
      expect(result?.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
      if (result === undefined) return expect.fail("Expected response");
      const document = parse(await result.text());
      expect(
        document.getElementsByTagName("channel")[0]?.getElementsByTagName("title")[0]?.textContent,
      ).toBe(locale === "en-US" ? "SignatureKit Blog" : "Blog do SignatureKit");
      expect(document.getElementsByTagName("language")[0]?.textContent).toBe(locale);
      const expected = articles(locale, "blog").filter((entry) =>
        resolveContent(locale, "blog", entry.slug),
      );
      expect(
        Array.from(document.getElementsByTagName("item")).map((item) => [
          item.getElementsByTagName("link")[0]?.textContent,
          item.getElementsByTagName("pubDate")[0]?.textContent,
        ]),
      ).toEqual(
        expected.map((entry) => [
          `https://signaturekit.dev${entry.href}`,
          new Date(entry.timestamp).toUTCString(),
        ]),
      );
    }
  });
  it("escapes reserved characters in XML text and URLs", () => {
    const entry = articles("en-US", "changelog")[0];
    if (entry === undefined) return expect.fail("Missing article");
    const document = parse(
      renderRss("en-US", [
        { ...entry, title: `A & <B> "C" 'D'`, description: "one & two", href: "/en-US/blog/a&b" },
      ]),
    );
    const item = document.getElementsByTagName("item")[0];
    expect(item?.getElementsByTagName("title")[0]?.textContent).toBe(`A & <B> "C" 'D'`);
    expect(item?.getElementsByTagName("description")[0]?.textContent).toBe("one & two");
    expect(item?.getElementsByTagName("link")[0]?.textContent).toBe(
      "https://signaturekit.dev/en-US/blog/a%26b",
    );
  });
  it("lists canonical pages, translations and validated article dates", async () => {
    const result = await response("/sitemap.xml");
    expect(result?.status).toBe(200);
    if (result === undefined) return expect.fail("Expected response");
    const document = parse(await result.text());
    const entries = Array.from(document.getElementsByTagName("url"));
    const expected = (["en-US", "pt-BR"] satisfies ("en-US" | "pt-BR")[]).flatMap((locale) => {
      const docs = contentPaths()
        .filter(
          (path) =>
            path.startsWith("docs/") &&
            (locale === "pt-BR" ? path.endsWith(".pt-BR") : !path.endsWith(".pt-BR")),
        )
        .map((path) => path.slice(5).replace(/\.pt-BR$/, ""))
        .map((slug) => `/${locale}/docs${slug === "index" ? "" : `/${slug}`}`);
      const posts = (["blog", "changelog"] satisfies ("blog" | "changelog")[]).flatMap((section) =>
        articles(locale, section)
          .filter((entry) => resolveContent(locale, section, entry.slug))
          .map((entry) => entry.href),
      );
      const tagNames = new Set(
        contentPaths()
          .filter(
            (path) =>
              path.startsWith("blog/") &&
              (locale === "pt-BR" ? path.endsWith(".pt-BR") : !path.endsWith(".pt-BR")),
          )
          .flatMap(
            (path) =>
              resolveContent(locale, "blog", path.slice(5).replace(/\.pt-BR$/, ""))?.tags ?? [],
          ),
      );
      const tags = [...tagNames].map(
        (tag) => `/${locale}/blog/tags/${tag.toLowerCase().replace(/\s+/g, "-")}`,
      );
      return [
        `/${locale}`,
        `/${locale}/blog`,
        `/${locale}/blog/tags`,
        `/${locale}/changelog`,
        ...docs,
        ...posts,
        ...tags,
      ];
    });
    expect(
      entries
        .map((entry) => entry.getElementsByTagName("loc")[0]?.textContent ?? "")
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      expected
        .map(
          (path) => `https://signaturekit.dev${path.split("/").map(encodeURIComponent).join("/")}`,
        )
        .sort((a, b) => a.localeCompare(b)),
    );
    for (const entry of entries) {
      const loc = entry.getElementsByTagName("loc")[0]?.textContent ?? "";
      const path = new URL(loc).pathname.replace(/^\/(en-US|pt-BR)/, "");
      const links = Array.from(entry.getElementsByTagName("xhtml:link"));
      expect(
        links.map((link) => [link.getAttribute("hreflang"), link.getAttribute("href")]),
      ).toEqual(
        ["en-US", "pt-BR"]
          .filter((locale) =>
            expected.some(
              (candidate) =>
                candidate.split("/").map(encodeURIComponent).join("/") === `/${locale}${path}`,
            ),
          )
          .map((locale) => [locale, `https://signaturekit.dev/${locale}${path}`]),
      );
    }
    const find = (path: string) =>
      entries.find(
        (entry) =>
          entry.getElementsByTagName("loc")[0]?.textContent === `https://signaturekit.dev${path}`,
      );
    expect(find("/pt-BR/changelog/a1-node-esm-release")).toBeUndefined();
    expect(
      find("/en-US/changelog/a1-node-esm-release")?.getElementsByTagName("lastmod")[0]?.textContent,
    ).toBe(
      articles("en-US", "changelog").find((entry) => entry.slug === "a1-node-esm-release")?.date,
    );
    expect(find("/en-US/docs")).toBeDefined();
  });
  it("serves feeds over HTTP", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((request, reply) => {
                const controller = new AbortController();
                reply.once("close", () => controller.abort());
                const handle = async () => {
                  const forwardedHost = request.headers["x-forwarded-host"];
                  const rendered = await renderPage(
                    new Request(
                      `http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`,
                      {
                        method: request.method,
                        signal: controller.signal,
                        headers: {
                          "x-forwarded-host": Array.isArray(forwardedHost)
                            ? forwardedHost.join(", ")
                            : (forwardedHost ?? ""),
                        },
                      },
                    ),
                  );
                  const result = rendered._tag === "Responded" ? rendered.response : undefined;
                  if (result === undefined) {
                    reply.writeHead(500).end();
                    return;
                  }
                  reply.writeHead(result.status, Object.fromEntries(result.headers.entries()));
                  reply.end(await result.text());
                };
                handle().catch((error: unknown) =>
                  reply.destroy(error instanceof Error ? error : undefined),
                );
              }),
            ),
            (server) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => {
                    server.closeAllConnections();
                    server.close((error) =>
                      error !== undefined &&
                      (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
                        ? reject(error)
                        : resolve(),
                    );
                  }),
              ).pipe(Effect.timeout("3 seconds"), Effect.orDie),
          );
          server.listen(0, "127.0.0.1");
          yield* Effect.promise(() => once(server, "listening"));
          const address = server.address();
          if (address === null || typeof address === "string")
            return expect.fail("Missing server address");
          const origin = `http://127.0.0.1:${address.port}`;
          yield* Effect.promise(async (signal) => {
            const get = await fetch(`${origin}/sitemap.xml`, { signal });
            expect(get.status).toBe(200);
            expect(parse(await get.text()).documentElement?.localName).toBe("urlset");
            const head = await fetch(`${origin}/en-US/blog/rss.xml`, { method: "HEAD", signal });
            expect(head.status).toBe(200);
            expect(await head.text()).toBe("");
            const missing = await fetch(`${origin}/en-US/blog/missing`, { signal });
            expect(missing.status).toBe(404);
            await missing.text();
            const hostile = await fetch(`${origin}/en-US/blog/rss.xml`, {
              headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
              signal,
            });
            expect(await hostile.text()).not.toContain("evil.example");
          });
        }),
      ).pipe(Effect.timeout("10 seconds")),
    );
  }, 15000);
  it("honors HEAD and rejects invalid routes and methods", async () => {
    for (const path of ["/sitemap.xml", "/en-US/blog/rss.xml"]) {
      const head = await response(path, "HEAD");
      expect(head?.status).toBe(200);
      expect(head?.headers.get("content-type")).toBe(
        path === "/sitemap.xml" ? "application/xml" : "application/rss+xml; charset=utf-8",
      );
      expect(head?.headers.get("cache-control")).toBeNull();
      expect(await head?.text()).toBe("");
      const post = await response(path, "POST");
      expect(post?.status).toBe(405);
      expect(post?.headers.get("allow")).toBe("GET, HEAD");
    }
    for (const path of ["/pt-br/blog/rss.xml", "/en-US/blog/missing", "/sitemap.xml/missing"])
      expect((await response(path))?.status).toBe(404);
  });
});
