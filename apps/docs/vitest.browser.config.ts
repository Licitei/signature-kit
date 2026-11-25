import path from "node:path";
import { fileURLToPath } from "node:url";

import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

import { feedbackBfcache } from "./foldkit/feedback-bfcache-command.ts";
import { feedbackBrowserServer } from "./foldkit/feedback-browser-server.ts";
import { homeBrowserServer } from "./foldkit/home-browser-server.ts";

const docsRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    stylex.vite({
      useCSSLayers: true,
      runtimeInjection: false,
      dev: false,
      unstable_moduleResolution: { type: "commonJS", rootDir: docsRoot },
    }),
    feedbackBrowserServer(docsRoot),
    homeBrowserServer(),
  ],
  optimizeDeps: { include: ["posthog-js", "react/jsx-dev-runtime", "react-dom/client"] },
  test: {
    include: ["apps/docs/**/*.browser.test.*"],
    teardownTimeout: 2000,
    deps: {
      optimizer: {
        client: { enabled: false },
        ssr: { enabled: false },
      },
    },
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      commands: { feedbackBfcache },
      provider: playwright({
        launchOptions: { channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] },
        contextOptions: { permissions: ["clipboard-read", "clipboard-write"] },
      }),
    },
  },
  resolve: {
    alias: {
      "@": docsRoot,
      react: path.join(docsRoot, "node_modules/react"),
      "react-dom": path.join(docsRoot, "node_modules/react-dom"),
      "posthog-js": path.join(docsRoot, "node_modules/posthog-js"),
    },
  },
});
