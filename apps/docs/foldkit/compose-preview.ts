import { LocalClient, localClientLayer } from "@signature-kit/browser/client";
import { paintPage } from "@signature-kit/browser/viewer";
import {
  contractTemplate,
  evidenceReportTemplate,
  receiptTemplate,
  sampleEvidence,
} from "@signature-kit/engine/templates";
import { Effect, Schema } from "effect";
import * as Mount from "foldkit/mount";

export const ComposeTemplate = Schema.Literals(["contract", "report", "receipt"]);
export const ComposePreviewFinished = Schema.TaggedStruct("ComposePreviewFinished", {
  ok: Schema.Boolean,
});

export const previewChoices = [
  { id: "contract", pt: "Contrato", en: "Contract", pages: 2 },
  { id: "report", pt: "Relatório", en: "Report", pages: 1 },
  { id: "receipt", pt: "Recibo", en: "Receipt", pages: 1 },
] satisfies ReadonlyArray<{
  id: typeof ComposeTemplate.Type;
  pt: string;
  en: string;
  pages: number;
}>;

const templates = {
  contract: () => contractTemplate(),
  report: () => evidenceReportTemplate(sampleEvidence),
  receipt: receiptTemplate,
};

export const ComposePreviewMount = Mount.define("ComposePreviewMount", {
  messages: [ComposePreviewFinished],
  execute: ({ element }) =>
    Effect.gen(function* () {
      const client = yield* LocalClient;
      for (const { id } of previewChoices) {
        const layout = element.querySelector(`[data-compose-template="${id}"]`);
        const canvases = layout?.querySelectorAll("canvas");
        if (canvases === undefined) return ComposePreviewFinished.make({ ok: false });
        yield* Effect.acquireUseRelease(
          client.composePdf({ document: templates[id]() }),
          (revision) =>
            Effect.forEach(
              canvases,
              (canvas, pageIndex) =>
                paintPage(canvas, { handle: revision.handle, pageIndex, scale: 1.5 }),
              { discard: true },
            ),
          (revision) => client.releaseDocument(revision.handle).pipe(Effect.ignore),
        );
      }
      return ComposePreviewFinished.make({ ok: true });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        localClientLayer(
          () => new Worker(new URL("./compose-worker.ts", import.meta.url), { type: "module" }),
        ),
      ),
      Effect.orElseSucceed(() => ComposePreviewFinished.make({ ok: false })),
    ),
});
