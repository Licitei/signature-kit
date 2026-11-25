import { defineBrowserCommand } from "@vitest/browser-playwright";
import assert from "node:assert/strict";
import { Effect } from "effect";
import type * as Harness from "../../packages/browser/__tests__/batch-page.js";
import type { Page } from "playwright";

declare module "vitest/browser" {
  interface BrowserCommands {
    runBatchResume: () => Promise<void>;
    sampleBatchPageHeap: () => Promise<number>;
  }
}

export const sampleBatchPageHeap = defineBrowserCommand(async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable");
    const { metrics } = await session.send("Performance.getMetrics");
    const heap = metrics.find(({ name }) => name === "JSHeapUsedSize");
    assert.ok(heap !== undefined, "Chromium did not report page JS heap usage.");
    return heap.value;
  } finally {
    await session.detach();
  }
});

export const runBatchResume = defineBrowserCommand(({ page }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const browser = page.context().browser();
        if (browser === null) return yield* Effect.die("Chromium is unavailable.");
        const context = yield* Effect.acquireRelease(
          Effect.promise(() => browser.newContext({ serviceWorkers: "block" })),
          (context) => Effect.promise(() => context.close()),
        );
        const origin = new URL(page.url()).origin;
        const entry = `${origin}/packages/browser/__tests__/batch-page.ts`;
        const address = `${origin}/batch-resume.html`;
        const resumeId = crypto.randomUUID();
        const count = 50;
        yield* Effect.promise(() =>
          context.route(address, (route) =>
            route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
          ),
        );

        const open = (tab: Page) =>
          tab.evaluateHandle(
            async ({ entry, resumeId, count }) => {
              const harness: typeof Harness = await import(entry);
              return harness.openBatchPage(resumeId, count);
            },
            { entry, resumeId, count },
          );

        yield* Effect.promise(async () => {
          const first = await context.newPage();
          const second = await context.newPage();
          await Promise.all([first.goto(address), second.goto(address)]);
          const owner = await open(first);
          const other = await open(second);
          const [oldSession, otherSession] = await Promise.all([
            owner.evaluate((session) => session.warm()),
            other.evaluate((session) => session.warm()),
          ]);
          const reviewed = await owner.evaluate(
            (session, binding) => session.prepare(binding),
            oldSession,
          );
          assert.equal(reviewed.progress.signed, 0);
          assert.equal(
            await other.evaluate((session, binding) => session.rejected(binding), otherSession),
            "batchLocked",
          );
          const firstSigned = await owner.evaluate(
            (session, items) => session.signUntilFirstReceipt(items),
            reviewed.items,
          );
          assert.ok(firstSigned !== null, "Expected a committed receipt before reload.");
          await first.reload();
          const replacement = await open(first);
          assert.equal(
            await replacement.evaluate((session, binding) => session.rejected(binding), oldSession),
            "staleGeneration",
          );
          const freshSession = await replacement.evaluate((session) => session.warm());
          const recovered = await replacement.evaluate(
            (session, binding) => session.prepare(binding),
            freshSession,
          );
          assert.ok(recovered.progress.signed > 0 && recovered.progress.signed < count);
          assert.equal(
            recovered.items.find((item) => item.itemId === firstSigned.itemId)?.receipt?.receiptId,
            firstSigned.receiptId,
          );
          assert.ok(
            recovered.items
              .filter(({ state }) => state === "signed")
              .every(({ preparation }) => preparation === undefined),
          );
          const result = await replacement.evaluate(
            (session, items) => session.finish(items),
            recovered.items,
          );
          assert.equal(result.snapshot.progress.signed, count);
          assert.equal(result.signs, count - recovered.progress.signed);
          await replacement.evaluate((session) => session.release());
          const complete = await other.evaluate(
            (session, binding) => session.prepare(binding),
            otherSession,
          );
          assert.equal(complete.state, "completed");
          assert.equal(complete.progress.signed, count);
          await other.evaluate((session) => session.remove());
          await replacement.evaluate((session) => session.dispose());
          await other.evaluate((session) => session.dispose());
        });
      }),
    ),
  ),
);
