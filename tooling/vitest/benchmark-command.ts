import { defineBrowserCommand } from "@vitest/browser-playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Schema } from "effect";
import type { CDPSession } from "playwright";

declare module "vitest/browser" {
  interface BrowserCommands {
    sampleRuntimeMemory: () => Promise<{
      readonly pageHeapBytes: number;
      readonly workerHeapBytes: number;
      readonly workerBackingBytes: number;
      readonly workers: number;
    }>;
    writeBenchmark: (name: string, json: string) => Promise<string>;
  }
}

const HeapUsage = Schema.Struct({
  id: Schema.Finite,
  result: Schema.optional(
    Schema.Struct({
      usedSize: Schema.Finite,
      backingStorageSize: Schema.optional(Schema.Finite),
    }),
  ),
});
const decodeHeapUsage = Schema.decodeUnknownOption(Schema.fromJsonString(HeapUsage));

const workerHeap = (session: CDPSession, sessionId: string, id: number) =>
  new Promise<{ readonly used: number; readonly backing: number }>((resolve) => {
    const timer = setTimeout(() => {
      session.off("Target.receivedMessageFromTarget", listen);
      resolve({ used: 0, backing: 0 });
    }, 2000);
    const listen = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return;
      const decoded = decodeHeapUsage(event.message);
      if (decoded._tag === "None" || decoded.value.id !== id) return;
      clearTimeout(timer);
      session.off("Target.receivedMessageFromTarget", listen);
      resolve({
        used: decoded.value.result?.usedSize ?? 0,
        backing: decoded.value.result?.backingStorageSize ?? 0,
      });
    };
    session.on("Target.receivedMessageFromTarget", listen);
    void session.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method: "Runtime.getHeapUsage" }),
    });
  });

export const sampleRuntimeMemory = defineBrowserCommand(async ({ page }) => {
  const pageSession = await page.context().newCDPSession(page);
  const browser = page.context().browser();
  const session = browser === null ? undefined : await browser.newBrowserCDPSession();
  try {
    await pageSession.send("Performance.enable");
    const { metrics } = await pageSession.send("Performance.getMetrics");
    const pageHeapBytes = metrics.find(({ name }) => name === "JSHeapUsedSize")?.value ?? 0;
    if (session === undefined) {
      return { pageHeapBytes, workerHeapBytes: 0, workerBackingBytes: 0, workers: 0 };
    }
    const { targetInfos } = await session.send("Target.getTargets");
    const workers = targetInfos.filter(({ type }) => type === "worker");
    const usages = await Promise.all(
      workers.map(async ({ targetId }, index) => {
        const { sessionId } = await session.send("Target.attachToTarget", {
          targetId,
          flatten: false,
        });
        const usage = await workerHeap(session, sessionId, index + 1);
        await session.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        return usage;
      }),
    );
    return {
      pageHeapBytes,
      workerHeapBytes: usages.reduce((sum, { used }) => sum + used, 0),
      workerBackingBytes: usages.reduce((sum, { backing }) => sum + backing, 0),
      workers: workers.length,
    };
  } finally {
    await pageSession.detach();
    await session?.detach();
  }
});

export const writeBenchmark = defineBrowserCommand(async (_context, name: string, json: string) => {
  const directory = path.resolve(".cache/bench-v2");
  await mkdir(directory, { recursive: true });
  const label = process.env.SIGNATURE_KIT_BENCH_LABEL ?? "current";
  const file = path.join(directory, `${name}-${label}.json`.replace(/[^a-z0-9.-]/gi, "-"));
  await writeFile(file, json);
  return file;
});
