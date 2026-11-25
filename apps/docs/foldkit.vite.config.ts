import path from "node:path";
import { fileURLToPath } from "node:url";
import { siteOrigin } from "./foldkit/site-origin.ts";
import stylex from "@stylexjs/unplugin";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

const docsRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  worker: { format: "es" },
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
