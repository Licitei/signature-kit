import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "./worker-server.js";

BrowserRuntime.runMain(
  localWorker(
    false,
    { signingWorkers: Math.max(0, Math.min(4, navigator.hardwareConcurrency - 1)) },
    () => new Worker(new URL("./signing-helper.js", import.meta.url), { type: "module" }),
  ),
);
