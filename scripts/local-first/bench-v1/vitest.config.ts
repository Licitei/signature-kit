import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineBrowserCommand, playwright } from "@vitest/browser-playwright";
import type { CDPSession, Page } from "playwright";
import { defineConfig } from "vitest/config";
import { benchmarkAliases, output, root } from "./config.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    readV1Heap: () => Promise<Record<string, number>>;
    writeV1Browser: (data: object) => Promise<void>;
  }
}

const sessions = new WeakMap<Page, Promise<CDPSession>>();
const readV1Heap = defineBrowserCommand(async ({ page }) => {
  let session = sessions.get(page);
  if (session === undefined) {
    session = page
      .context()
      .newCDPSession(page)
      .then(async (cdp) => {
        await cdp.send("Performance.enable");
        return cdp;
      });
    sessions.set(page, session);
  }
  const { metrics } = await (await session).send("Performance.getMetrics");
  return Object.fromEntries(
    metrics
      .filter(({ name }) => name === "JSHeapUsedSize" || name === "JSHeapTotalSize")
      .map(({ name, value }) => [name, value]),
  );
});

const writeV1Browser = defineBrowserCommand(async ({ page }, results: object) => {
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "chromium.json"),
    JSON.stringify(
      {
        chromium: page.context().browser()?.version(),
        ...results,
      },
      null,
      2,
    ) + "\n",
  );
});

export default defineConfig({
  root,
  plugins: [
    {
      name: "signature-kit-wasm-copy-observer",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "shared/pdf-core/dist/pdf-core.js")) return;
        const result =
          "Effect.succeed(new Uint8Array(block.memory, block.pointer + RESULT_HEADER_BYTES, block.length - RESULT_HEADER_BYTES).slice())";
        if (code.indexOf(result) < 0 || code.indexOf(result) !== code.lastIndexOf(result)) {
          this.error("The pdf-core result copy point has changed.");
        }
        const pageWrite =
          "new Uint32Array(core.memory.buffer, pages.pointer, pageIndexes.length).set(pageIndexes);";
        if (!code.includes(pageWrite))
          this.error("The pdf-core page-index copy point has changed.");
        return code
          .replace(
            result,
            result +
              '.pipe(Effect.withSpan("bench.v1.wasm.copyOut", { attributes: { "signature_kit.wasm.output_bytes": block.length - RESULT_HEADER_BYTES } }))',
          )
          .replaceAll(
            pageWrite,
            pageWrite +
              ' if (pageIndexes.length > 0) yield* Effect.void.pipe(Effect.withSpan("pdfCore.wasm.copyIn", { attributes: { "signature_kit.wasm.input_bytes": pages.length } }));',
          );
      },
    },
  ],
  assetsInclude: ["**/*.p12", "**/*.pdf"],
  optimizeDeps: {
    exclude: [
      "effect",
      "@effect/platform-browser",
      "@alchemy.run/domain",
      "alchemy",
      "@distilled.cloud/aws",
    ],
  },
  resolve: {
    dedupe: ["effect"],
    alias: {
      ...benchmarkAliases(),
      react: resolve(root, "formats/react/node_modules/react"),
      "react-dom": resolve(root, "formats/react/node_modules/react-dom"),
    },
  },
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: { name: "v1-node", include: ["scripts/local-first/bench-v1/node.bench.ts"] },
      },
      {
        extends: true,
        test: {
          name: "v1-chromium",
          include: ["scripts/local-first/bench-v1/chromium.bench.ts"],
          browser: {
            enabled: true,
            provider: playwright({ launchOptions: { args: ["--enable-precise-memory-info"] } }),
            headless: true,
            instances: [{ browser: "chromium" }],
            commands: { writeV1Browser, readV1Heap },
          },
        },
      },
    ],
  },
});
