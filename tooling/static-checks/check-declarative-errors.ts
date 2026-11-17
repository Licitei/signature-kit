#!/usr/bin/env bun

import { runPdfCoreAbiChecks } from "./src/pdf-core-abi";
import { runDeclarativeChecks } from "./src/runner";

const declarativeFailed = runDeclarativeChecks();
if (runPdfCoreAbiChecks() || declarativeFailed) {
  process.exit(1);
}
