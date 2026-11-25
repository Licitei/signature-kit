import { configDefaults, defineConfig } from "vitest/config";
import browser from "./browser.config.ts";
import { sampleRuntimeMemory, writeBenchmark } from "./benchmark-command.ts";

export default defineConfig({
  ...browser,
  test: {
    ...browser.test,
    include: ["packages/**/*.performance.browser.test.*"],
    exclude: configDefaults.exclude,
    globalSetup: [
      ...[browser.test?.globalSetup ?? []].flat(),
      "tooling/vitest/benchmark-worker-bundle.ts",
    ],
    browser: {
      ...browser.test?.browser,
      commands: { ...browser.test?.browser?.commands, sampleRuntimeMemory, writeBenchmark },
    },
  },
});
