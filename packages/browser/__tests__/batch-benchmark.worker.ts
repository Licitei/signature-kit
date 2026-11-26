import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

const size = Number(self.name || "0");

BrowserRuntime.runMain(
  localWorker(
    true,
    { signingWorkers: size, telemetry: { maxSpans: 4096, maxBytes: 2 * 1024 * 1024 } },
    () => new Worker(new URL("../src/signing-helper.ts", import.meta.url), { type: "module" }),
  ),
);
