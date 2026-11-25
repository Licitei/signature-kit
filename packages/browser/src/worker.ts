import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "./worker-server.js";

const size = Math.min(64, navigator.hardwareConcurrency - 1);

BrowserRuntime.runMain(
  localWorker(
    false,
    {},
    size > 0
      ? {
          size,
          createWorker: () =>
            new Worker(new URL("./signing-helper.js", import.meta.url), { type: "module" }),
        }
      : undefined,
  ),
);
