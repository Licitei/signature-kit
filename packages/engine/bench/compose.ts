import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { compose, ComposeRuntime, Document } from "../dist/compose.js";
import type { ComposeDocument } from "../dist/compose.js";
import {
  contractTemplate,
  evidenceReportTemplate,
  receiptTemplate,
  sampleEvidence,
} from "../dist/templates.js";
import { encodeComposition } from "../dist/composition/encode.js";
import { PdfCore } from "../dist/wasm/pdf-core.js";
import { pdfCoreFileLayer } from "../dist/wasm/file.js";
import { composeFileLayer } from "../dist/wasm/compose.js";

const templates = {
  contract: contractTemplate,
  report: (count: number): ComposeDocument =>
    Document(
      ...Array.from({ length: count }, () => evidenceReportTemplate(sampleEvidence).pages).flat(),
    ),
  receipt: (count: number): ComposeDocument =>
    Document(...Array.from({ length: count }, () => receiptTemplate().pages).flat()),
};
const [kind, countArgument] = process.argv.slice(2);
const count = Number(countArgument);
const template = Object.entries(templates).find(([name]) => name === kind)?.[1];
if (template === undefined || !Number.isInteger(count) || count < 1 || count > 100) {
  const sizes = await Promise.all(
    ["signature-kit.wasm", "compose.wasm"].map(async (name) => {
      const bytes = await readFile(new URL(`../dist/wasm/${name}`, import.meta.url));
      return { name, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
    }),
  );
  console.table(sizes);
} else {
  const document = template(count);
  const runtime = Layer.merge(composeFileLayer, pdfCoreFileLayer).pipe(
    Layer.provide(NodeServices.layer),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const start = performance.now();
      const pdf = yield* compose(document);
      const cold = performance.now() - start;
      const warm = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = performance.now();
        yield* compose(document);
        warm.push(performance.now() - before);
      }
      warm.sort((left, right) => left - right);
      const peakRssKiB = process.resourceUsage().maxRSS;
      const { fonts } = yield* ComposeRuntime;
      const { request } = yield* encodeComposition(document, yield* fonts, {});
      const core = yield* PdfCore;
      const { pages } = yield* core.inspect(pdf, { text: false, links: false });
      if (pages.length !== count)
        return yield* Effect.fail(`Expected ${count} pages, got ${pages.length}`);
      return {
        template: kind,
        pages: pages.length,
        coldMs: Math.round(cold * 10) / 10,
        warmMs: Math.round((warm[2] ?? 0) * 10) / 10,
        bytes: pdf.length,
        requestBytes: request.length,
        peakRssKiB,
      };
    }).pipe(Effect.provide(runtime)),
  );
  console.log(JSON.stringify(result));
}
