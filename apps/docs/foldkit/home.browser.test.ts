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
import { Flags, Model, init, subscriptions, update, view } from "./main";
import { installCommand } from "./home";
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
    const trigger = host.querySelector<HTMLAnchorElement>(`[data-overlay="${kind}"]`);
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

it("copies the install command from the footer in Chromium", async () => {
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
              { flags: Effect.succeed(Flags.make({ path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector(".home-install")).not.toBeNull(),
        );
        const button = host.querySelector<HTMLButtonElement>(".home-install");
        if (button === null) return expect.fail("Missing copy button");
        yield* Effect.promise(() => userEvent.click(button));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector('[role="status"].home-status')?.textContent)
            .toBe("Comando copiado."),
        );
        const text = yield* Effect.promise(() => navigator.clipboard.readText());
        expect(text).toBe(installCommand);
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
              { flags: Effect.succeed(Flags.make({ path: "" })) },
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
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("#site-overlay [data-signing-ready]"), {
              timeout: 30000,
            })
            .not.toBeNull(),
        );
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
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector(".signing-rectangle"), { timeout: 30000 })
            .not.toBeNull(),
        );
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

it("hydrates the server-rendered home and keeps the search overlay interactive", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rendered = yield* Server.renderToString(
          { Flags, init, view },
          {
            flags: { path: "" },
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
      window.__vitest_browser_runner__ = parent.__vitest_browser_runner__;
      import { Flags, Model, init, update, view } from ${JSON.stringify(mainUrl)};
      const container = document.querySelector("[data-foldkit-app]");
      Runtime.hydrate(Runtime.makeApplication({ Flags, Model, init, update, view, container }), { buildId: "home-browser-test" });
    </script></body></html>`;
        yield* Effect.promise(() => loaded);
        const doc = frame.contentDocument;
        if (doc === null) return expect.fail("Missing frame document");
        yield* Effect.promise(() =>
          expect
            .poll(
              () => {
                doc.querySelector<HTMLAnchorElement>('[data-overlay="search"]')?.click();
                return doc.querySelector("dialog[open]") !== null;
              },
              { timeout: 10000 },
            )
            .toBe(true),
        );
      }),
    ).pipe(Effect.timeout("20 seconds")),
  );
}, 25000);

it("keeps documentation code legible", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
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
              { flags: Effect.succeed(Flags.make({ path: "/docs/get-started/quickstart" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector("pre code")).not.toBeNull(),
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
          const code = host.querySelector<HTMLElement>("pre code");
          const codeWindow = code?.closest("pre")?.parentElement;
          if (
            code === null ||
            code === undefined ||
            codeWindow === null ||
            codeWindow === undefined
          )
            return expect.fail("Missing code block");
          expect(getComputedStyle(code).backgroundColor).toBe("rgba(0, 0, 0, 0)");
          const [light, dark] = [
            luminance(getComputedStyle(code).color),
            luminance(getComputedStyle(codeWindow).backgroundColor),
          ].sort((left, right) => right - left);
          expect(((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)).toBeGreaterThanOrEqual(7);
        };
        assertContrast();
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
              { flags: Effect.succeed(Flags.make({ path: "/assine-documentos-gratis" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("Exemplos prontos"),
        );
        expect(host.querySelector(".home-demo")?.textContent).toContain("não é assinatura digital");
        const run = host.querySelector<HTMLButtonElement>("[data-demo-run]");
        const next = host.querySelector<HTMLButtonElement>("[data-demo-next]");
        const reset = host.querySelector<HTMLButtonElement>("[data-demo-reset]");
        if (run === null || next === null || reset === null)
          return expect.fail("Missing demo controls");
        yield* Effect.promise(() => userEvent.click(run));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("Não são assinaturas digitais"),
        );
        const names = [
          "Contrato de serviços",
          "Aditivo contratual",
          "Procuração",
          "Termo de adesão",
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
          expect(text).toContain("MARCA ILUSTRATIVA");
          expect(text).toContain("NOT A DIGITAL SIGNATURE");
          if (index < names.length - 1) yield* Effect.promise(() => userEvent.click(next));
        }
        expect(host.querySelector("[data-demo-label]")?.textContent).toContain("4 / 4");
        yield* Effect.promise(() => userEvent.click(reset));
        yield* Effect.promise(() =>
          expect
            .poll(() => host.querySelector("[data-demo-status]")?.textContent, { timeout: 30000 })
            .toContain("Exemplos prontos"),
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
          expect(text).not.toContain("MARCA ILUSTRATIVA");
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

it("releases example URLs on dispose and regenerates all documents on remount", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("div");
            const container = document.createElement("div");
            container.id = "demo-lifecycle";
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
                    container: host.querySelector<HTMLElement>("#demo-lifecycle"),
                  }),
                  { flags: Effect.succeed(Flags.make({ path: "/assine-documentos-gratis" })) },
                ),
              ),
              (runtime) => Effect.sync(() => runtime.dispose()),
            );
            yield* Effect.promise(() =>
              expect
                .poll(() => host.querySelector("[data-demo-status]")?.textContent, {
                  timeout: 30000,
                })
                .toContain("Exemplos prontos"),
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
          container.id = "demo-lifecycle";
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
                container: host.querySelector<HTMLElement>("#demo-lifecycle"),
              }),
              {
                flags: Effect.succeed(Flags.make({ path: "/assine-documentos-gratis" })),
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
        if (next === null) return expect.fail("Missing remounted example controls");
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
            return expect.fail("Missing remounted example");
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
                    flags: Effect.succeed(Flags.make({ path: "/assine-documentos-gratis" })),
                  },
                ),
              ),
              (handle) => Effect.sync(() => handle.dispose()),
            );
            yield* Effect.promise(() =>
              expect
                .poll(() => host.querySelector("[data-signing-ready]"), { timeout: 30000 })
                .not.toBeNull(),
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

it("emits home analytics through the real browser SDK without private content", async () => {
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
              { flags: Effect.succeed(Flags.make({ path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(async () =>
          expect.poll(() => doc.querySelector(".home-install"), { timeout: 15000 }).not.toBeNull(),
        );
        const copy = doc.querySelector<HTMLButtonElement>(".home-install");
        if (copy === null) return expect.fail("Missing copy control");
        yield* Effect.promise(async () => userEvent.click(copy));
        yield* Effect.promise(async () =>
          expect
            .poll(() => doc.querySelector(".home-status")?.textContent, { timeout: 15000 })
            .toBe("Comando copiado."),
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
              { flags: Effect.succeed(Flags.make({ path: "/assine-documentos-gratis" })) },
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
        const batch = Schema.Array(
          Schema.Struct({
            event: Schema.String,
            properties: Schema.Record(Schema.String, Schema.Unknown),
          }),
        );
        const envelope = Schema.Struct({ batch });
        const capturedEvents = (bodies: unknown) =>
          Schema.is(Schema.Array(Schema.String))(bodies)
            ? bodies
                .filter((body) => body.startsWith("[") || body.startsWith("{"))
                .flatMap((body) => {
                  const data: unknown = JSON.parse(body);
                  if (Schema.is(batch)(data)) return data;
                  return Schema.is(envelope)(data) ? data.batch : [];
                })
            : [];
        const events = yield* Effect.promise(async () => {
          await expect
            .poll(
              async () => {
                const text = await (await fetch("/__home_analytics__/events")).text();
                return (
                  text.includes("install_command_copied") &&
                  text.includes("auto_sign_demo_downloaded")
                );
              },
              { timeout: 20000 },
            )
            .toBe(true);
          return (await fetch("/__home_analytics__/events")).text();
        });
        expect(events.includes(installCommand)).toBe(false);
        const captured = capturedEvents(JSON.parse(events));
        const copied = captured.find(
          (event) => event.event === "signaturekit_docs_install_command_copied",
        )?.properties;
        const downloaded = captured.find(
          (event) => event.event === "signaturekit_docs_auto_sign_demo_downloaded",
        )?.properties;
        expect(copied?.analytics_location).toBe("footer");
        expect({ document_id: downloaded?.document_id, signed: downloaded?.signed }).toEqual({
          document_id: "doc-contrato",
          signed: false,
        });

        const denial = yield* Effect.promise(() => commands.homeDeniedClipboard());
        expect(denial).toEqual({ permission: "denied", status: "Não foi possível copiar." });
        const deniedBodies: unknown = yield* Effect.promise(async () =>
          fetch("/__home_analytics__/events").then((response) => response.json()),
        );
        const failed = capturedEvents(deniedBodies).find(
          (event) => event.event === "signaturekit_docs_install_command_copy_failed",
        )?.properties;
        expect(failed?.analytics_location).toBe("footer");
      }),
    ).pipe(Effect.timeout("60 seconds")),
  );
}, 65000);

it("opens the signer sheet and the search modal, traps focus, closes on Escape and returns focus", async () => {
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
                subscriptions,
                container: host.querySelector<HTMLElement>("#home-overlay-test"),
              }),
              { flags: Effect.succeed(Flags.make({ path: "" })) },
            ),
          ),
          (runtime) => Effect.sync(() => runtime.dispose()),
        );
        yield* Effect.promise(() =>
          expect.poll(() => host.querySelector('main [data-overlay="signer"]')).not.toBeNull(),
        );
        const trigger = yield* openOverlay(host, "signer");
        const dialog = host.querySelector<HTMLDialogElement>("#site-overlay");
        if (dialog === null) return expect.fail("Missing overlay");
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        const titleOf = () =>
          document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent;
        expect(titleOf()).toBe("Assinar PDF");
        expect(dialog.querySelector("[name=pfx]")?.closest("[hidden]")).toBeNull();
        yield* Effect.promise(() =>
          expect.poll(() => dialog.contains(document.activeElement)).toBe(true),
        );
        yield* Effect.promise(() => userEvent.keyboard("{Escape}"));
        yield* Effect.promise(() =>
          expect.poll(() => dialog.hasAttribute("open"), { timeout: 10000 }).toBe(false),
        );
        yield* Effect.promise(() => expect.poll(() => document.activeElement).toBe(trigger));
        yield* Effect.promise(() => userEvent.keyboard("{Control>}k{/Control}"));
        yield* Effect.promise(() =>
          expect.poll(() => dialog.hasAttribute("open"), { timeout: 10000 }).toBe(true),
        );
        expect(titleOf()).toBe("Buscar");
        yield* Effect.promise(() =>
          expect.poll(() => document.activeElement?.getAttribute("name")).toBe("q"),
        );
        yield* Effect.promise(() => userEvent.keyboard("{Escape}"));
        yield* Effect.promise(() =>
          expect.poll(() => dialog.hasAttribute("open"), { timeout: 10000 }).toBe(false),
        );
      }),
    ).pipe(Effect.timeout("30 seconds")),
  );
}, 35000);
