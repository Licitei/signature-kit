import { signPdf } from "../../formats/pdf/dist/sign.js";
import { pdfCoreLayer } from "../../shared/pdf-core/dist/pdf-core.js";
import { a1SignaturesLayer } from "../../signers/a1/dist/signer.js";
import { Effect, Redacted } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { readA1Fixture } from "../../tooling/testing/fixtures.ts";
import { marker, pdfObjects } from "../../runtime/local/__tests__/fixtures/pdf.ts";

const appearance = "0 0 1 rg 0 0 60 35 re f";
const source = pdfObjects([
  "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 160] /Annots [4 0 R] /Resources << >> >>",
  `<< /Type /Annot /Subtype /Widget /FT /Sig /T (ViewerSignature) /F 4 /P 3 0 R /Rect [${marker.join(" ")}] /AP << /N 5 0 R >> >>`,
  `<< /Type /XObject /Subtype /Form /BBox [0 0 60 35] /Resources << >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
]);

const wasm = await readFile(new URL("../../shared/pdf-core/dist/pdf-core.wasm", import.meta.url));
const module = await WebAssembly.compile(wasm);

await Effect.runPromise(
  Effect.gen(function* () {
    const pfx = yield* readA1Fixture("ecpf");
    const signed = yield* signPdf({
      pdf: source,
      signingTime: new Date("2026-01-02T00:04:05Z"),
      appearance: { placement: { kind: "auto", width: 60, height: 35 } },
      signatureLength: 4096,
    }).pipe(Effect.provide(a1SignaturesLayer({ pfx, password: Redacted.make("changeit") })));
    yield* Effect.promise(() =>
      writeFile(
        new URL("../../runtime/local/__tests__/fixtures/visible-signature.pdf", import.meta.url),
        signed,
      ),
    );
  }).pipe(Effect.provide(pdfCoreLayer(module))),
);
