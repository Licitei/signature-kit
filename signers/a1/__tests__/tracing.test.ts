import { describe, expect, it } from "@effect/vitest";
import { signatures } from "@signature-kit/signatures";
import { parseCertificate } from "@signature-kit/certificates";
import { Effect, Exit, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { childSpans, recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";
import { a1SignaturesLayer } from "../src/signer";

const PASSWORD = Redacted.make("changeit");
const content = new TextEncoder().encode("signature-kit traced payload");

describe("A1 tracing", () => {
  it.effect("records load, key import, sign and verify spans", () =>
    Effect.gen(function* () {
      const pfx = yield* readA1Fixture("ecpf");
      const certificate = yield* parseCertificate(pfx, PASSWORD);
      yield* TestClock.setTime(certificate.validity.notBefore.getTime() + 1_000);

      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const artifact = yield* signatures.sign({ content, algorithm: "rsa-sha256" });
          return yield* signatures.verify({
            content,
            signature: artifact.signature,
            algorithm: artifact.algorithm,
          });
        }).pipe(Effect.provide(a1SignaturesLayer({ pfx, password: PASSWORD }))),
      );
      expect(Exit.isSuccess(exit)).toBe(true);

      const load = spanNamed(spans, "a1.loadCertificate");
      expect(load?.attributes["signature_kit.pkcs12.bytes"]).toBe(pfx.byteLength);
      expect(childSpans(spans, load).map((span) => span.name)).toContain(
        "certificates.parseCertificate",
      );

      const sign = spanNamed(spans, "signatures.sign");
      expect(sign?.attributes).toMatchObject({
        "signature_kit.signer.id": "a1",
        "signature_kit.signature.algorithm": "rsa-sha256",
        "signature_kit.data.bytes": content.byteLength,
      });
      const signChildren = childSpans(spans, sign).map((span) => span.name);
      expect(signChildren).toContain("a1.importKey");
      expect(signChildren).toContain("a1.sign");
      expect(spanNamed(spans, "a1.importKey")?.attributes["signature_kit.key.format"]).toBe(
        "pkcs8",
      );

      const verify = spanNamed(spans, "signatures.verify");
      expect(verify?.attributes["signature_kit.signature.valid"]).toBe(true);
      expect(childSpans(spans, verify).map((span) => span.name)).toContain("a1.verify");

      const recorded = JSON.stringify(
        spans.map((span) =>
          Object.entries(span.attributes).filter(([key]) => key !== "code.stacktrace"),
        ),
      );
      expect(recorded).not.toContain("changeit");
      expect(recorded).not.toContain("12345678901");
      expect(recorded).not.toContain(certificate.subject.commonName ?? certificate.subject.raw);
    }),
  );

  it.effect("marks a wrong A1 password as a span error", () =>
    Effect.gen(function* () {
      const pfx = yield* readA1Fixture("ecpf");
      const { exit, spans } = yield* recordSpans(
        signatures
          .inspect()
          .pipe(Effect.provide(a1SignaturesLayer({ pfx, password: Redacted.make("nope") }))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spanNamed(spans, "a1.loadCertificate")?.status.code).toBe(2);
    }),
  );
});
