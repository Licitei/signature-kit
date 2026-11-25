import { renderDisplayListImage } from "@signature-kit/pdf-core/canvas";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Duration, Effect, Option } from "effect";
import { PdfCoreWorkerRequests } from "./tool-rpc.js";

export const pdfCoreWorkerHandlersLayer = PdfCoreWorkerRequests.toLayer(
  Effect.gen(function* () {
    const core = yield* PdfCore;
    return PdfCoreWorkerRequests.of({
      ExtractPdf: Effect.fn(function* ({ pdf }) {
        const [extractTime, pages] = yield* Effect.timed(core.text(pdf));
        const rendered = yield* Effect.timed(
          Effect.gen(function* () {
            const lists = yield* core.renderPages(pdf, { pageIndexes: [0], scale: 1 });
            const list = lists[0];
            if (list === undefined) return Option.none<Uint8Array>();
            const page = yield* renderDisplayListImage(list, { type: "image/jpeg", quality: 0.85 });
            const bytes = yield* Effect.promise(() => page.image.arrayBuffer());
            return Option.some(new Uint8Array(bytes));
          }),
        ).pipe(Effect.option);
        const image = Option.flatMap(rendered, ([, bytes]) => bytes);
        return {
          pageCount: pages.length,
          characters: pages.reduce((total, page) => total + page.length, 0),
          extractMillis: Duration.toMillis(extractTime),
          renderMillis: Option.isSome(image)
            ? Option.getOrNull(Option.map(rendered, ([time]) => Duration.toMillis(time)))
            : null,
          firstPage: (pages[0] ?? "").slice(0, 6000),
          image: Option.getOrNull(image),
        };
      }),
    });
  }),
);
