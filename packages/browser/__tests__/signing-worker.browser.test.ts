import { Effect, Redacted, Stream } from "effect";
import { commands } from "vitest/browser";
import { expect, it } from "vitest";
import ecpfUrl from "../../../tooling/testing/fixtures/local/ecpf.p12?inline";
import { createPages } from "../../../tooling/testing/fixtures/local/pdf.js";
import { LocalClient, localClientLayer } from "../src/client.js";
import { reviewedSelection } from "./batch-page.js";

const createSigningWorker = () =>
  new Worker(new URL("../src/signing-worker.ts", import.meta.url), { type: "module" });

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

it("signs single documents and batches offline on the signing-only worker entry", async () => {
  const program = Effect.gen(function* () {
    const client = yield* LocalClient;
    const pfx = yield* Effect.promise(async () => {
      const response = await fetch(ecpfUrl);
      return new Uint8Array(await response.arrayBuffer());
    });
    yield* client.prewarm();
    yield* Effect.acquireRelease(
      Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
      () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
    );
    const session = yield* client.openA1({
      pfx: Redacted.make(pfx),
      password: Redacted.make("changeit"),
    });
    const source = yield* client.openDocument(createPages(2));
    expect(yield* Effect.flip(client.verifyPdf(source))).toMatchObject({
      code: "operationUnavailable",
    });
    expect(
      yield* Effect.flip(client.renderPage({ handle: source.handle, pageIndex: 0, scale: 1 })),
    ).toMatchObject({ code: "operationUnavailable" });
    expect((yield* client.inspectPdf(source.handle)).pageCount).toBe(2);
    const preparation = yield* client.preparePdf(source, {
      session,
      field: { kind: "create", name: "Approval", page: 0, rect: [32, 28, 192, 76] },
      appearance: { kind: "visible" },
      policy: "icpBrasilAdRbV11",
    });
    const receipt = yield* client.confirmPdf(preparation.preparationId);
    const signed = yield* client.exportDocument(receipt.signedRevision.handle);
    yield* Effect.promise(() => commands.verifyPdfIndependently(base64(signed), 1));

    const documents = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (index) =>
      client
        .openDocument(createPages(1 + (index % 2)))
        .pipe(Effect.map((revision) => ({ itemId: String(index), revision }))),
    );
    const [first, ...rest] = documents;
    if (first === undefined) return yield* Effect.die("Expected batch documents.");
    const reviewed = yield* client.prepareBatch({
      session,
      documents: [first, ...rest],
      template: {
        field: { kind: "create", name: "Batch", page: 0, rect: [32, 28, 192, 76] },
        appearance: { kind: "visible" },
        policy: "cades",
      },
    });
    expect(reviewed.signingWorkers).toBeGreaterThan(0);
    yield* client.confirmBatch(reviewed.batchId, yield* reviewedSelection(reviewed.items));
    yield* client.batchEvents(reviewed.batchId).pipe(Stream.runDrain);
    const completed = yield* client.batchSnapshot(reviewed.batchId);
    expect(completed.progress.signed).toBe(6);
    const batchReceipt = completed.items[0]?.receipt;
    if (batchReceipt === undefined) return yield* Effect.die("Expected a batch receipt.");
    const batchSigned = yield* client.exportDocument(batchReceipt.signedRevision.handle);
    yield* Effect.promise(() => commands.verifyPdfIndependently(base64(batchSigned), 1));
    yield* client.releaseBatch(reviewed.batchId);
  });
  await Effect.runPromise(
    Effect.scoped(program).pipe(Effect.provide(localClientLayer(createSigningWorker))),
  );
}, 120_000);
