import { defineBrowserCommand } from "@vitest/browser-playwright";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import type * as Harness from "../../packages/browser/__tests__/ltv-page.js";
import { localEvidenceServers } from "../testing/evidence-servers.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    runLtvMilestone: () => Promise<void>;
  }
}

const fixture = (path: string) =>
  readFile(new URL(`../testing/fixtures/${path}`, import.meta.url), "base64");

export const runLtvMilestone = defineBrowserCommand(({ page }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const browser = page.context().browser();
        if (browser === null) return yield* Effect.die("Chromium browser is unavailable.");
        const origin = new URL(page.url()).origin;
        const entry = `${origin}/packages/browser/__tests__/ltv-page.ts`;
        const blank = `${origin}/ltv-milestone.html`;
        const servers = yield* localEvidenceServers;
        const evidenceOrigin = new URL(servers.ocspUrl).origin;
        const withPage = <A>(allowed: readonly string[], use: (page: Page) => Promise<A>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const external: string[] = [];
              const context = yield* Effect.acquireRelease(
                Effect.promise(() =>
                  browser.newContext({
                    serviceWorkers: "block",
                    permissions: allowed.length > 0 ? ["local-network-access"] : [],
                  }),
                ),
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
                  const requestOrigin = new URL(url).origin;
                  if (requestOrigin === origin) return route.continue();
                  external.push(url);
                  return allowed.includes(requestOrigin) ? route.continue() : route.abort();
                });
              });
              const isolated = yield* Effect.promise(() => context.newPage());
              yield* Effect.promise(() => isolated.goto(blank));
              const result = yield* Effect.promise(() => use(isolated));
              return { result, external };
            }),
          );

        const fixtures = {
          pdf: yield* Effect.promise(() => fixture("cosign/sent.pdf")),
          p12: yield* Effect.promise(() => fixture("validation/signer.p12")),
          ca: yield* Effect.promise(() => fixture("validation/ca.der")),
          signer: yield* Effect.promise(() => fixture("validation/signer.der")),
          tsa: yield* Effect.promise(() => fixture("validation/tsa.der")),
        };
        const online = yield* withPage([evidenceOrigin], (isolated) =>
          isolated.evaluate(
            async ({ entry, fixtures, urls }) => {
              const harness: typeof Harness = await import(entry);
              return harness.archiveWithFetchedEvidence(fixtures, urls);
            },
            { entry, fixtures, urls: { ocsp: servers.ocspUrl, tsa: servers.tsaUrl } },
          ),
        );
        assert.ok(online.external.every((url) => new URL(url).origin === evidenceOrigin));
        assert.deepEqual(
          servers.requests
            .filter(({ method }) => method === "POST")
            .map(({ pathname }) => pathname),
          ["/ocsp", "/ocsp", "/tsa"],
        );
        assert.partialDeepStrictEqual(online.result.basic, [
          { kind: "signature", integrity: "valid", trust: "trusted", ltvLevel: "B-B" },
        ]);
        const archived = [
          {
            kind: "signature",
            integrity: "valid",
            trust: "trusted",
            ltvLevel: "B-LTA",
            revocation: "verified:ocsp:good",
            timeSource: "documentTimestamp",
          },
          { kind: "documentTimestamp", integrity: "valid", trust: "trusted" },
        ];
        assert.partialDeepStrictEqual(online.result.archived, archived);

        const requestCount = servers.requests.length;
        const offline = yield* withPage([], (isolated) =>
          isolated.evaluate(
            async ({ entry, pdf, ca }) => {
              const harness: typeof Harness = await import(entry);
              return harness.verifyOffline(pdf, ca);
            },
            { entry, pdf: online.result.pdf, ca: fixtures.ca },
          ),
        );
        assert.deepEqual(offline.external, []);
        assert.equal(servers.requests.length, requestCount);
        assert.partialDeepStrictEqual(offline.result, archived);
      }),
    ),
  ),
);
