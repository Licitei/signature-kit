import { configDefaults, defineConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

export default defineConfig({
  ...baseConfig,
  test: {
    include: ["packages/engine/__tests__/pdf/**/*.live.test.ts"],
    exclude: configDefaults.exclude,
    setupFiles: ["./tooling/vitest/load-env.ts"],
  },
});
