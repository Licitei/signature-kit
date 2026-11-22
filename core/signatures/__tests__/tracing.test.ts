import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { SignatureSession, signatureSessionLayer } from "../src/session.js";
import { signatures, signaturesLayer } from "../src/signatures.js";
import type { SignerAdapter } from "../src/signatures.js";
import { recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";

const adapter: SignerAdapter = {
  id: "test",
  inspect: () => Effect.die("unused"),
  certificate: () => Effect.die("unused"),
  importSigningKey: () => Effect.die("unused"),
  sign: (input) => Effect.succeed({ algorithm: input.algorithm, signature: new Uint8Array(4) }),
  verify: (input) => Effect.succeed({ valid: false, algorithm: input.algorithm }),
};

describe("Signatures tracing", () => {
  it.effect("records sign and verify spans with algorithm and sizes", () =>
    Effect.gen(function* () {
      const content = new Uint8Array(32);
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          yield* signatures.sign({ content, algorithm: "rsa-sha512" });
          return yield* signatures.verify({
            content,
            signature: new Uint8Array(4),
            algorithm: "rsa-sha512",
          });
        }).pipe(Effect.provide(signaturesLayer(adapter))),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(spanNamed(spans, "signatures.sign")?.attributes).toMatchObject({
        "signature_kit.signer.id": "test",
        "signature_kit.signature.algorithm": "rsa-sha512",
        "signature_kit.data.bytes": 32,
      });
      expect(spanNamed(spans, "signatures.verify")?.attributes).toMatchObject({
        "signature_kit.signature.valid": false,
      });
    }),
  );

  it.effect("marks invalid sign input as a span error", () =>
    Effect.gen(function* () {
      const { exit, spans } = yield* recordSpans(
        signatures
          .sign({ content: new Uint8Array(1), algorithm: "rsa-sha256" })
          .pipe(
            Effect.provide(
              signaturesLayer({ ...adapter, sign: () => Effect.die("signer unavailable") }),
            ),
          ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spanNamed(spans, "signatures.sign")?.status.code).toBe(2);
    }),
  );

  it.effect("records session lifecycle spans", () =>
    Effect.gen(function* () {
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const session = yield* SignatureSession;
          const started = yield* session.initialize(Effect.succeed({ adapter, value: 1 }));
          yield* session.use(started.generation, () => Effect.void);
          yield* session.dispose();
        }).pipe(
          Effect.provide(
            signatureSessionLayer({ initialization: "initialization", unavailableReason: "x" }),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const names = spans.map((span) => span.name);
      expect(names).toContain("signatures.session.initialize");
      expect(names).toContain("signatures.session.use");
      expect(names).toContain("signatures.session.dispose");
    }),
  );
});
