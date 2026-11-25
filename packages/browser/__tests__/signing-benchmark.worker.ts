import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

BrowserRuntime.runMain(
  localWorker(false, {
    batchConfig: {
      concurrency: 2,
      queueCapacity: 4,
      byteBudget: 256 * 1024 * 1024,
      eventCapacity: 4096,
    },
  }),
);
