import { readFile } from "node:fs/promises";
import { Effect } from "effect";

export const readSigningFixture = Effect.promise(
  async () =>
    new Uint8Array(await readFile(new URL("./fixtures/signing-test.p12", import.meta.url))),
);
