import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

const size = Number(self.name || "0");

BrowserRuntime.runMain(
  localWorker(
    false,
    {
      batchConfig: {
        concurrency: Math.max(2, size),
        queueCapacity: Math.max(4, size * 2),
        byteBudget: 256 * 1024 * 1024,
        eventCapacity: 4096,
      },
    },
    size > 0
      ? {
          size,
          createWorker: () =>
            new Worker(new URL("../src/signing-helper.ts", import.meta.url), { type: "module" }),
        }
      : undefined,
  ),
);
