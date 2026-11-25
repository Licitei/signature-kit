import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Effect, Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import { A1Sessions, Documents, LocalRuntime, localRuntimeLayer } from "./engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "./pdf-signatures.js";
import { LocalError, LocalRpcs, PROTOCOL_VERSION } from "./protocol.js";

const localHandlersLayer = LocalRpcs.toLayer(
  Effect.gen(function* () {
    const { instanceId } = yield* LocalRuntime;
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const pdf = yield* PdfSignatures;
    return LocalRpcs.of({
      Hello: Effect.fn("local.hello")(function* ({ version }) {
        if (version !== PROTOCOL_VERSION)
          return yield* new LocalError({ code: "protocolMismatch" });
        return { instanceId, version: PROTOCOL_VERSION };
      }),
      DocumentsOpen: ({ bytes }) => documents.open(bytes),
      DocumentsExport: ({ handle }) => documents.export(handle),
      DocumentsRelease: ({ handle }) => documents.release(handle),
      A1Open: a1.open,
      A1Close: a1.close,
      PdfSignatureFields: ({ revision }) => pdf.fields(revision),
      PdfPrepare: ({ revision, options }) => pdf.prepare(revision, options),
      PdfConfirm: ({ preparationId }) => pdf.confirm(preparationId),
      PdfRelease: ({ preparationId }) => pdf.release(preparationId),
      PdfVerify: ({ revision, options }) => pdf.verify(revision, options),
    });
  }),
);

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(LocalRpcs, { spanPrefix: "local.worker" }).pipe(
      Layer.provide(
        localHandlersLayer.pipe(
          Layer.provide(pdfSignaturesLayer),
          Layer.provide(localRuntimeLayer()),
          Layer.provide(pdfCoreBrowserLayer),
        ),
      ),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
