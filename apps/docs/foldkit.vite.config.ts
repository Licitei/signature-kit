import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseContent } from "./foldkit/content-parse";
import { parsePublicUrl } from "./foldkit/routes";
import { siteOrigin } from "./foldkit/site-origin";
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
const prebuiltContent: Plugin = {
  name: "signaturekit-prebuilt-content",
  apply: "build",
  enforce: "pre",
  resolveId(source, importer) {
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
    if (id !== contentDataId) return null;
    const read = (file: string) => readFileSync(path.join(docsRoot, "foldkit", file), "utf8");
    const pages = contentFiles(/^(docs|blog|changelog)\/.*\.mdx$/);
    const metadata = contentFiles(/^docs\/(.*\/)?meta[^/]*\.json$/);
    const parsed = JSON.stringify(
      Object.fromEntries(pages.map((file) => [file, parseContent(read(file))])),
      (key, value) => (key === "position" || key === "loc" || key === "range" ? undefined : value),
    );
    return [
      `export const contentSources = {};`,
      `export const contentKeys = ${JSON.stringify(pages)};`,
      `export const contentMetadata = ${JSON.stringify(Object.fromEntries(metadata.map((file) => [file, read(file)])))};`,
      `const parsed = JSON.parse(${JSON.stringify(parsed)});`,
      `export const loadContent = (path) => parsed[path];`,
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
