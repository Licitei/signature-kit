import { describe, expect, it } from "vitest";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { Effect } from "effect";

import { findPdfTextAnchors } from "../src/anchors";

const wasmUrl = new URL(
  "../../../node_modules/takumi-pdf/pkg/takumi_pdf_wasm_bg.wasm",
  import.meta.url,
);
const initTakumiBrowser = async (): Promise<void> => {
  const response = await fetch(wasmUrl);
  const wasmBytes = new Uint8Array(await response.arrayBuffer());
  const { initSync } = await import("takumi-pdf");
  initSync({ module: wasmBytes });
};

describe("takumi PDF generation in Chromium", () => {
  it("renders anchors that pdf-core can place in the browser", async () => {
    await initTakumiBrowser();
    const { render } = await import("takumi-pdf");
    const React = await import("react");
    const pdf = await render(
      React.createElement(
        "main",
        { tw: "flex flex-col gap-2 p-12" },
        React.createElement("p", { tw: "text-[4px] text-white" }, "[[licitei-assinatura]]"),
        React.createElement(
          "a",
          {
            href: "https://signature-kit.dev/corpus/takumi-signature",
            tw: "text-[4px] text-white",
          },
          "âncora",
        ),
      ),
      { size: "a4" },
    );
    const anchors = await Effect.runPromise(
      findPdfTextAnchors({
        pdf,
        matchers: [
          { text: "[[licitei-assinatura]]" },
          { link: "https://signature-kit.dev/corpus/takumi-signature" },
        ],
        stampSize: { width: 80, height: 20 },
        placement: "below",
        offset: 0,
      }).pipe(Effect.provide(pdfCoreBrowserLayer)),
    );
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const anchor of anchors) {
      expect(anchor.width).toBeGreaterThan(0);
      expect(anchor.height).toBeGreaterThan(0);
    }
  });
});
