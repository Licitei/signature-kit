import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublicUrl } from "./foldkit/routes";
import { siteOrigin } from "./foldkit/site-origin";
import stylex from "@stylexjs/unplugin";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const docsRoot = path.dirname(fileURLToPath(import.meta.url));

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
      if (!agentRoute && (route?._tag !== "Page" || !route.path.endsWith(".webp"))) return next();
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
