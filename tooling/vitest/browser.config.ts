import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { blockLocalRuntimeNetwork, trackLocalRuntimeRequests } from "./local-runtime-network.ts";
import { runBatchResume, sampleBatchPageHeap, verifyPdfIndependently } from "./batch-command.ts";
import { runCosignMilestone } from "./cosign-command.ts";
import { runLtvMilestone } from "./ltv-command.ts";

export default defineConfig({
  assetsInclude: ["**/*.p12"],
  optimizeDeps: {
    entries: [
      "packages/**/*.browser.test.ts",
      "packages/browser/src/worker{,-telemetry}.ts",
      "packages/browser/__tests__/cosign-page.ts",
      "packages/browser/__tests__/batch-page.ts",
      "packages/browser/__tests__/ltv-page.ts",
      "packages/browser/__tests__/*.worker.ts",
    ],
    include: [
      "@effect/opentelemetry",
      "@effect/platform-browser",
      "@effect/platform-browser/BrowserRuntime",
      "effect/persistence/KeyValueStore",
      "@effect/platform-browser/BrowserWorkerRunner",
      "@opentelemetry/exporter-trace-otlp-http",
      "effect/rpc/RpcServer",
      "effect/encoding",
    ],
    exclude: ["@typeonce/effect-machine"],
  },
  test: {
    include: ["packages/**/*.browser.test.*"],
    exclude: [...configDefaults.exclude, "**/*.performance.browser.test.*"],
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
      commands: {
        blockLocalRuntimeNetwork,
        trackLocalRuntimeRequests,
        runCosignMilestone,
        runLtvMilestone,
        runBatchResume,
        sampleBatchPageHeap,
        verifyPdfIndependently,
      },
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
