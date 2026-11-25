import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { writeLocalFirstBaseline } from "./local-first-baseline-command.ts";
import { blockLocalRuntimeNetwork, trackLocalRuntimeRequests } from "./local-runtime-network.ts";

export default defineConfig({
  assetsInclude: ["**/*.p12"],
  optimizeDeps: {
    include: [
      "react/jsx-dev-runtime",
      "@effect/platform-browser/BrowserRuntime",
      "@effect/platform-browser/BrowserWorkerRunner",
      "effect/rpc/RpcServer",
    ],
    exclude: [
      "@typeonce/effect-machine",
      "@aws-sdk/credential-provider-web-identity",
      "@aws-sdk/credential-providers",
      "@distilled.cloud/aws",
      "alchemy",
    ],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../apps/docs", import.meta.url)),
      react: fileURLToPath(new URL("../../formats/react/node_modules/react", import.meta.url)),
      "react-dom": fileURLToPath(
        new URL("../../formats/react/node_modules/react-dom", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/*.browser.test.*"],
    teardownTimeout: 2000,
    globalSetup: [
      "tooling/testing/__tests__/packed-browser-setup.ts",
      "tooling/testing/__tests__/local-telemetry-collector.ts",
    ],
    deps: {
      optimizer: {
        client: { enabled: false },
        ssr: { enabled: false },
      },
    },
    browser: {
      enabled: true,
      commands: { blockLocalRuntimeNetwork, trackLocalRuntimeRequests, writeLocalFirstBaseline },
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
