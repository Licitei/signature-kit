import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "../src/worker-server.js";

const helper =
  self.name === "missing"
    ? new URL("./missing-signing-helper.js", import.meta.url)
    : new URL("../src/signing-helper.ts", import.meta.url);

BrowserRuntime.runMain(
  localWorker(false, { signingWorkers: 3 }, () => new Worker(helper, { type: "module" })),
);
