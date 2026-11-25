import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

BrowserRuntime.runMain(
  localWorker(true, {
    telemetry: { maxSpans: 4096, maxBytes: 2 * 1024 * 1024 },
  }),
);
