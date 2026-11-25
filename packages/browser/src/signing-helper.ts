import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { signingHelperWorker } from "./worker-server.js";

BrowserRuntime.runMain(signingHelperWorker);
