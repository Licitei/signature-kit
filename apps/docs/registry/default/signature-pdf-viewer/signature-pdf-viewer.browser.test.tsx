import type { PdfSignaturePage, PdfSignatureRect } from "@signature-kit/pdf/config";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import wasmUrl from "@signature-kit/pdf-core/pdf-core.wasm?url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignaturePdfViewer } from "./signature-pdf-viewer";
import { pdfCoreLayer } from "@signature-kit/pdf-core/pdf-core";
import { Effect } from "effect";
import { textPdf } from "../../../__tests__/helpers/text-pdf";

vi.mock("react-pdf", () => ({
  Document: ({ children }: { readonly children: React.ReactNode }) => children,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {}, version: "test" },
}));

type PendingWasmRequest = {
  readonly signal: AbortSignal | undefined;
  readonly respond: () => void;
  readonly fail: () => void;
};

type ViewerProps = React.ComponentProps<typeof SignaturePdfViewer>;

type MountedViewer = {
  readonly cleanup: () => void;
  readonly getButton: () => HTMLButtonElement | null;
  readonly getError: () => HTMLElement | null;
  readonly rerender: (props: ViewerProps) => void;
};

type RejectionCapture = {
  readonly reasons: unknown[];
  readonly stop: () => void;
};

const wasmRequests: PendingWasmRequest[] = [];
const originalFetch = globalThis.fetch.bind(globalThis);
const pages: ReadonlyArray<PdfSignaturePage> = [{ index: 0, width: 200, height: 100 }];
let cleanup: (() => void) | null = null;
let stopUnhandledRejections: (() => void) | null = null;
let wasmBytes: ArrayBuffer | null = null;

const rafTick = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

async function waitFor(predicate: () => boolean, label: string, maxFrames = 240): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    if (predicate()) return;
    await rafTick();
  }

  expect(predicate(), label).toBe(true);
}

const captureUnhandledRejections = (): RejectionCapture => {
  const reasons: unknown[] = [];
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reasons.push(event.reason);
    event.preventDefault();
  };
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return {
    reasons,
    stop: () => window.removeEventListener("unhandledrejection", onUnhandledRejection),
  };
};

let fixtureModule: WebAssembly.Module | null = null;

const pdfWithAnchor = async (x: number): Promise<Uint8Array> => {
  fixtureModule ??= await WebAssembly.compile(await (await originalFetch(wasmUrl)).arrayBuffer());
  return Effect.runPromise(
    textPdf([{ width: 200, height: 100, runs: [{ text: "SIGN_HERE", x, y: 60, size: 10 }] }]).pipe(
      Effect.provide(pdfCoreLayer(fixtureModule)),
    ),
  );
};

const gatedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.includes("pdf-core.wasm")) {
    return originalFetch(input, init);
  }
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    const request: PendingWasmRequest = {
      signal,
      respond: () => {
        if (wasmBytes === null) {
          reject(new Error("wasm bytes were not loaded"));
          return;
        }
        resolve(
          new Response(wasmBytes.slice(0), { headers: { "content-type": "application/wasm" } }),
        );
      },
      fail: () => reject(new Error("wasm request failed")),
    };
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    wasmRequests.push(request);
  });
};

const viewerProps = (file: Uint8Array, onChange: ViewerProps["onChange"]): ViewerProps => ({
  anchorTokens: ["SIGN_HERE"],
  file,
  mode: "anchors",
  onChange,
  pages,
  stampSize: { width: 80, height: 20 },
  value: [],
});

const mountViewer = (props: ViewerProps): MountedViewer => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const rerender = (nextProps: ViewerProps): void => {
    root.render(<SignaturePdfViewer {...nextProps} />);
  };
  rerender(props);

  return {
    cleanup: () => {
      root.unmount();
      container.remove();
    },
    getButton: () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Find anchors",
      ) ?? null,
    getError: () => container.querySelector("p"),
    rerender,
  };
};

if (typeof document === "undefined") {
  describe.skip("SignaturePdfViewer browser scans", () => {
    it("runs only through apps/docs/vitest.browser.config.ts", () => {});
  });
} else {
  describe("SignaturePdfViewer browser scans", () => {
    beforeEach(async () => {
      wasmRequests.splice(0);
      wasmBytes ??= await (await originalFetch(wasmUrl)).arrayBuffer();
      vi.stubGlobal("fetch", gatedFetch);
    });

    afterEach(() => {
      cleanup?.();
      cleanup = null;
      stopUnhandledRejections?.();
      stopUnhandledRejections = null;
      vi.unstubAllGlobals();
    });

    it("provides pdf-core at the scan boundary and emits the matched anchor rect", async () => {
      const changes: ReadonlyArray<PdfSignatureRect>[] = [];
      const viewer = mountViewer(
        viewerProps(await pdfWithAnchor(12), (rects) => {
          changes.push(rects);
        }),
      );
      cleanup = viewer.cleanup;

      await waitFor(() => viewer.getButton() !== null, "anchor scan button is rendered");
      const scanButton = viewer.getButton();
      if (scanButton === null) expect.fail("anchor scan button was not rendered");
      scanButton.click();
      await waitFor(
        () => viewer.getButton()?.disabled === true,
        "scan prevents duplicate requests",
      );

      await waitFor(() => wasmRequests.length === 1, "the scan requests the pdf-core module");
      wasmRequests[0]?.respond();

      await waitFor(() => changes.length === 1, "the anchor scan result is emitted");
      const rect = changes[0]?.[0];
      expect(changes[0]).toHaveLength(1);
      expect(rect?.pageIndex).toBe(0);
      expect(rect?.x).toBeCloseTo(12, 0);
      expect(rect?.width).toBe(80);
      expect(rect?.height).toBe(20);
      await waitFor(() => viewer.getButton()?.disabled === false, "the finished scan re-enables");
      expect(viewer.getError()).toBeNull();
    });

    it("invalidates a delayed scan when the current document changes", async () => {
      const changes: ReadonlyArray<PdfSignatureRect>[] = [];
      const onChange: ViewerProps["onChange"] = (rects) => {
        changes.push(rects);
      };
      const viewer = mountViewer(viewerProps(await pdfWithAnchor(6), onChange));
      cleanup = viewer.cleanup;

      await waitFor(() => viewer.getButton() !== null, "anchor scan button is rendered");
      const firstButton = viewer.getButton();
      if (firstButton === null) expect.fail("first anchor scan button was not rendered");
      firstButton.click();
      await waitFor(() => wasmRequests.length === 1, "the first scan requests the module");
      const firstRequest = wasmRequests[0];
      if (firstRequest === undefined) expect.fail("first pdf-core request was not created");

      viewer.rerender(viewerProps(await pdfWithAnchor(42), onChange));
      await waitFor(
        () => viewer.getButton()?.disabled === false,
        "the changed document clears the prior scanning state",
      );
      expect(firstRequest.signal?.aborted).toBe(true);
      const secondButton = viewer.getButton();
      if (secondButton === null) expect.fail("second anchor scan button was not rendered");
      secondButton.click();
      await waitFor(() => wasmRequests.length === 2, "the second scan requests the module");
      wasmRequests[1]?.respond();

      await waitFor(() => changes.length === 1, "the current document emits its anchor result");
      firstRequest.respond();
      await rafTick();
      await rafTick();

      expect(changes).toHaveLength(1);
      expect(changes[0]?.[0]?.x).toBeCloseTo(42, 0);
      expect(viewer.getError()).toBeNull();
    });

    it("leaves failed and aborted scans settled without unhandled rejections", async () => {
      const rejections = captureUnhandledRejections();
      stopUnhandledRejections = rejections.stop;
      const viewer = mountViewer(viewerProps(await pdfWithAnchor(6), () => {}));
      cleanup = viewer.cleanup;

      await waitFor(() => viewer.getButton() !== null, "anchor scan button is rendered");
      const failedButton = viewer.getButton();
      if (failedButton === null) expect.fail("failed anchor scan button was not rendered");
      failedButton.click();
      await waitFor(() => wasmRequests.length === 1, "the failing scan requests the module");
      wasmRequests[0]?.fail();

      await waitFor(() => viewer.getError() !== null, "the module failure is rendered");
      expect(viewer.getButton()?.disabled).toBe(false);

      viewer.rerender(viewerProps(await pdfWithAnchor(7), () => {}));
      await waitFor(
        () => viewer.getError() === null,
        "the changed document resets the failure state",
      );
      const abortedButton = viewer.getButton();
      if (abortedButton === null) expect.fail("aborted anchor scan button was not rendered");
      abortedButton.click();
      await waitFor(() => wasmRequests.length === 2, "the abortable scan requests the module");

      viewer.rerender(viewerProps(await pdfWithAnchor(8), () => {}));
      await waitFor(
        () => viewer.getButton()?.disabled === false,
        "the aborted scan clears the scanning state",
      );
      await rafTick();

      expect(rejections.reasons).toEqual([]);
    });
  });
}
