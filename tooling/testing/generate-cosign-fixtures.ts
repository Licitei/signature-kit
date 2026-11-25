import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  A1Sessions,
  Documents,
  localRuntimeLayer,
  pdfEngineLayer,
} from "../../packages/engine/dist/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../../packages/engine/dist/pdf-signatures.js";
import { exportComparisonReport } from "../../packages/engine/dist/rpc.js";
import type { RevisionRef } from "../../packages/engine/dist/rpc.js";
import { pdfCoreFileLayer } from "../../packages/engine/dist/wasm/file.js";
import { PdfCore } from "../../packages/engine/dist/wasm/pdf-core.js";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existingField, signatories, trustAt } from "./cosign.js";

const folder = process.argv[2];
if (folder === undefined) process.exit(2);

const read = (file: string) =>
  Effect.promise(async () => new Uint8Array(await readFile(join(folder, file))));
const write = (file: string, bytes: Uint8Array | string) =>
  Effect.promise(() => writeFile(join(folder, file), bytes));

const generate = Effect.gen(function* () {
  yield* TestClock.setTime(trustAt.getTime());
  const core = yield* PdfCore;
  const documents = yield* Documents;
  const a1 = yield* A1Sessions;
  const pdf = yield* PdfSignatures;
  const create = (width: number) =>
    Effect.gen(function* () {
      const blank = yield* core.create({ pages: [{ width, height: 180 }] });
      const { nextObjectNumber } = yield* core.document(blank);
      const font = { number: nextObjectNumber, generation: 0 };
      return yield* core.edit(
        blank,
        [
          { op: "standardFont", ref: font, baseFont: "Helvetica" },
          {
            op: "addResource",
            pageIndex: 0,
            category: "Font",
            name: "F1",
            value: `${font.number} 0 R`,
          },
          {
            op: "appendContent",
            pageIndex: 0,
            ref: { number: nextObjectNumber + 1, generation: 0 },
            data: new TextEncoder().encode(
              "BT /F1 14 Tf 32 118 Td (Synthetic signing contract) Tj ET",
            ),
            compress: true,
          },
        ],
        { mode: "rewrite" },
      );
    });
  const sign = (source: RevisionRef, certificate: "ecpf" | "ecnpj", name: string) =>
    Effect.gen(function* () {
      const session = yield* a1.open({
        pfx: Redacted.make(yield* read(`${certificate}.p12`)),
        password: Redacted.make("changeit"),
      });
      const prepared = yield* pdf.prepare(source, existingField(session, name));
      return (yield* pdf.confirm(prepared.preparationId)).signedRevision;
    });

  const blank = yield* create(320);
  yield* write("contract.pdf", blank);
  const sent = yield* pdf.addFields(yield* documents.open(blank), signatories);
  yield* write("sent.pdf", yield* documents.export(sent.handle));
  const first = yield* sign(sent, "ecpf", signatories[0].name);
  const returned = yield* sign(first, "ecnpj", signatories[1].name);
  const signed = yield* documents.export(returned.handle);
  yield* write("cosigned.pdf", signed);
  const report = yield* pdf.compare(sent, returned, {
    trust: [yield* read("root.der")],
    at: trustAt,
  });
  yield* write("report.json", `${yield* exportComparisonReport(report)}\n`);

  const other = yield* pdf.addFields(yield* documents.open(yield* create(340)), signatories);
  const different = yield* sign(other, "ecpf", signatories[0].name);
  yield* write("different.pdf", yield* documents.export(different.handle));
  const { nextObjectNumber } = yield* core.document(signed);
  const ref = { number: nextObjectNumber, generation: 0 };
  yield* write(
    "page-changed.pdf",
    yield* core.edit(
      signed,
      [
        {
          op: "appendContent",
          pageIndex: 0,
          ref,
          data: new TextEncoder().encode("0 g 32 140 220 20 re f"),
          compress: false,
        },
      ],
      { mode: "incremental" },
    ),
  );
  yield* write(
    "unknown.pdf",
    yield* core.edit(
      signed,
      [{ op: "setObject", ref, value: "<< /Type /SyntheticUnknown /Test true >>" }],
      { mode: "incremental" },
    ),
  );
  const fields = yield* pdf.fields(returned);
  const range = fields.fields.at(-1)?.signature?.byteRange;
  if (range === undefined) return yield* Effect.die("Signature ByteRange missing from fixture.");
  const corrupted = signed.slice();
  corrupted[range[2] - 2] = 0x46;
  yield* write("integrity-failure.pdf", corrupted);
});

await Effect.runPromise(
  generate.pipe(
    Effect.provide(
      pdfSignaturesLayer.pipe(
        Layer.provideMerge(pdfEngineLayer),
        Layer.provideMerge(localRuntimeLayer()),
        Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
        Layer.provideMerge(TestClock.layer()),
      ),
    ),
  ),
);
