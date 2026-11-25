import { Effect } from "effect";
import { largePdf, syntheticPdf } from "../../../scripts/local-first/bench-v1/corpus.ts";
import type { A1SessionBinding, PdfPrepareOptions } from "../src/protocol.js";

export const signingCorpus = [
  { name: "synthetic-1", pdf: syntheticPdf(1) },
  { name: "synthetic-20", pdf: syntheticPdf(20) },
  { name: "synthetic-200", pdf: syntheticPdf(200) },
  { name: "synthetic-21mib", pdf: largePdf },
];

export const signingOptions = (session: A1SessionBinding): PdfPrepareOptions => ({
  session,
  field: { kind: "create", name: "Approval", page: 0, rect: [32, 28, 248, 72] },
  appearance: { kind: "visible", lines: ["Signed locally"] },
  policy: "cades",
});

export const medianSigningTime = <E, R>(sample: Effect.Effect<number, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 3; i += 1) yield* sample;
    const samples = yield* Effect.forEach(Array.from({ length: 7 }), () => sample);
    return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  });
