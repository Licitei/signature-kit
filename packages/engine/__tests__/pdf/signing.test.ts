import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import type { PdfCorePrepareSignatureRequest, PdfCorePreparedSignature } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const request = (name: string): PdfCorePrepareSignatureRequest => ({
  field: { kind: "create", name, page: 0, rect: [32, 28, 248, 72] },
  appearance: {
    kind: "visible",
    lines: [
      {
        text: "Assinado (José)",
        font: "Helvetica-Bold",
        position: [8, 19],
        size: 11,
        color: [0.1, 0.2, 0.3],
      },
      { text: "Local", font: "Helvetica", position: [8, 8], size: 8, color: [0.3] },
    ],
    border: { width: 1, color: [0.4] },
    image: {
      png: Uint8Array.fromBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPjfAAACgwGALqKZRAAAAABJRU5ErkJggg==",
      ),
      rect: [170, 4, 206, 40],
    },
  },
  contentsCapacity: 4096,
  date: "D:20261125135500Z",
  subFilter: "adbe.pkcs7.detached",
  reason: "Consentimento",
  location: "São Paulo",
  contactInfo: "test@example.com",
  sha512: true,
});

const verifyDigest = (prepared: PdfCorePreparedSignature) => {
  const [first, firstLength, second, secondLength] = prepared.byteRange;
  const content = Buffer.concat([
    prepared.pdf.subarray(first, first + firstLength),
    prepared.pdf.subarray(second, second + secondLength),
  ]);
  expect(prepared.contentsStart).toBe(first + firstLength + 1);
  expect(prepared.contentsEnd).toBe(second - 1);
  expect(prepared.pdf[prepared.contentsStart - 1]).toBe(0x3c);
  expect(prepared.pdf[prepared.contentsEnd]).toBe(0x3e);
  expect(second + secondLength).toBe(prepared.pdf.byteLength);
  expect(Buffer.from(prepared.sha256)).toEqual(createHash("sha256").update(content).digest());
  expect(Buffer.from(prepared.sha512 ?? [])).toEqual(createHash("sha512").update(content).digest());
  return content;
};

it.effect("reports fields, FieldMDP, DocMDP, ranges and signing-only revision changes", () =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const input = yield* core.create({ pages: [{ width: 300, height: 200 }] });
    const prepared = yield* core.prepareSignature(input, {
      ...request("Certificação"),
      docMdp: 1,
      lock: { action: "Include", fields: ["Group.Child"] },
    });
    verifyDigest(prepared);
    expect(prepared.pdf.subarray(0, input.byteLength)).toEqual(input);
    const report = yield* core.signatureFields(prepared.pdf);
    expect(report).toMatchObject({
      revisions: [input.byteLength, prepared.pdf.byteLength],
      docMdp: 1,
      fields: [
        {
          name: "Certificação",
          signed: true,
          lock: { action: "Include", fields: ["Group.Child"] },
          widgets: [{ page: 0, rect: [32, 28, 248, 72] }],
          signature: {
            byteRange: prepared.byteRange,
            revisionEnd: prepared.pdf.byteLength,
            subFilter: "adbe.pkcs7.detached",
          },
        },
      ],
    });
    const changes = yield* core.revisionChanges(prepared.pdf, input.byteLength);
    expect(changes.pageContentChanged).toBe(false);
    expect(new Set(changes.changes.map(({ kind }) => kind))).toEqual(
      new Set(["acroForm", "signatureField", "signature", "widgetAppearance"]),
    );
    const rejected = yield* Effect.result(core.prepareSignature(prepared.pdf, request("Another")));
    expect(Result.isFailure(rejected) && rejected.failure).toMatchObject({
      code: PdfCoreErrorCodeValue.invalidOptions,
      reason: "DocMDP forbids signing this document",
    });
    const malformed = yield* Effect.result(
      core.prepareSignature(input, { ...request("Invalid"), contentsCapacity: -1 }),
    );
    expect(Result.isFailure(malformed) && malformed.failure).toMatchObject({
      code: PdfCoreErrorCodeValue.invalidOptions,
      schemaName: "PdfCorePrepareSignatureRequest",
    });
  }).pipe(Effect.provide(layer)),
);

const unavailable = ["qpdf", "pdfsig", "openssl"].filter(
  (tool) =>
    spawnSync(tool, [tool === "pdfsig" ? "-v" : tool === "openssl" ? "version" : "--version"])
      .status !== 0,
);

const command = (tool: string, args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const result = spawnSync(tool, args, { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  });

const sign = (directory: string, stem: string, prepared: PdfCorePreparedSignature) =>
  Effect.gen(function* () {
    const content = verifyDigest(prepared);
    const preparedPath = join(directory, `${stem}-prepared.pdf`);
    const signedPath = join(directory, `${stem}-signed.pdf`);
    const contentPath = join(directory, `${stem}.bin`);
    const cmsPath = join(directory, `${stem}.cms`);
    yield* Effect.promise(() => writeFile(preparedPath, prepared.pdf));
    yield* command("qpdf", ["--check", preparedPath]);
    yield* Effect.promise(() => writeFile(contentPath, content));
    yield* command("openssl", [
      "cms",
      "-sign",
      "-binary",
      "-outform",
      "DER",
      "-nosmimecap",
      "-noattr",
      "-md",
      "sha256",
      "-signer",
      join(directory, "cert.pem"),
      "-inkey",
      join(directory, "key.pem"),
      "-in",
      contentPath,
      "-out",
      cmsPath,
    ]);
    const cms = yield* Effect.promise(() => readFile(cmsPath));
    const hex = Buffer.from(cms.toString("hex"), "ascii");
    expect(hex.byteLength).toBeLessThanOrEqual(prepared.contentsEnd - prepared.contentsStart);
    const signed = prepared.pdf.slice();
    signed.set(hex, prepared.contentsStart);
    yield* Effect.promise(() => writeFile(signedPath, signed));
    yield* command("qpdf", ["--check", signedPath]);
    const verification = yield* command("pdfsig", ["-nocert", signedPath]);
    return { signed, verification };
  });

it.effect.skipIf(unavailable.length > 0)(
  unavailable.length === 0
    ? "writes two detached CMS signatures independently accepted by qpdf and Poppler"
    : `writes two detached CMS signatures (skipped: missing ${unavailable.join(", ")})`,
  () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "pdf-core-signing-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      yield* command("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-days",
        "1",
        "-subj",
        "/CN=PDF Core Test",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ]);
      const input = yield* core.create({ pages: [{ width: 300, height: 200 }] });
      const first = yield* core.prepareSignature(input, request("First"));
      const signed = yield* sign(directory, "first", first);
      expect(signed.verification).toContain("Signature Field Name: First");
      expect(signed.verification.match(/Signature is Valid/g)).toHaveLength(1);

      const second = yield* core.prepareSignature(signed.signed, {
        ...request("Second"),
        field: { kind: "create", name: "Second", page: 0, rect: [0, 0, 0, 0] },
        appearance: { kind: "none" },
      });
      expect(second.pdf.subarray(0, signed.signed.byteLength)).toEqual(signed.signed);
      const coSigned = yield* sign(directory, "second", second);
      expect(coSigned.verification).toContain("Signature Field Name: First");
      expect(coSigned.verification).toContain("Signature Field Name: Second");
      expect(coSigned.verification.match(/Signature is Valid/g)).toHaveLength(2);
      const report = yield* core.signatureFields(coSigned.signed);
      expect(report.fields.find(({ name }) => name === "First")?.signature).toMatchObject({
        byteRange: first.byteRange,
        revisionEnd: signed.signed.byteLength,
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
