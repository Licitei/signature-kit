import { readFile } from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";

import { parseCertificate } from "../../src/certificates/certificate";
import { childSpans, recordSpans, spanNamed } from "../../../../tooling/testing/tracing.ts";

const readFixture = (name: string): Effect.Effect<Uint8Array> =>
  Effect.promise(
    async () => new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url))),
  );

const stringValues = (spans: ReadonlyArray<{ readonly attributes: object }>): string =>
  JSON.stringify(
    spans.map((span) =>
      Object.entries(span.attributes).filter(([key]) => key !== "code.stacktrace"),
    ),
  );

describe("certificate tracing", () => {
  it.effect("records PKCS#12 and X.509 parse spans without certificate material", () =>
    Effect.gen(function* () {
      const pfx = yield* readFixture("lacuna-turing.pfx");
      const { exit, spans } = yield* recordSpans(parseCertificate(pfx, Redacted.make("1234")));
      expect(Exit.isSuccess(exit)).toBe(true);

      const parse = spanNamed(spans, "certificates.parseCertificate");
      expect(parse?.attributes).toMatchObject({
        "signature_kit.pkcs12.bytes": pfx.byteLength,
        "signature_kit.certificate.validity_status": expect.any(String),
      });
      expect(parse?.attributes["signature_kit.certificate_count"]).toBeGreaterThan(0);
      const children = childSpans(spans, parse).map((span) => span.name);
      expect(children).toContain("crypto.pkcs12.parse");
      expect(children).toContain("certificates.parseX509");

      const pkcs12 = spanNamed(spans, "crypto.pkcs12.parse");
      expect(childSpans(spans, pkcs12).map((span) => span.name)).toContain("crypto.pkcs12.mac");
      expect(spanNamed(spans, "crypto.pkcs12.mac")?.attributes).toMatchObject({
        "signature_kit.pkcs12.mac_algorithm": expect.any(String),
      });
      expect(spanNamed(spans, "crypto.pkcs12.decryptKey")).toBeDefined();
      expect(spanNamed(spans, "asn1.decode")).toBeUndefined();

      const recorded = stringValues(spans);
      expect(recorded).not.toContain("56072386105");
      const subject = Exit.isSuccess(exit) ? exit.value.subject.commonName : null;
      expect(subject).not.toBeNull();
      expect(recorded).not.toContain(subject ?? "");
      expect(recorded).not.toContain('"1234"');
    }),
  );

  it.effect("marks a wrong password as a span error", () =>
    Effect.gen(function* () {
      const pfx = yield* readFixture("lacuna-turing.pfx");
      const { exit, spans } = yield* recordSpans(
        parseCertificate(pfx, Redacted.make("wrong-password")),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spanNamed(spans, "crypto.pkcs12.mac")?.status.code).toBe(2);
      const parse = spanNamed(spans, "certificates.parseCertificate");
      expect(parse?.status.code).toBe(2);
      expect(parse?.events.map((event) => event.name)).toContain("exception");
      expect(JSON.stringify(spans.map((span) => [span.attributes, span.events]))).not.toContain(
        "wrong-password",
      );
    }),
  );
});
