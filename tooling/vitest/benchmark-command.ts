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
  const session = await page.context().newCDPSession(page);
  const attached: string[] = [];
  const attach = (event: { sessionId: string; targetInfo: { type: string } }) => {
    if (event.targetInfo.type === "worker") attached.push(event.sessionId);
  };
  session.on("Target.attachedToTarget", attach);
  try {
    await session.send("Performance.enable");
    const { metrics } = await session.send("Performance.getMetrics");
    const pageHeapBytes = metrics.find(({ name }) => name === "JSHeapUsedSize")?.value ?? 0;
    await session.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
    const usages = await Promise.all(
      attached.map((sessionId, index) => workerHeap(session, sessionId, index + 1)),
    );
    return {
      pageHeapBytes,
      workerHeapBytes: usages.reduce((sum, { used }) => sum + used, 0),
      workerBackingBytes: usages.reduce((sum, { backing }) => sum + backing, 0),
      workers: attached.length,
    };
  } finally {
    session.off("Target.attachedToTarget", attach);
    await session.detach();
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
