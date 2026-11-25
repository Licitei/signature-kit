import { Effect } from "effect";
import { expect, it } from "vitest";
import ecpf from "../../../tooling/testing/fixtures/local/ecpf.p12?inline";

it("reviews three composed contracts and downloads only the selected signed PDFs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const frame = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const frame = document.createElement("iframe");
            frame.src = "/en-US/docs/batch";
            document.body.append(frame);
            return frame;
          }),
          (frame) => Effect.sync(() => frame.remove()),
        );
        const bytes = yield* Effect.tryPromise({
          try: () => fetch(ecpf).then((response) => response.arrayBuffer()),
          catch: () => "Chromium could not load the A1 fixture.",
        });
        yield* Effect.promise(() =>
          expect
            .poll(
              () =>
                frame.contentDocument
                  ?.querySelector("[data-phase=prepare]")
                  ?.hasAttribute("hidden"),
              { timeout: 15_000 },
            )
            .toBe(false),
        );
        const doc = frame.contentDocument;
        const pfx = doc?.querySelector<HTMLInputElement>("#batch-certificate");
        const password = doc?.querySelector<HTMLInputElement>("#batch-password");
        const prepare = doc?.querySelector<HTMLFormElement>("[data-phase=prepare]");
        if (
          pfx === undefined ||
          pfx === null ||
          password === undefined ||
          password === null ||
          prepare === undefined ||
          prepare === null
        ) {
          return expect.fail("The hydrated batch route did not expose its preparation form.");
        }
        const files = new DataTransfer();
        files.items.add(
          new File([bytes], "test-certificate.p12", { type: "application/x-pkcs12" }),
        );
        pfx.files = files.files;
        password.value = "changeit";
        prepare.requestSubmit();
        yield* Effect.promise(() =>
          expect
            .poll(() => doc?.querySelectorAll("a[target=_blank][href^='blob:']").length, {
              timeout: 15_000,
            })
            .toBe(3),
        );
        const skip = doc?.querySelector<HTMLInputElement>("#batch-item-2");
        const confirm = doc?.querySelector<HTMLFormElement>("[data-phase=confirm]");
        if (skip == null || confirm == null) return expect.fail("Missing review selection.");
        skip.click();
        confirm.requestSubmit();
        yield* Effect.promise(() =>
          expect
            .poll(
              () =>
                Array.from(doc?.querySelectorAll("a[download]") ?? [], (link) =>
                  link.getAttribute("download"),
                ),
              { timeout: 15_000 },
            )
            .toEqual(["contract-1.pdf", "contract-3.pdf"]),
        );
        const href = doc?.querySelector("a[download]")?.getAttribute("href");
        const frameWindow = frame.contentWindow;
        if (href == null || frameWindow === null) return expect.fail("Missing signed PDF URL.");
        const output = yield* Effect.tryPromise({
          try: () => frameWindow.fetch(href).then((response) => response.text()),
          catch: () => "Chromium could not read the signed download.",
        });
        expect(output.startsWith("%PDF-")).toBe(true);
        expect(output).toContain("/ByteRange");
      }),
    ).pipe(Effect.timeout("40 seconds")),
  );
}, 45_000);
