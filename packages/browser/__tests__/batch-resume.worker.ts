import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

BrowserRuntime.runMain(
  localWorker(true, {
    resumeBatches: true,
    telemetry: { maxSpans: 4096, maxBytes: 2 * 1024 * 1024 },
    batchConfig: {
      concurrency: 1,
      queueCapacity: 1,
      byteBudget: 64 * 1024 * 1024,
      eventCapacity: 256,
    },
  }),
);
