import { Effect } from "effect";
import { getDocument, PDFWorker } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import standardFontUrl from "pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { LocalClient, localClientLayer } from "../src/client.js";
import { canvasToPdfRect, paintPage, pdfToCanvasRect } from "../src/viewer.js";
import { createPages, marker } from "../../../tooling/testing/fixtures/local/pdf.js";
import signedUrl from "../../../tooling/testing/fixtures/local/visible-signature.pdf?url";

const createWorker = () =>
  new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });
const fixtures = import.meta.glob<string>(
  [
    "../../../crates/pdf/tests/fixtures/pdf/render/{embedded-fonts,images,masks,rotated}.pdf",
    "../../../crates/pdf/tests/fixtures/pdf/habilitacao-150.pdf",
  ],
  { query: "?url", import: "default", eager: true },
);
const fixture = (name: string) => {
  const url = Object.entries(fixtures).find(([path]) => path.endsWith(`/${name}.pdf`))?.[1];
  return fetchBytes(url ?? expect.fail(`Missing PDF fixture ${name}`));
};
const fetchBytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

const pixels = (canvas: HTMLCanvasElement) =>
  canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height) ??
  expect.fail("Missing 2D canvas context");

const renderOracle = async (
  document: PDFDocumentProxy,
  index: number,
  scale: number,
  rotation: number,
) => {
  const page = await document.getPage(index + 1);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return { pixels: pixels(canvas), viewport };
};

const parity = (actual: ImageData, expected: ImageData) => {
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);
  let ink = 0;
  let divergent = 0;
  for (let at = 0; at < actual.data.length; at += 4) {
    const left = [actual.data[at] ?? 255, actual.data[at + 1] ?? 255, actual.data[at + 2] ?? 255];
    const right = [
      expected.data[at] ?? 255,
      expected.data[at + 1] ?? 255,
      expected.data[at + 2] ?? 255,
    ];
    if (Math.min(...left, ...right) >= 245) continue;
    ink += 1;
    if (left.some((channel, index) => Math.abs(channel - (right[index] ?? 255)) > 64)) {
      divergent += 1;
    }
  }
  expect(ink).toBeGreaterThan(0);
  return divergent / ink;
};

const pixelAt = (image: ImageData, x: number, y: number) => {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
};

const offline = Effect.acquireRelease(
  Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
  () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
);

it("matches the pdf.js oracle at two zooms while the local viewer is offline", async () => {
  const sources = [
    ...(await Promise.all(
      ["embedded-fonts", "images", "masks", "rotated"].map(async (name) => ({
        name,
        bytes: await fixture(name),
        mark: false,
      })),
    )),
    { name: "visible-signature", bytes: await fetchBytes(signedUrl), mark: true },
    { name: "cropped-rotated-marker", bytes: createPages(1), mark: true },
  ];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Worker(
                new URL("../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
                { type: "module" },
              ),
          ),
          (worker) => Effect.sync(() => worker.terminate()),
        );
        const oracleWorker = yield* Effect.acquireRelease(
          Effect.sync(() => PDFWorker.create({ port: worker })),
          (worker) => Effect.sync(() => worker.destroy()),
        );
        const references = yield* Effect.forEach(sources, ({ bytes }) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              getDocument({
                data: bytes.slice(),
                disableFontFace: true,
                standardFontDataUrl: new URL(".", new URL(standardFontUrl, location.href)).href,
                worker: oracleWorker,
              }),
            ),
            (task) => Effect.promise(() => task.destroy()),
          ).pipe(
            Effect.flatMap((task) =>
              Effect.promise(async () => {
                const reference = await task.promise;
                const pages = Array.from({ length: reference.numPages }, (_, index) => index);
                return Promise.all(
                  pages.map(async (pageIndex) => ({
                    normal: await renderOracle(reference, pageIndex, 1, 0),
                    zoomed: await renderOracle(reference, pageIndex, 2, 90),
                  })),
                );
              }),
            ),
          ),
        );

        yield* Effect.acquireRelease(
          Effect.promise(() => commands.trackLocalRuntimeRequests("start")),
          () => Effect.promise(() => commands.trackLocalRuntimeRequests("stop")),
        );
        yield* Effect.gen(function* () {
          const client = yield* LocalClient;
          yield* client.prewarm();
          const start = yield* Effect.promise(() => commands.trackLocalRuntimeRequests("read"));
          expect(start.some((url) => new URL(url).pathname.endsWith("/signature-kit.wasm"))).toBe(
            true,
          );
          yield* offline;
          const blocked = yield* Effect.promise(() =>
            fetch("/__offline_viewer_probe").then(
              () => false,
              () => true,
            ),
          );
          expect(blocked).toBe(true);

          const canvas = document.createElement("canvas");
          for (const [index, source] of sources.entries()) {
            const reference = references[index] ?? expect.fail("Missing pdf.js reference");
            const { handle } = yield* client.openDocument(source.bytes);
            const inspection = yield* client.inspectPdf(handle);
            expect(inspection.pageCount).toBe(reference.length);
            for (const scale of [1, 2]) {
              const rotation = scale === 1 ? 0 : 90;
              for (let pageIndex = 0; pageIndex < inspection.pageCount; pageIndex += 1) {
                const viewport = yield* paintPage(canvas, { handle, pageIndex, scale, rotation });
                const actual = pixels(canvas);
                const expectedPage = reference[pageIndex] ?? expect.fail("Missing oracle page");
                const expected = scale === 1 ? expectedPage.normal : expectedPage.zoomed;
                const score = parity(actual, expected.pixels);
                const label = `${source.name} page ${pageIndex + 1} at ${scale}x +${rotation}°`;
                console.info(`${label}: ${(score * 100).toFixed(3)}% divergent ink pixels`);
                expect.soft(score, label).toBeLessThan(0.05);

                if (source.mark) {
                  const rect = pdfToCanvasRect(viewport, marker);
                  const oracleMatrix = new DOMMatrixReadOnly(expected.viewport.transform);
                  const first = oracleMatrix.transformPoint({ x: marker[0], y: marker[1] });
                  const last = oracleMatrix.transformPoint({ x: marker[2], y: marker[3] });
                  expect(rect).toEqual([
                    Math.min(first.x, last.x),
                    Math.min(first.y, last.y),
                    Math.max(first.x, last.x),
                    Math.max(first.y, last.y),
                  ]);
                  expect(canvasToPdfRect(viewport, rect)).toEqual(marker);
                  const x = (rect[0] + rect[2]) / 2;
                  const y = (rect[1] + rect[3]) / 2;
                  expect(pixelAt(actual, x, y)).toEqual([0, 0, 255, 255]);
                  expect(pixelAt(expected.pixels, x, y)).toEqual([0, 0, 255, 255]);
                }
              }
            }
            if (source.name === "cropped-rotated-marker") {
              expect(
                yield* Effect.flip(client.renderPage({ handle, pageIndex: 0, scale: 64 })),
              ).toMatchObject({ code: "renderTooLarge" });
            }
            yield* client.releaseDocument(handle);
            expect(yield* Effect.flip(client.inspectPdf(handle))).toMatchObject({
              code: "unknownHandle",
            });
          }
          const urls = yield* Effect.promise(() => commands.trackLocalRuntimeRequests("read"));
          expect(urls.filter((url) => new URL(url).origin !== location.origin)).toEqual([]);
          expect(urls.slice(start.length).map((url) => new URL(url).pathname)).toEqual([
            "/__offline_viewer_probe",
          ]);
        }).pipe(Effect.provide(localClientLayer(createWorker)), Effect.scoped);
      }),
    ),
  );
}, 60_000);

it("measures cold and warm renders on small, medium, and large PDFs", async () => {
  const sources = [
    { name: "generated-1", bytes: createPages(1), pages: 1 },
    { name: "generated-20", bytes: createPages(20), pages: 20 },
    { name: "generated-200", bytes: createPages(200), pages: 200 },
    { name: "habilitacao-150", bytes: await fixture("habilitacao-150"), pages: 150 },
  ];
  for (const { name, bytes, pages } of sources) {
    const started = performance.now();
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* LocalClient;
        const readyMs = performance.now() - started;
        const { handle } = yield* client.openDocument(bytes);
        const first = yield* client.renderPage({ handle, pageIndex: 0, scale: 0.5 });
        const firstMs = performance.now() - started;
        expect(first.pixels.byteLength).toBe(first.width * first.height * 4);
        expect((yield* client.inspectPdf(handle)).pageCount).toBe(pages);

        const timings = yield* Effect.forEach(
          Array.from({ length: Math.max(10, pages - 1) }, (_, index) => (index + 1) % pages),
          (pageIndex) =>
            Effect.gen(function* () {
              const start = performance.now();
              const page = yield* client.renderPage({ handle, pageIndex, scale: 0.5 });
              const elapsed = performance.now() - start;
              expect(page.pixels.byteLength).toBe(page.width * page.height * 4);
              return elapsed;
            }),
        );
        yield* client.releaseDocument(handle);
        const sorted = timings.sort((left, right) => left - right);
        console.info({
          name,
          pages,
          readyMs,
          firstMs,
          warmSamples: sorted.length,
          warmMeanMs: sorted.reduce((total, sample) => total + sample, 0) / sorted.length,
          warmP50Ms: sorted[Math.floor(sorted.length * 0.5)],
          warmP95Ms: sorted[Math.floor(sorted.length * 0.95)],
        });
      }).pipe(Effect.provide(localClientLayer(createWorker))),
    );
  }
}, 120_000);
