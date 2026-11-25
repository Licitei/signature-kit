import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { blockLocalRuntimeNetwork, trackLocalRuntimeRequests } from "./local-runtime-network.ts";

export default defineConfig({
  assetsInclude: ["**/*.p12"],
  optimizeDeps: {
    include: [
      "@effect/platform-browser/BrowserRuntime",
      "@effect/platform-browser/BrowserWorkerRunner",
      "effect/rpc/RpcServer",
    ],
    exclude: ["@typeonce/effect-machine"],
  },
  test: {
    include: ["packages/**/*.browser.test.*"],
    teardownTimeout: 2000,
    globalSetup: ["tooling/testing/__tests__/local-telemetry-collector.ts"],
    deps: {
      optimizer: {
        client: { enabled: false },
        ssr: { enabled: false },
      },
    },
    browser: {
      enabled: true,
      commands: { blockLocalRuntimeNetwork, trackLocalRuntimeRequests },
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
