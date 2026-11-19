import "./styles/fonts";
import { Effect, Result, Schema } from "effect";
import { verifyPdfSignatures } from "@signature-kit/pdf/verify";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { readA1FixtureFromBrowser } from "../../../tooling/testing/fixtures.browser";
import { Runtime } from "foldkit";
import * as Server from "foldkit/experimental/server";
import { expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { Flags, Model, init, update, view } from "./main";
import posthog from "posthog-js";
import { docsPostHogOptions } from "../lib/posthog/client";
import { textPdf } from "../__tests__/helpers/text-pdf";

const pdfTextOf = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const inspection = yield* core.inspect(bytes, { text: true, links: false });
    return inspection.text.map((page) => page.text).join(" ");
  }).pipe(Effect.provide(pdfCoreBrowserLayer));

const openOverlay = (host: HTMLElement, kind: string) =>
  Effect.gen(function* () {
    const trigger = host.querySelector<HTMLAnchorElement>(`main [data-overlay="${kind}"]`);
    if (trigger === null) return yield* Effect.die(`Missing ${kind} trigger`);
    yield* Effect.promise(() => userEvent.click(trigger));
    yield* Effect.promise(() =>
      expect
        .poll(() => host.querySelector("#site-overlay")?.hasAttribute("open"), { timeout: 10000 })
        .toBe(true),
    );
    return trigger;
  });

declare module "vitest/browser" {
  interface BrowserCommands {
    homeDeniedClipboard: () => Promise<{ permission: string; status: string | null }>;
  }
}

it("selects real provider snippets and copies the selected snippet in Chromium", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-browser-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#home-browser-test"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector(".home-providers button")).not.toBeNull(),
        );
        yield* openOverlay(host, "providers");
        const provider = [...host.querySelectorAll("button")].find(
          (button) => button.textContent === "DocuSeal",
        );
        if (provider === undefined) return expect.fail("Missing provider selector");
        yield* Effect.promise(() => userEvent.click(provider));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector(".home-code")?.textContent)
            .toContain("DocuSealSignatureRequest"),
        );
        expect(
          [...host.querySelectorAll(".home-providers button")]
            .find((button) => button.textContent === "DocuSeal")
            ?.getAttribute("aria-selected"),
        ).toBe("true");
        const button = host.querySelector<HTMLButtonElement>(".home-code .home-copy");
        if (button === null) return expect.fail("Missing copy button");
        yield* Effect.promise(() => userEvent.click(button));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector('[role="status"].home-status')?.textContent)
            .toBe("Copied"),
        );
        const text = yield* Effect.promise(() => navigator.clipboard.readText());
        expect(text).toContain("DocuSealSignatureRequest");
        expect(text).toContain("contentBase64");
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );
}, 25000);

it("signs a PDF from the home and exposes a verifiable download", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-browser-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#home-browser-test"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "pt-BR", path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        const pfx = yield* readA1FixtureFromBrowser("ecpf");
        const pdf = yield* textPdf([
          { width: 600, height: 400, runs: [{ text: "SignatureKit home signing", x: 30, y: 100 }] },
        ]).pipe(Effect.provide(pdfCoreBrowserLayer));
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector("#site-overlay form")).not.toBeNull(),
        );
        yield* openOverlay(host, "signer");
        const form = host.querySelector<HTMLFormElement>("#site-overlay form");
        const certificate = host.querySelector<HTMLInputElement>("#site-overlay [name=pfx]");
        const documentInput = host.querySelector<HTMLInputElement>("#site-overlay [name=pdf]");
        const password = host.querySelector<HTMLInputElement>("#site-overlay [name=password]");
        if (form === null || certificate === null || documentInput === null || password === null)
          return expect.fail("Missing signer controls");
        const certificates = new DataTransfer();
        certificates.items.add(new File([new Uint8Array(pfx)], "certificate.p12"));
        certificate.files = certificates.files;
        certificate.dispatchEvent(new Event("change", { bubbles: true }));
        const documents = new DataTransfer();
        documents.items.add(
          new File([new Uint8Array(pdf)], "document.pdf", { type: "application/pdf" }),
        );
        documentInput.files = documents.files;
        documentInput.dispatchEvent(new Event("change", { bubbles: true }));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector<HTMLImageElement>("[data-preview] img")?.naturalWidth, {
              timeout: 30000,
            })
            .toBeGreaterThan(0),
        );
        const page = host.querySelector<HTMLElement>(".signing-page");
        if (page === null) return expect.fail("Missing PDF preview");
        const bounds = page.getBoundingClientRect();
        page.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            clientX: bounds.left + bounds.width * 0.4,
            clientY: bounds.top + bounds.height * 0.5,
          }),
        );
        expect(host.querySelector(".signing-rectangle")).not.toBeNull();
        password.value = "changeit";
        password.dispatchEvent(new Event("input", { bubbles: true }));
        const loadIdentity = host.querySelector<HTMLButtonElement>("[data-load-identity]");
        if (loadIdentity === null) return expect.fail("Missing identity control");
        loadIdentity.click();
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector<HTMLElement>("[data-preview]")?.dataset.visualReady, {
              timeout: 60000,
            })
            .toBe("true"),
        );
        form.requestSubmit();
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector<HTMLAnchorElement>("[data-downloads] a")?.href, {
              timeout: 60000,
            })
            .toMatch(/^blob:/),
        );
        const link = host.querySelector<HTMLAnchorElement>("[data-downloads] a");
        if (link === null) return expect.fail("Missing signed download");
        expect(link.download).toBe("assinado-document.pdf");
        const signed = yield* Effect.promise(
          async () => new Uint8Array(await (await fetch(link.href)).arrayBuffer()),
        );
        const signatures = yield* verifyPdfSignatures({ pdf: signed }).pipe(
          Effect.provide(pdfCoreBrowserLayer),
        );
        expect(signatures.at(-1)?.cryptographicValid).toBe(true);
        expect(signatures.at(-1)?.coverageValid).toBe(true);
      }),
    ).pipe(Effect.timeout("120 seconds")),
  );
}, 125000);

it("hydrates the server-rendered home and keeps theme controls interactive", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const savedTheme = localStorage.getItem("signaturekit-theme");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (savedTheme === null) localStorage.removeItem("signaturekit-theme");
            else localStorage.setItem("signaturekit-theme", savedTheme);
          }),
        );
        localStorage.removeItem("signaturekit-theme");
        const rendered = yield* Server.renderToString(
          { Flags, init, view },
          {
            flags: { locale: "en-US", path: "" },
            buildId: "home-browser-test",
          },
        );
        const frame = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("iframe");
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        const mainUrl = new URL("./main.ts", import.meta.url).href;
        const loaded = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        frame.srcdoc = `<!doctype html><html><body>${rendered.html}<script type="module">
      import { Runtime } from "/@id/foldkit";
      import { Flags, Model, init, update, view } from ${JSON.stringify(mainUrl)};
      const container = document.querySelector("[data-foldkit-app]");
      Runtime.hydrate(Runtime.makeApplication({ Flags, Model, init, update, view, container }), { buildId: "home-browser-test" });
    </script></body></html>`;
        yield* Effect.promise(() => loaded);
        const doc = frame.contentDocument;
        if (doc === null) return expect.fail("Missing frame document");
        const button = doc.querySelector<HTMLButtonElement>('[aria-label="Toggle theme"]');
        if (button === null) return expect.fail("Missing theme switch");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => {
                button.click();
                return doc.querySelector(".site")?.getAttribute("data-theme");
              },
              { timeout: 10000 },
            )
            .toBe("dark"),
        );
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );
}, 25000);

it("persists theme across localized hydration and reload", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const previous = localStorage.getItem("signaturekit-theme");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === null) localStorage.removeItem("signaturekit-theme");
            else localStorage.setItem("signaturekit-theme", previous);
          }),
        );
        localStorage.removeItem("signaturekit-theme");
        const frame = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("iframe");
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        const mainUrl = new URL("./main.ts", import.meta.url).href;
        const load = (locale: "en-US" | "pt-BR") =>
          Effect.gen(function* () {
            const rendered = yield* Server.renderToString(
              { Flags, init, view },
              { flags: { locale, path: "" }, buildId: "home-theme-test" },
            );
            const loaded = new Promise<void>((resolve) =>
              frame.addEventListener("load", () => resolve(), { once: true }),
            );
            frame.srcdoc = `<!doctype html><html><body>${rendered.html}<script type="module">
        import { Runtime } from "/@id/foldkit";
        import { Flags, Model, init, update, view } from ${JSON.stringify(mainUrl)};
        const container = document.querySelector("[data-foldkit-app]");
        Runtime.hydrate(Runtime.makeApplication({ Flags, Model, init, update, view, container }), { buildId: "home-theme-test" });
      </script></body></html>`;
            yield* Effect.promise(() => loaded);
          });
        yield* load("en-US");
        const english = frame.contentDocument;
        if (english === null) return expect.fail("Missing English document");
        const toggle = english.querySelector<HTMLButtonElement>('[aria-label="Toggle theme"]');
        if (toggle === null) return expect.fail("Missing theme toggle");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => {
                if (english.querySelector(".site")?.getAttribute("data-theme") !== "dark")
                  toggle.click();
                return localStorage.getItem("signaturekit-theme");
              },
              { timeout: 10000 },
            )
            .toBe("dark"),
        );
        yield* load("pt-BR");
        yield* Effect.promise(() =>
          expect
            .poll(() => frame.contentDocument?.querySelector(".site")?.getAttribute("data-theme"), {
              timeout: 10000,
            })
            .toBe("dark"),
        );
        const reloaded = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        frame.contentWindow?.location.reload();
        yield* Effect.promise(() => reloaded);
        yield* Effect.promise(() =>
          expect
            .poll(() => frame.contentDocument?.querySelector(".site")?.getAttribute("data-theme"), {
              timeout: 10000,
            })
            .toBe("dark"),
        );
      }),
    ).pipe(Effect.timeout("35 seconds")),
  );
}, 40000);

it("keeps snippet text legible in both themes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const savedTheme = localStorage.getItem("signaturekit-theme");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (savedTheme === null) localStorage.removeItem("signaturekit-theme");
            else localStorage.setItem("signaturekit-theme", savedTheme);
          }),
        );
        localStorage.removeItem("signaturekit-theme");
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-contrast-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#home-contrast-test"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector(".home-code pre code")).not.toBeNull(),
        );
        const luminance = (color: string) =>
          (color.match(/[\d.]+/g) ?? [])
            .slice(0, 3)
            .map((channel) => Number(channel) / 255)
            .map((channel) =>
              channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
            )
            .reduce(
              (total, channel, index) => total + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
              0,
            );
        const assertContrast = () => {
          const code = host.querySelector<HTMLElement>(".home-code pre code");
          const codeWindow = code?.closest<HTMLElement>(".home-code");
          if (
            code === null ||
            code === undefined ||
            codeWindow === null ||
            codeWindow === undefined
          )
            return expect.fail("Missing code block");
          expect(getComputedStyle(code).backgroundColor).toBe("rgba(0, 0, 0, 0)");
          const surface = getComputedStyle(codeWindow).backgroundColor;
          const [light, dark] = [luminance(getComputedStyle(code).color), luminance(surface)].sort(
            (left, right) => right - left,
          );
          expect(((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)).toBeGreaterThanOrEqual(7);
          return surface;
        };
        const lightSurface = assertContrast();
        const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Toggle theme"]');
        if (toggle === null) return expect.fail("Missing theme toggle");
        yield* Effect.promise(() => userEvent.click(toggle));
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector(".site")?.getAttribute("data-theme")).toBe("dark"),
        );
        expect(assertContrast()).not.toBe(lightSurface);
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );
}, 25000);

it("generates, marks, navigates, resets and downloads four illustrative PDFs without credentials", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-demo-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#home-demo-test"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "/sign-free" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("Examples ready"),
        );
        expect(host.querySelector(".home-demo")?.textContent).toContain("not a digital signature");
        const run = host.querySelector<HTMLButtonElement>("[data-demo-run]");
        const next = host.querySelector<HTMLButtonElement>("[data-demo-next]");
        const reset = host.querySelector<HTMLButtonElement>("[data-demo-reset]");
        if (run === null || next === null || reset === null)
          return expect.fail("Missing demo controls");
        yield* Effect.promise(() => userEvent.click(run));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("not digital signatures"),
        );
        const names = [
          "Service agreement",
          "Contract amendment",
          "Power of attorney",
          "Terms of adhesion",
        ];
        for (let index = 0; index < names.length; index++) {
          yield* Effect.promise(() =>
            expect
              .poll(() => host.querySelector<HTMLAnchorElement>("[data-demo-download]")?.download)
              .toBe(`${names[index]}.pdf`),
          );
          const link = host.querySelector<HTMLAnchorElement>("[data-demo-download]");
          if (link === null || !link.href.startsWith("blob:"))
            return expect.fail("Missing example download");
          const bytes = yield* Effect.promise(
            async () => new Uint8Array(await (await fetch(link.href)).arrayBuffer()),
          );
          const document = yield* PdfCore.pipe(
            Effect.flatMap((core) => core.document(bytes, { annotationPages: [0] })),
            Effect.provide(pdfCoreBrowserLayer),
          );
          expect(document.pages).toHaveLength(1);
          expect(document.acroForm).toBe(false);
          expect(document.annotations.filter((annotation) => annotation.widget)).toHaveLength(0);
          expect(link.download).toBe(`${names[index]}.pdf`);
          const text = yield* pdfTextOf(bytes);
          expect(text).toContain(names[index]);
          expect(text).toContain("ILLUSTRATIVE MARK");
          expect(text).toContain("NOT A DIGITAL SIGNATURE");
          if (index < names.length - 1) yield* Effect.promise(() => userEvent.click(next));
        }
        expect(host.querySelector("[data-demo-label]")?.textContent).toContain("4 / 4");
        yield* Effect.promise(() => userEvent.click(reset));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("Examples ready"),
        );
        for (let index = names.length - 1; index >= 0; index--) {
          yield* Effect.promise(() =>
            expect
              .poll(() => host.querySelector<HTMLAnchorElement>("[data-demo-download]")?.download)
              .toBe(`${names[index]}.pdf`),
          );
          const link = host.querySelector<HTMLAnchorElement>("[data-demo-download]");
          if (link === null || !link.href.startsWith("blob:"))
            return expect.fail("Missing reset download");
          const bytes = yield* Effect.promise(
            async () => new Uint8Array(await (await fetch(link.href)).arrayBuffer()),
          );
          const text = yield* pdfTextOf(bytes);
          expect(text).toContain(names[index]);
          expect(text).not.toContain("ILLUSTRATIVE MARK");
          if (index > 0) {
            const previous = host.querySelector<HTMLButtonElement>("[data-demo-previous]");
            if (previous === null) return expect.fail("Missing previous control");
            yield* Effect.promise(() => userEvent.click(previous));
          }
        }
      }),
    ).pipe(Effect.timeout("90 seconds")),
  );
}, 95000);

it("releases example URLs and regenerates all documents for the next locale", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "locale-demo-lifecycle";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        const urls = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                Runtime.embed(
                  Runtime.makeApplication({
                    Flags,
                    Model,
                    init,
                    update,
                    view,
                    container: host.querySelector<HTMLElement>("#locale-demo-lifecycle"),
                  }),
                  { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "/sign-free" })) },
                ),
              ),
              (runtime) => Effect.sync(() => runtime.dispose()),
            );
            yield* Effect.promise(() =>
              expect
                .poll(() => host.querySelector("[data-demo-status]")?.textContent, {
                  timeout: 30000,
                })
                .toContain("Examples ready"),
            );
            const next = host.querySelector<HTMLButtonElement>("[data-demo-next]");
            const run = host.querySelector<HTMLButtonElement>("[data-demo-run]");
            if (next === null || run === null) return expect.fail("Missing example controls");
            const items: string[] = [];
            for (let index = 0; index < 4; index++) {
              const link = host.querySelector<HTMLAnchorElement>("[data-demo-download]");
              if (link === null || !link.href.startsWith("blob:"))
                return expect.fail("Missing example URL");
              items.push(link.href);
              if (index < 3) yield* Effect.promise(() => userEvent.click(next));
            }
            yield* Effect.promise(() => userEvent.click(run));
            return items;
          }),
        );
        for (const url of urls) {
          const result = yield* Effect.result(
            Effect.tryPromise({ try: () => fetch(url), catch: () => "revoked" }),
          );
          expect(Result.isFailure(result)).toBe(true);
        }
        yield* Effect.sync(() => {
          const container = document.createElement("div");
          container.id = "locale-demo-lifecycle";
          host.replaceChildren(container);
        });
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#locale-demo-lifecycle"),
              }),
              {
                flags: Effect.succeed(
                  Flags.make({ locale: "pt-BR", path: "/assine-documentos-gratis" }),
                ),
              },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("Exemplos prontos"),
        );
        const next = host.querySelector<HTMLButtonElement>("[data-demo-next]");
        if (next === null) return expect.fail("Missing localized example controls");
        for (const name of [
          "Contrato de serviços",
          "Aditivo contratual",
          "Procuração",
          "Termo de adesão",
        ]) {
          yield* Effect.promise(() =>
            expect
              .poll(() => host.querySelector<HTMLAnchorElement>("[data-demo-download]")?.download)
              .toBe(`${name}.pdf`),
          );
          const link = host.querySelector<HTMLAnchorElement>("[data-demo-download]");
          if (link === null || !link.href.startsWith("blob:"))
            return expect.fail("Missing localized example");
          expect(link.download).toBe(`${name}.pdf`);
          const bytes = yield* Effect.promise(
            async () => new Uint8Array(await (await fetch(link.href)).arrayBuffer()),
          );
          expect(yield* pdfTextOf(bytes)).toContain(name);
          yield* Effect.promise(() => userEvent.click(next));
        }
      }),
    ).pipe(Effect.timeout("90 seconds")),
  );
}, 95000);

it("keeps two real signer instances independent after one is disposed", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const create = (id: string) =>
          Effect.gen(function* () {
            const host = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const element = document.createElement("div");
                const container = document.createElement("div");
                container.id = id;
                element.append(container);
                document.body.append(element);
                return element;
              }),
              (element) => Effect.sync(() => element.remove()),
            );
            const runtime = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Runtime.embed(
                  Runtime.makeApplication({
                    Flags,
                    Model,
                    init,
                    update,
                    view,
                    container: host.querySelector<HTMLElement>(`#${id}`),
                  }),
                  {
                    flags: Effect.succeed(
                      Flags.make({ locale: "pt-BR", path: "/assine-documentos-gratis" }),
                    ),
                  },
                ),
              ),
              (handle) => Effect.sync(() => handle.dispose()),
            );
            return { host, runtime };
          });
        const first = yield* create("signer-isolation-first");
        const second = yield* create("signer-isolation-second");
        const pdf = yield* textPdf([
          { width: 400, height: 300, runs: [{ text: "Independent signer", x: 20, y: 100 }] },
        ]).pipe(Effect.provide(pdfCoreBrowserLayer));
        yield* Effect.promise(() =>
          expect.poll(() => first.host.querySelector("[name=pdf]")).not.toBeNull(),
        );
        yield* Effect.promise(() =>
          expect.poll(() => second.host.querySelector("[name=pdf]")).not.toBeNull(),
        );
        const firstInput = first.host.querySelector<HTMLInputElement>("[name=pdf]");
        const secondInput = second.host.querySelector<HTMLInputElement>("[name=pdf]");
        if (firstInput === null || secondInput === null) return expect.fail("Missing PDF inputs");
        const upload = (input: HTMLInputElement, name: string) => {
          const files = new DataTransfer();
          files.items.add(new File([new Uint8Array(pdf)], name, { type: "application/pdf" }));
          input.files = files.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        upload(firstInput, "first.pdf");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => first.host.querySelector<HTMLImageElement>("[data-preview] img")?.naturalWidth,
              { timeout: 30000 },
            )
            .toBeGreaterThan(0),
        );
        expect(second.host.querySelector("[data-preview] img")).toBeNull();
        upload(secondInput, "second.pdf");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => second.host.querySelector<HTMLImageElement>("[data-preview] img")?.naturalWidth,
              { timeout: 30000 },
            )
            .toBeGreaterThan(0),
        );
        const secondUrl = second.host.querySelector<HTMLImageElement>("[data-preview] img")?.src;
        if (secondUrl === undefined) return expect.fail("Missing second preview URL");
        first.runtime.dispose();
        expect((yield* Effect.promise(() => fetch(secondUrl))).ok).toBe(true);
        expect(secondInput.files?.item(0)?.name).toBe("second.pdf");
      }),
    ).pipe(Effect.timeout("60 seconds")),
  );
}, 65000);

it("keeps the chosen theme through actual HTTP docs and locale links and reload", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const previous = localStorage.getItem("signaturekit-theme");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === null) localStorage.removeItem("signaturekit-theme");
            else localStorage.setItem("signaturekit-theme", previous);
          }),
        );
        localStorage.removeItem("signaturekit-theme");
        const frame = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("iframe");
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        const firstLoad = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        frame.src = "/en-US";
        yield* Effect.promise(() => firstLoad);
        const home = frame.contentDocument;
        if (home === null) return expect.fail("Missing home document");
        expect(new URL(home.URL).pathname).toBe("/en-US");
        const toggle = home.querySelector<HTMLButtonElement>('[aria-label="Toggle theme"]');
        if (toggle === null) return expect.fail("Missing theme toggle");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => {
                if (home.querySelector(".site")?.getAttribute("data-theme") !== "dark")
                  toggle.click();
                return localStorage.getItem("signaturekit-theme");
              },
              { timeout: 15000 },
            )
            .toBe("dark"),
        );
        const docs = home.querySelector<HTMLAnchorElement>('nav a[href="/en-US/docs"]');
        if (docs === null) return expect.fail("Missing docs link");
        const docsLoad = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        docs.click();
        yield* Effect.promise(() => docsLoad);
        const englishDocs = frame.contentDocument;
        if (englishDocs === null) return expect.fail("Missing docs document");
        expect(new URL(englishDocs.URL).pathname).toBe("/en-US/docs");
        yield* Effect.promise(() =>
          expect
            .poll(() => englishDocs.querySelector(".site")?.getAttribute("data-theme"), {
              timeout: 15000,
            })
            .toBe("dark"),
        );
        const languages = englishDocs.querySelector<HTMLButtonElement>("button.language");
        if (languages === null) return expect.fail("Missing language menu");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => {
                if (englishDocs.querySelector('a[lang="pt-BR"]') === null) languages.click();
                return englishDocs.querySelector('a[lang="pt-BR"]');
              },
              { timeout: 15000 },
            )
            .not.toBeNull(),
        );
        const portuguese = englishDocs.querySelector<HTMLAnchorElement>('a[lang="pt-BR"]');
        if (portuguese === null) return expect.fail("Missing Portuguese link");
        expect(new URL(portuguese.href).pathname).toBe("/pt-BR/docs");
        const localeLoad = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        portuguese.click();
        yield* Effect.promise(() => localeLoad);
        expect(new URL(frame.contentDocument?.URL ?? "about:blank").pathname).toBe("/pt-BR/docs");
        yield* Effect.promise(() =>
          expect
            .poll(() => frame.contentDocument?.querySelector(".site")?.getAttribute("data-theme"), {
              timeout: 15000,
            })
            .toBe("dark"),
        );
        const reload = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        frame.contentWindow?.location.reload();
        yield* Effect.promise(() => reload);
        expect(new URL(frame.contentDocument?.URL ?? "about:blank").pathname).toBe("/pt-BR/docs");
        yield* Effect.promise(() =>
          expect
            .poll(() => frame.contentDocument?.querySelector(".site")?.getAttribute("data-theme"), {
              timeout: 15000,
            })
            .toBe("dark"),
        );
      }),
    ).pipe(Effect.timeout("60 seconds")),
  );
}, 65000);

it("emits legacy home analytics through the real browser SDK without private content", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(async () => fetch("/__home_analytics__/reset"));
        posthog.init("local-home-test-token", {
          ...docsPostHogOptions,
          opt_out_useragent_filter: true,
        });
        const doc = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-analytics-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: doc.querySelector<HTMLElement>("#home-analytics-test"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(async () =>
          expect
            .poll(() => doc.querySelector(".home-providers button"), { timeout: 15000 })
            .not.toBeNull(),
        );
        yield* openOverlay(doc, "providers");
        const select = [...doc.querySelectorAll<HTMLButtonElement>(".home-providers button")].find(
          (button) => button.textContent === "DocuSeal",
        );
        if (select === undefined) return expect.fail("Missing provider");
        yield* Effect.promise(async () =>
          expect
            .poll(
              () => {
                if (
                  doc
                    .querySelector(".home-code")
                    ?.textContent?.includes("DocuSealSignatureRequest") !== true
                )
                  select.click();
                return doc.querySelector(".home-code")?.textContent;
              },
              { timeout: 15000 },
            )
            .toContain("DocuSealSignatureRequest"),
        );
        const copy = doc.querySelector<HTMLButtonElement>(".home-code .home-copy");
        if (copy === null) return expect.fail("Missing copy control");
        yield* Effect.promise(async () => userEvent.click(copy));
        yield* Effect.promise(async () =>
          expect
            .poll(() => doc.querySelector(".home-status")?.textContent, { timeout: 15000 })
            .toBe("Copied"),
        );
        const demo = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-analytics-demo";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: demo.querySelector<HTMLElement>("#home-analytics-demo"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "/sign-free" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(async () =>
          expect
            .poll(() => demo.querySelector<HTMLAnchorElement>("[data-demo-download]")?.href, {
              timeout: 30000,
            })
            .toMatch(/^blob:/),
        );
        const download = demo.querySelector<HTMLAnchorElement>("[data-demo-download]");
        if (download === null) return expect.fail("Missing demo download");
        download.click();
        const events = yield* Effect.promise(async () => {
          await expect
            .poll(
              async () =>
                (await (await fetch("/__home_analytics__/events")).text()).includes(
                  "provider_snippet_copied",
                ),
              {
                timeout: 20000,
              },
            )
            .toBe(true);
          return (await fetch("/__home_analytics__/events")).text();
        });
        expect(events.includes("DocuSealSignatureRequest")).toBe(false);
        expect(events.includes("contentBase64")).toBe(false);
        const bodies: unknown = JSON.parse(events);
        const batch = Schema.Array(
          Schema.Struct({
            event: Schema.String,
            properties: Schema.Record(Schema.String, Schema.Unknown),
          }),
        );
        const envelope = Schema.Struct({ batch });
        if (!Schema.is(Schema.Array(Schema.String))(bodies))
          return expect.fail("Invalid receiver response");
        const captured = bodies
          .filter((body) => body.startsWith("[") || body.startsWith("{"))
          .flatMap((body) => {
            const data: unknown = JSON.parse(body);
            if (Schema.is(batch)(data)) return data;
            return Schema.is(envelope)(data) ? data.batch : [];
          });
        const selected = captured.find(
          (event) => event.event === "signaturekit_docs_provider_showcase_selected",
        )?.properties;
        const copied = captured.find(
          (event) => event.event === "signaturekit_docs_provider_snippet_copied",
        )?.properties;
        const downloaded = captured.find(
          (event) => event.event === "signaturekit_docs_auto_sign_demo_downloaded",
        )?.properties;
        expect({ method: selected?.method, provider: selected?.provider }).toEqual({
          method: "tab",
          provider: "DocuSeal",
        });
        expect({ filename: copied?.filename, provider: copied?.provider }).toEqual({
          filename: "docuseal.ts",
          provider: "DocuSeal",
        });
        expect({ document_id: downloaded?.document_id, signed: downloaded?.signed }).toEqual({
          document_id: "doc-contrato",
          signed: false,
        });

        const denial = yield* Effect.promise(() => commands.homeDeniedClipboard());
        expect(denial).toEqual({ permission: "denied", status: "Could not copy." });
        const deniedBodies: unknown = yield* Effect.promise(async () =>
          fetch("/__home_analytics__/events").then((response) => response.json()),
        );
        if (!Schema.is(Schema.Array(Schema.String))(deniedBodies))
          return expect.fail("Invalid receiver response");
        const deniedEvents = deniedBodies
          .filter((body) => body.startsWith("[") || body.startsWith("{"))
          .flatMap((body) => {
            const data: unknown = JSON.parse(body);
            if (Schema.is(batch)(data)) return data;
            return Schema.is(envelope)(data) ? data.batch : [];
          });
        const failed = deniedEvents.find(
          (event) => event.event === "signaturekit_docs_provider_snippet_copy_failed",
        )?.properties;
        expect({ filename: failed?.filename, provider: failed?.provider }).toEqual({
          filename: "assinafy.ts",
          provider: "Assinafy",
        });
      }),
    ).pipe(Effect.timeout("60 seconds")),
  );
}, 65000);

it("opens and closes the language popover with the keyboard", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "language-browser-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#language-browser-test"),
              }),
              {
                flags: Effect.succeed(
                  Flags.make({ locale: "en-US", path: "/search", query: "a & b" }),
                ),
              },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        const trigger = yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector<HTMLButtonElement>(".language"))
            .not.toBeNull()
            .then(() => host.querySelector<HTMLButtonElement>(".language")),
        );
        if (trigger === null) return expect.fail("Missing language trigger");
        yield* Effect.sync(() => trigger.focus());
        yield* Effect.promise(() => userEvent.keyboard("{Enter}"));
        yield* Effect.promise(() =>
          expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true"),
        );
        expect(host.querySelector('a[lang="pt-BR"]')?.getAttribute("href")).toBe(
          "/pt-BR/search?q=a+%26+b",
        );
        yield* Effect.promise(() => userEvent.keyboard("{Escape}"));
        yield* Effect.promise(() =>
          expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false"),
        );
        yield* Effect.promise(() => expect.poll(() => document.activeElement).toBe(trigger));
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );
}, 25000);

it("opens the signer sheet and the providers modal, traps focus, closes on Escape and returns focus", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "home-overlay-test";
            element.append(container);
            document.body.append(element);
            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Runtime.embed(
              Runtime.makeApplication({
                Flags,
                Model,
                init,
                update,
                view,
                container: host.querySelector<HTMLElement>("#home-overlay-test"),
              }),
              { flags: Effect.succeed(Flags.make({ locale: "en-US", path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector('main [data-overlay="signer"]')).not.toBeNull(),
        );
        for (const [kind, title, probe] of [
          ["signer", "Sign a PDF", "[name=pfx]"],
          ["providers", "Providers", ".home-providers"],
        ] satisfies ReadonlyArray<readonly [string, string, string]>) {
          const trigger = yield* openOverlay(host, kind);
          const dialog = host.querySelector<HTMLDialogElement>("#site-overlay");
          if (dialog === null) return expect.fail("Missing overlay");
          expect(dialog.getAttribute("aria-modal")).toBe("true");
          expect(
            document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent,
          ).toBe(title);
          const content = dialog.querySelector(probe);
          expect(content?.closest("[hidden]")).toBeNull();
          yield* Effect.promise(() =>
            expect.poll(() => dialog.contains(document.activeElement)).toBe(true),
          );
          yield* Effect.promise(() => userEvent.keyboard("{Escape}"));
          yield* Effect.promise(() =>
            expect.poll(() => dialog.hasAttribute("open"), { timeout: 10000 }).toBe(false),
          );
          yield* Effect.promise(() => expect.poll(() => document.activeElement).toBe(trigger));
        }
      }),
    ).pipe(Effect.timeout("30 seconds")),
  );
}, 35000);
