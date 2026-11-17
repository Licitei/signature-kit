import { Effect } from "effect";

import { pdfCoreBrowserModule } from "./browser.js";
import type { PdfCoreError } from "./config.js";
import { makePdfCore } from "./pdf-core.js";
import type { PdfCoreService } from "./pdf-core.js";

export type PdfCoreClient = {
  readonly [Name in keyof PdfCoreService]: (
    ...args: Parameters<PdfCoreService[Name]>
  ) => Promise<Effect.Success<ReturnType<PdfCoreService[Name]>>>;
};

const run = <A>(effect: Effect.Effect<A, PdfCoreError>): Promise<A> =>
  // effect-boundary: promise entry point for apps without Effect [allow-run: rejects with the PdfCoreError]
  Effect.runPromise(effect);

const toClient = (core: PdfCoreService): PdfCoreClient => ({
  inspect: (...args) => run(core.inspect(...args)),
  text: (...args) => run(core.text(...args)),
  tables: (...args) => run(core.tables(...args)),
  signatures: (...args) => run(core.signatures(...args)),
  revisionComplete: (...args) => run(core.revisionComplete(...args)),
  document: (...args) => run(core.document(...args)),
  edit: (...args) => run(core.edit(...args)),
  merge: (...args) => run(core.merge(...args)),
  deflate: (...args) => run(core.deflate(...args)),
  create: (...args) => run(core.create(...args)),
  fontMetrics: (...args) => run(core.fontMetrics(...args)),
  pngSize: (...args) => run(core.pngSize(...args)),
  renderPages: (...args) => run(core.renderPages(...args)),
});

export const createPdfCoreClient = (module: WebAssembly.Module): Promise<PdfCoreClient> =>
  run(makePdfCore(module).pipe(Effect.map(toClient)));

export const loadPdfCoreBrowser = (): Promise<PdfCoreClient> =>
  run(pdfCoreBrowserModule.pipe(Effect.flatMap(makePdfCore), Effect.map(toClient)));
