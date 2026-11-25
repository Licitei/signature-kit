import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { Effect } from "effect";
import { Document, Page, Text } from "@signature-kit/engine/compose";
import type { ComposeDocument } from "@signature-kit/engine/compose";
import {
  contractTemplate,
  evidenceReportTemplate,
  receiptTemplate,
  sampleEvidence,
} from "@signature-kit/engine/templates";
import { LocalClient, localClientLayer } from "../src/client.js";
import { paintPage } from "../src/viewer.js";

const worker = () => new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });
const references = [
  [
    contractTemplate(),
    [
      new URL("../../engine/__tests__/compose/__snapshots__/contract-1.png", import.meta.url),
      new URL("../../engine/__tests__/compose/__snapshots__/contract-2.png", import.meta.url),
    ],
  ],
  [
    evidenceReportTemplate(sampleEvidence),
    [new URL("../../engine/__tests__/compose/__snapshots__/report-1.png", import.meta.url)],
  ],
  [
    receiptTemplate(),
    [new URL("../../engine/__tests__/compose/__snapshots__/receipt-1.png", import.meta.url)],
  ],
] satisfies ReadonlyArray<readonly [ComposeDocument, readonly URL[]]>;

function difference(reference: ImageData, rendered: ImageData) {
  const { width, height, data: expected } = reference;
  const { data: actual } = rendered;
  const stride = width * 4;
  let differences = 0;
  let ink = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = y * stride + x * 4;
      const left = expected[offset] ?? 255;
      const right = actual[offset] ?? 255;
      if (Math.min(left, right) >= 240) continue;
      ink++;
      const value = (data: Uint8ClampedArray<ArrayBuffer>) =>
        ((data[offset - stride] ?? 255) +
          (data[offset + stride] ?? 255) +
          (data[offset - 4] ?? 255) +
          (data[offset + 4] ?? 255) +
          2 * (data[offset] ?? 255)) /
        6;
      if (Math.abs(value(expected) - value(actual)) > 48) differences++;
    }
  }
  expect(ink).toBeGreaterThan(10000);
  return differences / ink;
}

it("registers revisions offline and matches the Poppler rasters", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const snapshots = yield* Effect.forEach(references, ([document, urls]) =>
        Effect.forEach(urls, (url) =>
          Effect.acquireRelease(
            Effect.promise(async () => ({
              image: await createImageBitmap(await (await fetch(url)).blob()),
              url,
            })),
            ({ image }) => Effect.sync(() => image.close()),
          ),
        ).pipe(Effect.map((pages) => ({ document, pages }))),
      );
      const client = yield* LocalClient;
      const warmup = yield* client.composePdf({ document: Document(Page([Text("Prévia")])) });
      yield* client.releaseDocument(warmup.handle);
      yield* Effect.acquireRelease(
        Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
        () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
      );

      for (const { document, pages } of snapshots) {
        const revision = yield* client.composePdf({ document });
        expect((yield* client.inspectPdf(revision.handle)).pageCount).toBe(pages.length);
        for (const [pageIndex, { image, url }] of pages.entries()) {
          const canvas = new OffscreenCanvas(1, 1);
          const actualDimensions = yield* paintPage(canvas, {
            handle: revision.handle,
            pageIndex,
            scale: 110 / 72,
          });
          expect(Math.abs(actualDimensions.width - image.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(actualDimensions.height - image.height)).toBeLessThanOrEqual(1);
          const expectedCanvas = new OffscreenCanvas(canvas.width, canvas.height);
          const expectedContext = expectedCanvas.getContext("2d");
          const actualContext = canvas.getContext("2d");
          if (expectedContext === null || actualContext === null)
            return expect.fail("No 2D context");
          expectedContext.fillStyle = "#fff";
          expectedContext.fillRect(0, 0, canvas.width, canvas.height);
          expectedContext.drawImage(image, 0, 0);
          const distance = difference(
            expectedContext.getImageData(0, 0, canvas.width, canvas.height),
            actualContext.getImageData(0, 0, canvas.width, canvas.height),
          );
          console.info(`${url.pathname.split("/").at(-1)}: ${(distance * 100).toFixed(2)}%`);
          expect(distance, url.pathname).toBeLessThan(0.22);
        }
        yield* client.releaseDocument(revision.handle);
      }
    }).pipe(Effect.scoped, Effect.provide(localClientLayer(worker))),
  );
}, 15000);
