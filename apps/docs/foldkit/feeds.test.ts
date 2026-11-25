import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createServer } from "node:http";
import { once } from "node:events";
import { DOMParser } from "@xmldom/xmldom";
import { articles } from "./articles";
import { contentPaths, resolveContent } from "./content";
import { renderRss } from "./feeds";
import { renderDocument, renderPage } from "./entry.server";

const response = async (path: string, method = "GET") => {
  const result = await renderPage(new Request(`https://example.test${path}`, { method }), "test");
  if (result._tag !== "Responded") return undefined;
  return result.response;
};
const parse = (xml: string) =>
  new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") expect.fail(message);
    },
  }).parseFromString(xml, "application/xml");

describe("feeds", () => {
  it("renders the RSS feed from actual articles", async () => {
    const result = await response("/blog/rss.xml?secret=ignored");
    expect(result?.status).toBe(200);
    expect(result?.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    if (result === undefined) return expect.fail("Expected response");
    const document = parse(await result.text());
    expect(
      document.getElementsByTagName("channel")[0]?.getElementsByTagName("title")[0]?.textContent,
    ).toBe("Blog do SignatureKit");
    expect(document.getElementsByTagName("language")[0]?.textContent).toBe("pt-BR");
    expect(document.getElementsByTagName("item").length).toBeGreaterThan(0);
    expect(
      document.getElementsByTagName("item")[0]?.getElementsByTagName("title")[0]?.textContent,
    ).toBe(articles("blog")[0]?.title);
    expect(
      Array.from(document.getElementsByTagName("item")).map((item) => [
        item.getElementsByTagName("link")[0]?.textContent,
        item.getElementsByTagName("pubDate")[0]?.textContent,
      ]),
    ).toEqual(
      articles("blog").map((entry) => [
        `https://signaturekit.dev${entry.href}`,
        new Date(entry.timestamp).toUTCString(),
      ]),
    );
  });
  it("escapes reserved characters in XML text and URLs", () => {
    const entry = articles("blog")[0];
    if (entry === undefined) return expect.fail("Missing article");
    const document = parse(
      renderRss([
        { ...entry, title: `A & <B> "C" 'D'`, description: "one & two", href: "/blog/a&b" },
      ]),
    );
    const item = document.getElementsByTagName("item")[0];
    expect(item?.getElementsByTagName("title")[0]?.textContent).toBe(`A & <B> "C" 'D'`);
    expect(item?.getElementsByTagName("description")[0]?.textContent).toBe("one & two");
    expect(item?.getElementsByTagName("link")[0]?.textContent).toBe(
      "https://signaturekit.dev/blog/a%26b",
    );
  });
  it("lists canonical pages and validated article dates", async () => {
    const result = await response("/sitemap.xml");
    expect(result?.status).toBe(200);
    if (result === undefined) return expect.fail("Expected response");
    const document = parse(await result.text());
    const entries = Array.from(document.getElementsByTagName("url"));
    const docs = contentPaths()
      .filter((path) => path.startsWith("docs/"))
      .map((path) => path.slice(5))
      .map((slug) => `/docs${slug === "index" ? "" : `/${slug}`}`);
    const posts = (["blog", "changelog"] satisfies ("blog" | "changelog")[]).flatMap((section) =>
      articles(section).map((entry) => entry.href),
    );
    const tagNames = new Set(
      contentPaths()
        .filter((path) => path.startsWith("blog/"))
        .flatMap((path) => resolveContent("blog", path.slice(5))?.tags ?? []),
    );
    const tags = [...tagNames].map((tag) => `/blog/tags/${tag.toLowerCase().replace(/\s+/g, "-")}`);
    const expected = [
      "/",
      "/blog",
      "/blog/tags",
      "/changelog",
      "/assine-documentos-gratis",
      ...docs,
      ...posts,
      ...tags,
    ];
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
    for (const entry of entries) expect(entry.getElementsByTagName("xhtml:link").length).toBe(0);
    const find = (path: string) =>
      entries.find(
        (entry) =>
          entry.getElementsByTagName("loc")[0]?.textContent === `https://signaturekit.dev${path}`,
      );
    expect(
      find("/blog/signature-kit-x-licitei")?.getElementsByTagName("lastmod")[0]?.textContent,
    ).toBe(articles("blog").find((entry) => entry.slug === "signature-kit-x-licitei")?.date);
    expect(
      find("/changelog/a1-node-esm-release")?.getElementsByTagName("lastmod")[0]?.textContent,
    ).toBe(articles("changelog").find((entry) => entry.slug === "a1-node-esm-release")?.date);
    expect(find("/docs")).toBeDefined();
    expect(find("/en-US/docs")).toBeUndefined();
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
            const head = await fetch(`${origin}/blog/rss.xml`, { method: "HEAD", signal });
            expect(head.status).toBe(200);
            expect(await head.text()).toBe("");
            const missing = await fetch(`${origin}/blog/missing`, { signal });
            expect(missing.status).toBe(404);
            await missing.text();
            const hostile = await fetch(`${origin}/blog/rss.xml`, {
              headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
              signal,
            });
            expect(await hostile.text()).not.toContain("evil.example");
          });
        }),
      ).pipe(Effect.timeout("10 seconds")),
    );
  }, 15000);
  it("serves social images over HTTP and advertises the matching URL", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const failures: unknown[] = [];
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((request, reply) => {
                const handle = async () => {
                  const result = await renderPage(
                    new Request(`http://localhost${request.url ?? "/"}`, {
                      method: request.method,
                    }),
                    "test",
                  );
                  if (result._tag === "Responded") {
                    reply.writeHead(
                      result.response.status,
                      Object.fromEntries(result.response.headers.entries()),
                    );
                    reply.end(Buffer.from(await result.response.arrayBuffer()));
                  } else {
                    reply.writeHead(200, { "Content-Type": "text/html" });
                    reply.end(
                      renderDocument(result.application, {
                        entryScript: "/entry.js",
                        stylesheets: [],
                        modulePreloads: [],
                      }),
                    );
                  }
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
              ["/", "/index.webp"],
              ["/blog/signature-kit-x-licitei", "/blog/signature-kit-x-licitei.webp"],
            ]) {
              const pageResponse = await fetch(`${base}${page}`, { signal });
              if (pageResponse.status !== 200)
                return expect.fail(
                  `Page request returned ${pageResponse.status}: ${String(failures[0])}`,
                );
              const html = await pageResponse.text();
              expect(html).toContain(
                `property="og:image" content="https://signaturekit.dev${image}"`,
              );
              const response = await fetch(`${base}${image}`, { signal });
              if (response.status !== 200)
                return expect.fail(`Image request failed: ${String(failures[0])}`);
              expect(response.headers.get("content-type")).toBe("image/webp");
              const bytes = new Uint8Array(await response.arrayBuffer());
              expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
              expect(new TextDecoder().decode(bytes.subarray(8, 16))).toBe("WEBPVP8 ");
              const dimensions = new DataView(bytes.buffer);
              expect([
                dimensions.getUint16(26, true) & 0x3fff,
                dimensions.getUint16(28, true) & 0x3fff,
              ]).toEqual([1200, 630]);
              const head = await fetch(`${base}${image}`, { method: "HEAD", signal });
              expect(head.status).toBe(200);
              expect(head.headers.get("content-type")).toBe("image/webp");
              expect(await head.text()).toBe("");
              const post = await fetch(`${base}${image}`, { method: "POST", signal });
              expect(post.status).toBe(405);
              expect(post.headers.get("allow")).toBe("GET, HEAD");
            }
            expect((await fetch(`${base}/blog/not-real.webp`, { signal })).status).toBe(404);
            expect((await fetch(`${base}/.webp`, { signal })).status).toBe(404);
          });
        }),
      ).pipe(Effect.timeout("30 seconds")),
    );
  }, 35000);
  it("honors HEAD and rejects invalid routes and methods", async () => {
    for (const path of ["/sitemap.xml", "/blog/rss.xml"]) {
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
    for (const path of ["/blog/missing", "/sitemap.xml/missing", "/fr-FR/blog/rss.xml"])
      expect((await response(path))?.status).toBe(404);
  });
});
