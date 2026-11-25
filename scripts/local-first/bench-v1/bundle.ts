import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { build } from "vite";
import { benchmarkAliases, output, root } from "./config.ts";

const entries = {
  "react-a1": {
    "@signature-kit/react/a1": ["useA1Certificate", "useA1Signer"],
  },
  "pdf-sign": {
    "@signature-kit/pdf/workflow": ["prepareAndSignPdf"],
    "@signature-kit/pdf-core/browser": ["pdfCoreBrowserLayer"],
  },
  "pdf-verify": {
    "@signature-kit/pdf/verify": ["verifyPdf"],
    "@signature-kit/pdf-core/browser": ["pdfCoreBrowserLayer"],
  },
  xml: {
    "@signature-kit/xml/sign": ["signXml"],
    "@signature-kit/xml/verify": ["verifyXml"],
    "@signature-kit/xml/runtime": ["xmlRuntimeLayer"],
  },
  "pdf-viewer": {
    "@signature-kit/pdf/render-browser": ["renderPdfPagesBrowser", "pdfPageRendererWorkerLayer"],
  },
};

const chunkSizes = (buffer: Uint8Array) => ({
  raw: buffer.byteLength,
  gzip: gzipSync(buffer, { level: 9 }).byteLength,
  brotli: brotliCompressSync(buffer, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength,
});

export const measureBundles = async () => {
  const rows = [];
  for (const [entry, imports] of Object.entries(entries)) {
    const outDir = resolve(output, "bundles", entry);
    const input = resolve(root, `${entry}.bench-v1.js`);
    const source = [
      ...Object.entries(imports).map(
        ([specifier, names]) => `import { ${names.join(", ")} } from ${JSON.stringify(specifier)};`,
      ),
      `Object.assign(globalThis, { signatureKit: { ${Object.values(imports).flat().join(", ")} } });`,
    ].join("\n");
    await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: "error",
      resolve: {
        alias: { ...benchmarkAliases(), react: resolve(root, "formats/react/node_modules/react") },
      },
      plugins: [
        {
          name: "signature-kit-bench-entry",
          resolveId: (id) => (id === input ? input : null),
          load: (id) => (id === input ? source : null),
        },
      ],
      worker: { format: "es" },
      build: {
        assetsInlineLimit: 0,
        outDir,
        emptyOutDir: true,
        rollupOptions: { input },
      },
    });
    const paths = (await readdir(outDir, { recursive: true, withFileTypes: true }))
      .filter((file) => file.isFile())
      .map((file) => join(file.parentPath, file.name));
    const chunks = await Promise.all(
      paths.sort().map(async (file) => ({
        file: file.slice(outDir.length + 1),
        ...chunkSizes(await readFile(file)),
      })),
    );
    const bytes = chunks.reduce(
      (total, chunk) => ({
        raw: total.raw + chunk.raw,
        gzip: total.gzip + chunk.gzip,
        brotli: total.brotli + chunk.brotli,
      }),
      { raw: 0, gzip: 0, brotli: 0 },
    );
    rows.push({ entry, bytes, chunks });
  }
  return rows;
};
