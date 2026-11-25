import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { verifyTimestampToken } from "../../src/cms/timestamp.js";

const fixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(`../../../../tooling/testing/fixtures/validation/${name}.der`, import.meta.url),
        ),
      ),
  );

it.effect("verifies a standalone OpenSSL RFC 3161 token against explicit TSA roots", () =>
  Effect.gen(function* () {
    const [token, root, wrong] = yield* Effect.all([
      fixture("timestamp-token"),
      fixture("ca"),
      fixture("unrelated-root"),
    ]);
    const data = new TextEncoder().encode("SignatureKit timestamp fixture\n");
    const horizon = new Date("2040-01-01T00:00:00Z");
    const genTime = yield* verifyTimestampToken(token, data, [root], horizon);
    expect(genTime.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    expect(yield* Effect.flip(verifyTimestampToken(token, data, [wrong], horizon))).toMatchObject({
      code: "cms.TIMESTAMP_ERROR",
    });
    expect(
      yield* Effect.flip(verifyTimestampToken(token, new Uint8Array([1]), [root], horizon)),
    ).toMatchObject({ code: "cms.TIMESTAMP_ERROR", reason: expect.stringContaining("imprint") });
    expect(
      yield* Effect.flip(verifyTimestampToken(token, data, [root], new Date(0))),
    ).toMatchObject({ code: "cms.TIMESTAMP_ERROR" });
  }),
);
