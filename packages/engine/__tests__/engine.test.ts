import { describe, expect, it } from "@effect/vitest";
import { parsePkcs12 } from "../src/crypto/pkcs12.js";
import { Effect, Redacted } from "effect";
import { createHash, verify, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readSigningFixture } from "../../../tooling/testing/fixtures.ts";
import { recordSpans } from "../../../tooling/testing/tracing.ts";
import { importA1SigningKey } from "../src/a1-certificate.js";
import { A1Sessions, Documents, localRuntimeLayer } from "../src/engine.js";

const password = Redacted.make("changeit");
const readSanFixture = (name: "ecpf" | "ecnpj") =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(`../../../tooling/testing/fixtures/local/${name}.p12`, import.meta.url),
        ),
      ),
  );

describe("local documents", () => {
  it.effect("keeps an immutable revision and releases it idempotently", () =>
    Effect.gen(function* () {
      const documents = yield* Documents;
      const bytes = Uint8Array.of(10, 20, 30, 40);
      const revision = yield* documents.open(bytes.subarray(1, 3));
      const expected = Uint8Array.of(20, 30);
      expect(revision.byteLength).toBe(expected.byteLength);
      const digest = createHash("sha256").update(expected).digest("hex");
      expect(yield* documents.digest(revision)).toBe(digest);
      expect(yield* documents.digest(revision)).toBe(digest);

      const exported = yield* documents.export(revision.handle);
      expect(exported).toEqual(expected);
      exported.fill(0);
      expect(yield* documents.export(revision.handle)).toEqual(expected);

      yield* documents.release(revision.handle);
      yield* documents.release(revision.handle);
      expect(yield* Effect.flip(documents.export(revision.handle))).toMatchObject({
        code: "unknownHandle",
      });
    }).pipe(Effect.provide(localRuntimeLayer())),
  );

  it.effect("rejects foreign handles across runtime instances", () =>
    Effect.gen(function* () {
      const first = yield* Documents;
      const { handle } = yield* first.open(Uint8Array.of(42));
      yield* Effect.gen(function* () {
        const second = yield* Documents;
        expect(yield* Effect.flip(second.export(handle))).toMatchObject({ code: "staleHandle" });
        expect(yield* Effect.flip(second.release(handle))).toMatchObject({ code: "staleHandle" });
      }).pipe(Effect.provide(localRuntimeLayer()));
    }).pipe(Effect.provide(localRuntimeLayer())),
  );
});

describe("local A1 sessions", () => {
  it.effect("reports MAC authentication failure without returning a key or profile", () =>
    Effect.gen(function* () {
      const a1 = yield* A1Sessions;
      const pfx = Redacted.make(new Uint8Array(yield* readSigningFixture));
      expect(
        yield* Effect.flip(a1.open({ pfx, password: Redacted.make("wrong-password") })),
      ).toMatchObject({ code: "wrongPassword" });
      expect(
        yield* Effect.flip(a1.open({ pfx: Redacted.make(Uint8Array.of(0)), password })),
      ).toMatchObject({ code: "invalidPkcs12" });
    }).pipe(Effect.provide(localRuntimeLayer())),
  );

  it.effect("parses once per open, classifies SANs and records only allowed attributes", () =>
    Effect.gen(function* () {
      const cpf = yield* readSanFixture("ecpf");
      const cnpj = yield* readSanFixture("ecnpj");
      const other = yield* readSigningFixture;
      const bytes = new TextEncoder().encode("private document text");
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const a1 = yield* A1Sessions;
          const documents = yield* Documents;
          const revision = yield* documents.open(bytes);
          yield* documents.export(revision.handle);
          yield* documents.release(revision.handle);
          const first = yield* a1.open({ pfx: Redacted.make(cpf), password });
          const signature = yield* a1.sign(first.sessionId, first.generation, bytes);
          const second = yield* a1.open({ pfx: Redacted.make(cnpj), password });
          expect(second.generation).toBe(first.generation + 1);
          expect(
            yield* Effect.flip(a1.sign(first.sessionId, first.generation, bytes)),
          ).toMatchObject({ code: "staleGeneration" });
          yield* a1.close();
          expect(
            yield* Effect.flip(a1.sign(second.sessionId, second.generation, bytes)),
          ).toMatchObject({ code: "staleGeneration" });
          const third = yield* a1.open({ pfx: Redacted.make(new Uint8Array(other)), password });
          expect(third.generation).toBe(second.generation + 2);
          return { first, second, third, signature };
        }).pipe(Effect.provide(localRuntimeLayer())),
      );
      const { first, second, third, signature } = yield* exit;
      expect(first.profile.holderKind).toBe("e-cpf");
      expect(second.profile.holderKind).toBe("e-cnpj");
      expect(third.profile.holderKind).toBe("other");

      const certificate = yield* parsePkcs12(cpf, password);
      expect(first.profile.fingerprintSha256).toBe(
        createHash("sha256").update(certificate.certificate).digest("hex"),
      );
      const publicKey = new X509Certificate(certificate.certificate).publicKey;
      expect(verify("sha256", bytes, publicKey, signature)).toBe(true);

      const opens = spans.filter(({ name }) => name === "local.a1.open");
      expect(opens).toHaveLength(3);
      for (const open of opens) {
        expect(
          spans.filter(
            (span) =>
              span.name === "local.a1.parsePkcs12" &&
              span.parentSpanContext?.spanId === open.spanContext().spanId,
          ),
        ).toHaveLength(1);
      }
      const attributes = spans.flatMap((span) => Object.entries(span.attributes));
      for (const [key, value] of attributes) {
        if (key === "code.stacktrace") continue;
        if (key === "holderKind") {
          expect(["e-cpf", "e-cnpj", "other"]).toContain(value);
        } else {
          expect(["byteLength", "certificateCount", "signature_kit.certificate.bytes"]).toContain(
            key,
          );
          expect(typeof value).toBe("number");
        }
      }
      const serialized = JSON.stringify(attributes);
      for (const secret of [
        "changeit",
        "private document text",
        first.profile.subjectName,
        second.profile.subjectName,
        first.profile.fingerprintSha256,
        second.profile.fingerprintSha256,
        Buffer.from(cpf).toString("base64"),
        Buffer.from(cnpj).toString("base64"),
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }),
  );

  it.effect("imports a non-extractable signing key through the engine importer", () =>
    Effect.gen(function* () {
      const pfx = yield* readSigningFixture;
      const { privateKey } = yield* parsePkcs12(pfx, password);
      const key = yield* importA1SigningKey(privateKey, "SHA-256").pipe(
        Effect.ensuring(Effect.sync(() => privateKey.fill(0))),
      );
      expect(key.extractable).toBe(false);
      const error = yield* Effect.flip(
        Effect.tryPromise({
          try: () => crypto.subtle.exportKey("pkcs8", key),
          catch: (cause) => cause,
        }),
      );
      expect(error).toMatchObject({ name: "InvalidAccessError" });
    }),
  );

  it.effect("drops the active key when its layer scope closes", () =>
    Effect.gen(function* () {
      const pfx = Redacted.make(new Uint8Array(yield* readSigningFixture));
      const { a1, session } = yield* Effect.gen(function* () {
        const a1 = yield* A1Sessions;
        const session = yield* a1.open({ pfx, password });
        return { a1, session };
      }).pipe(Effect.provide(localRuntimeLayer()));
      expect(
        yield* Effect.flip(a1.sign(session.sessionId, session.generation, Uint8Array.of(1))),
      ).toMatchObject({ code: "runtimeClosed" });
    }),
  );
});
