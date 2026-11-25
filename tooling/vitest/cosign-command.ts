import { defineBrowserCommand } from "@vitest/browser-playwright";
import { ComparisonReport } from "../../packages/engine/src/rpc.js";
import { Effect, Schema } from "effect";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import type * as Harness from "../../packages/browser/__tests__/cosign-page.js";
import { signatories } from "../testing/cosign.js";
import { verifyIndependently } from "../testing/verify-pdf.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    runCosignMilestone: () => Promise<void>;
  }
}

const fixture = (name: string) =>
  readFile(new URL(`../testing/fixtures/cosign/${name}`, import.meta.url), "base64");

export const runCosignMilestone = defineBrowserCommand(({ page }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const browser = page.context().browser();
        if (browser === null) return yield* Effect.die("Chromium browser is unavailable.");
        const origin = new URL(page.url()).origin;
        const entry = `${origin}/packages/browser/__tests__/cosign-page.ts`;
        const blank = `${origin}/cosign-milestone.html`;
        const external: string[] = [];
        const withPage = <A>(use: (page: Page) => Promise<A>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Effect.acquireRelease(
                Effect.promise(() => browser.newContext({ serviceWorkers: "block" })),
                (context) => Effect.promise(() => context.close()),
              );
              yield* Effect.promise(async () => {
                await context.route("**/*", (route) => {
                  const url = route.request().url();
                  if (url === blank)
                    return route.fulfill({
                      contentType: "text/html",
                      body: "<!doctype html><body></body>",
                    });
                  if (new URL(url).origin === origin) return route.continue();
                  external.push(url);
                  return route.abort();
                });
              });
              const isolated = yield* Effect.promise(() => context.newPage());
              yield* Effect.promise(() => isolated.goto(blank));
              return yield* Effect.promise(() => use(isolated));
            }),
          );

        const [contract, ecpf, ecnpj, root] = yield* Effect.promise(() =>
          Promise.all([
            fixture("contract.pdf"),
            fixture("ecpf.p12"),
            fixture("ecnpj.p12"),
            fixture("root.der"),
          ]),
        );
        const first = yield* withPage((isolated) =>
          isolated.evaluate(
            async ({ entry, contract, ecpf }) => {
              const harness: typeof Harness = await import(entry);
              return harness.firstSignatory(contract, ecpf);
            },
            { entry, contract, ecpf },
          ),
        );
        assert.equal(first.fields.fields.length, 2);
        assert.partialDeepStrictEqual(
          first.fields.fields,
          signatories.map(({ name, page, rect }) => ({
            name,
            signed: false,
            widgets: [{ page, rect }],
          })),
        );
        assert.equal(first.fields.revisions.length, 2);
        assert.deepEqual(first.widget, { kind: "visible", page: 0, rect: signatories[0].rect });
        assert.equal(first.ink, true);

        const second = yield* withPage((isolated) =>
          isolated.evaluate(
            async ({ entry, signed, ecnpj, root }) => {
              const harness: typeof Harness = await import(entry);
              return harness.secondSignatory(signed, ecnpj, root);
            },
            { entry, signed: first.signed, ecnpj, root },
          ),
        );
        const firstBytes = Buffer.from(first.signed, "base64");
        const sent = Buffer.from(first.sent, "base64");
        const returned = Buffer.from(second.signed, "base64");
        assert.deepEqual(firstBytes.subarray(0, sent.length), sent);
        assert.deepEqual(returned.subarray(0, firstBytes.length), firstBytes);
        assert.equal(second.previous.signatures.length, 1);
        assert.partialDeepStrictEqual(second.previous.signatures, [
          { fieldName: "Contratante", integrity: "valid", trust: "trusted" },
        ]);

        const comparison = yield* withPage((isolated) =>
          isolated.evaluate(
            async ({ entry, sent, returned, root }) => {
              const harness: typeof Harness = await import(entry);
              return harness.compareFiles(sent, returned, root);
            },
            { entry, sent: first.sent, returned: second.signed, root },
          ),
        );
        assert.deepEqual(
          [first.isolated, second.isolated, comparison.isolated],
          [true, true, true],
        );
        assert.equal(new Set([first.instanceId, second.instanceId, comparison.instanceId]).size, 3);
        assert.deepEqual(external, []);

        const report = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.toCodecJson(ComparisonReport)),
        )(comparison.report);
        assert.equal(report.signatures.length, 2);
        for (const signature of report.signatures) assert.ok(signature.claimedSigningTime);
        const expectedChanges = { unknown: [], unknownObjectCount: 0, pageContentChanged: false };
        const expectedSignature = {
          integrity: "valid",
          trust: "trusted",
          revocation: { kind: "notChecked" },
          timestampEvidence: { kind: "absent" },
          changes: expectedChanges,
        };
        assert.partialDeepStrictEqual(report, {
          verdict: "signedAsExpected",
          reasons: [],
          sentPreserved: true,
          sentRevisionIndex: 1,
          changes: expectedChanges,
          signatures: [
            {
              ...expectedSignature,
              fieldName: "Contratante",
              signer: {
                commonName: "SignatureKit Test Person",
                holderKind: "e-cpf",
                brazilian: { cpf: "00000000001", cnpj: null },
              },
              coverage: {
                kind: "partial",
                revisionEnd: firstBytes.length,
                bytesAfter: returned.length - firstBytes.length,
              },
            },
            {
              ...expectedSignature,
              fieldName: "Contratada",
              signer: {
                commonName: "SignatureKit Test Company",
                holderKind: "e-cnpj",
                brazilian: { cpf: null, cnpj: "00000000000002" },
              },
              coverage: { kind: "wholeFile", revisionEnd: returned.length, bytesAfter: 0 },
            },
          ],
        });
        yield* verifyIndependently(returned, 2);
      }),
    ),
  ),
);
