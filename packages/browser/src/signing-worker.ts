import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { signingWorker } from "./signing-worker-server.js";

BrowserRuntime.runMain(
  signingWorker(
    false,
    { signingWorkers: Math.max(0, Math.min(4, navigator.hardwareConcurrency - 1)) },
    () => new Worker(new URL("./signing-helper.js", import.meta.url), { type: "module" }),
  ),
);
