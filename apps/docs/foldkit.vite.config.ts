import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseContent } from "./foldkit/content-parse.ts";
import { parsePublicUrl } from "./foldkit/routes.ts";
import { siteOrigin } from "./foldkit/site-origin.ts";
import stylex from "@stylexjs/unplugin";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const docsRoot = path.dirname(fileURLToPath(import.meta.url));

const contentDataId = "\0signaturekit-content-data";
const contentFiles = (pattern: RegExp) =>
  readdirSync(path.join(docsRoot, "content"), { recursive: true, encoding: "utf8" })
    .filter((file) => pattern.test(file))
    .map((file) => `../content/${file.split(path.sep).join("/")}`)
    .sort();
const contentChunkPrefix = "\0signaturekit-content-chunk:";
const prebuiltContent: Plugin = {
  name: "signaturekit-prebuilt-content",
  apply: "build",
  enforce: "pre",
  resolveId(source, importer) {
    if (source.startsWith(contentChunkPrefix)) return source;
    if (
      this.environment.name !== "client" ||
      source !== "./content-data" ||
      importer === undefined ||
      path.basename(importer) !== "content.ts"
    )
      return null;
    return contentDataId;
  },
  load(id) {
    const read = (file: string) => readFileSync(path.join(docsRoot, "foldkit", file), "utf8");
    const pages = contentFiles(/^(docs|blog|changelog)\/.*\.mdx$/);
    const serialize = (value: unknown) =>
      JSON.stringify(
        JSON.stringify(value, (key, entry) =>
          key === "position" || key === "loc" || key === "range" ? undefined : entry,
        ),
      );
    if (id.startsWith(contentChunkPrefix)) {
      const target = id.slice(contentChunkPrefix.length);
      const files = pages.includes(target)
        ? [target]
        : pages.filter((file) => file.startsWith(`../content/${target}/`));
      return `export default JSON.parse(${serialize(
        Object.fromEntries(files.map((file) => [file, parseContent(read(file))])),
      )});`;
    }
    if (id !== contentDataId) return null;
    const metadata = contentFiles(/^docs\/(.*\/)?meta[^/]*\.json$/);
    const light = Object.fromEntries(
      pages.map((file) => {
        const { title, description, date, author, tags } = parseContent(read(file));
        return [file, { title, description, date, author, tags, nodes: [] }];
      }),
    );
    const loader = (target: string) =>
      `${JSON.stringify(target)}: () => import(${JSON.stringify(`${contentChunkPrefix}${target}`)})`;
    return [
      `export const contentSources = {};`,
      `export const contentKeys = ${JSON.stringify(pages)};`,
      `export const contentMetadata = ${JSON.stringify(Object.fromEntries(metadata.map((file) => [file, read(file)])))};`,
      `const light = JSON.parse(${serialize(light)});`,
      `const full = Object.create(null);`,
      `const loaders = {${[...pages, "docs", "blog", "changelog"].map(loader).join(",")}};`,
      `export const loadContent = (path) => full[path] ?? light[path];`,
      `export const loadedContentCount = () => Object.keys(full).length;`,
      `export const preloadContent = (targets) => Promise.all(targets.filter((target) => loaders[target] !== undefined && full[target] === undefined).map((target) => loaders[target]().then((chunk) => Object.assign(full, chunk.default)))).then(() => undefined);`,
    ].join("\n");
  },
};

const socialImages: Plugin = {
  name: "signaturekit-social-images",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const route = parsePublicUrl(url.href);
      const agentRoute =
        url.pathname === "/llms.txt" ||
        url.pathname === "/llms-full.txt" ||
        url.pathname === "/robots.txt" ||
        url.pathname === "/sitemap.xml" ||
        url.pathname.endsWith("/rss.xml") ||
        url.pathname === "/api/search.json" ||
        url.pathname === "/.well-known/search" ||
        (url.pathname.startsWith("/docs") &&
          (url.pathname.endsWith(".md") ||
            String(request.headers.accept ?? "").includes("text/markdown")));
      if (
        !agentRoute &&
        (route?._tag !== "Page" ||
          !route.path.endsWith(".webp") ||
          url.pathname.startsWith("/landing/"))
      )
        return next();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      response.once("close", cancel);
      const readBody = async () => {
        const chunks: Array<Uint8Array> = [];
        for await (const chunk of request) chunks.push(chunk);
        return Buffer.concat(chunks).toString("utf8");
      };
      const run = async () => {
        const entry = await server.ssrLoadModule("/foldkit/entry.server.ts");
        const result = await entry.renderPage(
          new Request(url, {
            method: request.method,
            signal: controller.signal,
            headers: {
              accept: String(request.headers.accept ?? ""),
              "content-type": String(request.headers["content-type"] ?? ""),
            },
            ...(request.method === "QUERY" ? { body: await readBody() } : {}),
          }),
        );
        if (result._tag !== "Responded") {
          response.writeHead(404).end();
          return;
        }
        const body = await result.response.arrayBuffer();
        response.writeHead(
          result.response.status,
          Object.fromEntries(result.response.headers.entries()),
        );
        response.end(Buffer.from(body));
      };
      run()
        .catch(() => {
          if (!response.destroyed) response.writeHead(500).end();
        })
        .finally(() => response.removeListener("close", cancel));
    });
  },
};

export default defineConfig({
  envPrefix: ["VITE_", "WAKU_PUBLIC_"],
  define: {
    "process.env.VERCEL_PROJECT_PRODUCTION_URL": JSON.stringify(
      process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "",
    ),
  },
  environments: { ssr: { build: { copyPublicDir: false } } },
  plugins: [
    stylex.vite({
      useCSSLayers: true,
      runtimeInjection: false,
      dev: process.env.NODE_ENV === "development",
      unstable_moduleResolution: { type: "commonJS", rootDir: docsRoot },
    }),
    socialImages,
    prebuiltContent,
    foldkit({
      devToolsMcpPort: false,
      ssr: {
        clientEntry: "/foldkit/entry.client.ts",
        serverEntry: "/foldkit/entry.server.ts",
        build: {
          clientOutDir: "dist-foldkit/client",
          serverOutDir: "dist-foldkit/server",
          prerender: { origin: siteOrigin },
        },
      },
    }),
  ],
});
