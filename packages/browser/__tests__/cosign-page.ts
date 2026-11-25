import { exportComparisonReport } from "@signature-kit/engine/rpc";
import { Effect, Redacted, Result } from "effect";
import * as Base64 from "effect/encoding/Base64";
import { existingField, signatories, trustAt } from "../../../tooling/testing/cosign.js";
import { LocalClient, localClientLayer } from "../src/client.js";
import { paintPage, pdfToCanvasRect } from "../src/viewer.js";

const layer = localClientLayer(
  () => new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" }),
);
const bytes = (file: string) => new Uint8Array(Result.getOrThrow(Base64.decode(file)));

export const firstSignatory = (contract: string, certificate: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const isolated = localStorage.getItem("signatory") === null;
      localStorage.setItem("signatory", "first");
      const draft = yield* client.openDocument(bytes(contract));
      const sent = yield* client.addPdfSignatureFields(draft, signatories);
      const fields = yield* client.pdfSignatureFields(sent);
      const session = yield* client.openA1({
        pfx: Redacted.make(bytes(certificate)),
        password: Redacted.make("changeit"),
      });
      const prepared = yield* client.preparePdf(sent, existingField(session, signatories[0].name));
      if (prepared.widget.kind !== "visible")
        return yield* Effect.die("Expected a visible widget.");
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const viewport = yield* paintPage(canvas, {
        handle: prepared.previewRevision.handle,
        pageIndex: prepared.widget.page,
        scale: 2,
      });
      const [left, top, right, bottom] = pdfToCanvasRect(viewport, prepared.widget.rect);
      const region = canvas.getContext("2d")?.getImageData(left, top, right - left, bottom - top);
      const ink = region?.data.some((channel, index) => index % 4 !== 3 && channel < 100);
      const receipt = yield* client.confirmPdf(prepared.preparationId);
      return {
        instanceId: client.instanceId,
        isolated,
        fields,
        widget: prepared.widget,
        ink,
        sent: Base64.encode(yield* client.exportDocument(sent.handle)),
        signed: Base64.encode(yield* client.exportDocument(receipt.signedRevision.handle)),
      };
    }).pipe(Effect.provide(layer)),
  );

export const secondSignatory = (signed: string, certificate: string, root: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const isolated = localStorage.getItem("signatory") === null;
      localStorage.setItem("signatory", "second");
      const source = yield* client.openDocument(bytes(signed));
      const previous = yield* client.verifyPdf(source, { trust: [bytes(root)], at: trustAt });
      const session = yield* client.openA1({
        pfx: Redacted.make(bytes(certificate)),
        password: Redacted.make("changeit"),
      });
      const prepared = yield* client.preparePdf(
        source,
        existingField(session, signatories[1].name),
      );
      const receipt = yield* client.confirmPdf(prepared.preparationId);
      return {
        instanceId: client.instanceId,
        isolated,
        previous,
        signed: Base64.encode(yield* client.exportDocument(receipt.signedRevision.handle)),
      };
    }).pipe(Effect.provide(layer)),
  );

export const compareFiles = (sent: string, returned: string, root: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const isolated = localStorage.getItem("signatory") === null;
      const original = yield* client.openDocument(bytes(sent));
      const response = yield* client.openDocument(bytes(returned));
      const report = yield* client.comparePdf(original, response, {
        trust: [bytes(root)],
        at: trustAt,
      });
      return {
        instanceId: client.instanceId,
        isolated,
        report: yield* exportComparisonReport(report),
      };
    }).pipe(Effect.provide(layer)),
  );
