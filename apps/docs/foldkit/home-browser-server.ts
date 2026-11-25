import { createServer } from "vite";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import stylex from "@stylexjs/unplugin";
import * as Server from "foldkit/experimental/server";
import type { renderDocument, renderPage } from "./entry.server.ts";

const docsRoot = fileURLToPath(new URL("..", import.meta.url));

export const homeBrowserServer = (): Plugin => ({
  name: "home-browser-test-server",
  configureServer(server) {
    const runtime = createServer({
      configFile: false,
      root: docsRoot,
      appType: "custom",
      logLevel: "error",
      plugins: [
        stylex.vite({
          useCSSLayers: true,
          runtimeInjection: false,
          dev: false,
          unstable_moduleResolution: { type: "commonJS", rootDir: docsRoot },
        }),
      ],
      server: { middlewareMode: true, hmr: false, ws: false },
    });
    server.httpServer?.once("close", () => {
      void runtime.then((instance) => instance.close());
    });
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!/^\/(en-US|pt-BR)(?:\/|$)/.test(url.pathname)) return next();
      const abort = new AbortController();
      const close = () => abort.abort();
      response.once("close", close);
      const handle = async () => {
        const entry = await (await runtime).ssrLoadModule("/foldkit/entry.server.ts");
        const render: typeof renderPage = entry.renderPage;
        const document: typeof renderDocument = entry.renderDocument;
        const result = await Server.handleRequest(
          new Request(url, { method: request.method, signal: abort.signal }),
          {
            renderPage: (input) => render(input, "home-http-test"),
            renderDocument: (application) =>
              document(application, {
                entryScript: "/apps/docs/foldkit/home-http-client.ts",
                stylesheets: [],
                modulePreloads: [],
              }),
          },
        );
        const body = await result.arrayBuffer();
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(Buffer.from(body));
      };
      handle()
        .catch(next)
        .finally(() => response.removeListener("close", close));
    });
  },
});
