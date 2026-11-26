import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { signingHelperWorker } from "./signing-worker-server.js";

self.addEventListener("message", ({ data }) => BrowserRuntime.runMain(signingHelperWorker(data)), {
  once: true,
});
