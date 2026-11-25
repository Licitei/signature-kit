import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import { localWorker } from "./worker-server.js";

BrowserRuntime.runMain(localWorker(false));
