import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const stylex = createRequire(new URL("./apps/docs/package.json", import.meta.url))(
  "@stylexjs/unplugin",
);

export default defineConfig({
  plugins: [
    stylex.vite({
      useCSSLayers: true,
      runtimeInjection: false,
      dev: false,
      unstable_moduleResolution: {
        type: "commonJS",
        rootDir: path.join(root, "apps/docs"),
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/docs", import.meta.url)),
    },
  },
  test: {
    teardownTimeout: 2000,
    exclude: [...configDefaults.exclude, "**/*.live.test.*"],
  },
});
