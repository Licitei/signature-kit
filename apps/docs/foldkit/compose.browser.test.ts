import { Effect } from "effect";
import { expect, it } from "vitest";

it("hydrates the composition route and repaints the selected document", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const frame = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("iframe");
            element.src = "/pt-BR/docs/compose";
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              () => ({
                status: frame.contentDocument?.querySelector("article [role=status]")?.textContent,
                widths: Array.from(
                  frame.contentDocument?.querySelectorAll<HTMLCanvasElement>(
                    "[data-compose-template]:not([hidden]) canvas",
                  ) ?? [],
                  (canvas) => canvas.width,
                ),
              }),
              { timeout: 15000 },
            )
            .toEqual({ status: "", widths: [893, 893] }),
        );
        const page = frame.contentDocument;
        expect(page?.querySelector("h1")?.textContent).toBe("Composição de PDF");
        const receipt = Array.from(page?.querySelectorAll<HTMLCanvasElement>("button") ?? []).find(
          (button) => button.textContent?.trim() === "Recibo",
        );
        if (receipt === undefined) return expect.fail("Missing receipt template control");
        receipt.click();
        yield* Effect.promise(() =>
          expect
            .poll(
              () =>
                Array.from(
                  page?.querySelectorAll<HTMLCanvasElement>(
                    "[data-compose-template]:not([hidden]) canvas",
                  ) ?? [],
                  (canvas) => canvas.width,
                ),
              { timeout: 15000 },
            )
            .toEqual([893]),
        );
        expect(receipt.getAttribute("aria-pressed")).toBe("true");
        expect(page?.querySelector('canvas[aria-label="Página 1"]')).not.toBeNull();
      }),
    ),
  );
}, 35000);
