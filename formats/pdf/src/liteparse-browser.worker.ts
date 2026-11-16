import initLiteParseWasm, { LiteParse } from "@llamaindex/liteparse-wasm";
import { Schema } from "effect";

import { LiteParseWorkerRequestSchema } from "./liteparse-browser-protocol.js";
import type { LiteParseWorkerRequest } from "./liteparse-browser-protocol.js";

const isLiteParseWorkerRequest = Schema.is(LiteParseWorkerRequestSchema);

const renderLiteParseRequest = (request: LiteParseWorkerRequest): Promise<unknown> =>
  initLiteParseWasm().then(() => {
    const parser = new LiteParse({
      ocrEnabled: false,
      maxPages: request.pageCount,
      outputFormat: "json",
      preserveVerySmallText: true,
      quiet: true,
      extractScreenshots: true,
    });
    return Promise.resolve()
      .then(() => parser.parse(request.pdf))
      .finally(() => parser.free());
  });

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isLiteParseWorkerRequest(request)) {
    globalThis.postMessage({ kind: "failure" }, {});
    return;
  }

  void renderLiteParseRequest(request).then(
    (result) => {
      globalThis.postMessage({ kind: "success", result }, {});
    },
    () => {
      globalThis.postMessage({ kind: "failure" }, {});
    },
  );
});
