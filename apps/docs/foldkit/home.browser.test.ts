import "./styles/fonts";
import { Effect } from "effect";
import { Runtime } from "foldkit";
import * as Server from "foldkit/experimental/server";
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { Flags, Model, init, update, view } from "./main";

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
