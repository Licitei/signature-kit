import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

const size = Number(self.name || "0");

BrowserRuntime.runMain(
  localWorker(
    false,
    {
      signingWorkers: size,
      batchConfig: {
        concurrency: Math.min(64, Math.max(2, size * 2)),
        queueCapacity: Math.max(4, size * 4),
        byteBudget: 256 * 1024 * 1024,
        eventCapacity: 4096,
      },
    },
    () => new Worker(new URL("../src/signing-helper.ts", import.meta.url), { type: "module" }),
  ),
);
