import { expect, it } from "vitest";
import { Effect } from "effect";
import * as Server from "foldkit/experimental/server";
import { Flags, init, Message, update, view } from "./main";
import { renderPage, prerenderPaths } from "./entry.server";
import { Message as SigningFormMessage } from "./signing-view";

it("renders the canonical signing route in pt-BR and links it from the home page", async () => {
  const route = "/assine-documentos-gratis";
  expect(prerenderPaths).toContain(route);
  expect(prerenderPaths.some((path) => /^\/(en-US|pt-BR)(\/|$)/.test(path))).toBe(false);
  const page = await renderPage(new Request(`https://signaturekit.dev${route}`), "test");
  expect(page._tag).toBe("Rendered");
  const html = JSON.stringify(page);
  expect(html).toContain("Assine PDF com certificado digital A1.");
  expect(html).toContain("Senha do certificado");
  expect(html).not.toContain("Sign documents for free");
  expect(html).not.toContain("Certificate password");
  const home = await renderPage(new Request("https://signaturekit.dev/"), "test");
  expect(JSON.stringify(home)).toContain(`href=\\"${route}\\"`);
});

it("redirects legacy locale-prefixed signing and content URLs permanently", async () => {
  for (const [legacy, target] of [
    ["/pt-BR/assine-documentos-gratis", "/assine-documentos-gratis"],
    ["/en-US/sign-free", "/assine-documentos-gratis"],
    ["/en-US/docs/signing/errors", "/docs/signing/errors"],
    ["/pt-BR", "/"],
    ["/en-US/search?q=certificado", "/search?q=certificado"],
  ]) {
    const result = await renderPage(new Request(`https://signaturekit.dev${legacy}`), "test");
    expect(result._tag, legacy).toBe("Responded");
    if (result._tag === "Responded") {
      expect(result.response.status, legacy).toBe(301);
      const location = new URL(result.response.headers.get("location") ?? "");
      expect(`${location.pathname}${location.search}`, legacy).toBe(target);
    }
  }
});

it("renders unprefixed navigation on signing, documentation and article paths", async () => {
  for (const path of ["/assine-documentos-gratis", "/docs/signing/errors", "/blog", "/changelog"]) {
    const page = JSON.stringify(
      await Effect.runPromise(
        Server.renderToString({ Flags, init, view }, { flags: { path }, buildId: "test" }),
      ),
    );
    for (const href of ["/docs", "/assine-documentos-gratis", "/blog", "/changelog"])
      expect(page, path).toContain(`href=\\"${href}\\"`);
    expect(page, path).not.toMatch(/href=\\"\/(en-US|pt-BR)(\/|\\")/);
    expect(page, path).toContain('"lang":"pt-BR"');
  }
}, 20_000);

it("updates appearance toggles without storing certificate material in the model", () => {
  const initial = init({ path: "/assine-documentos-gratis" }).model;
  const changed = update(
    initial,
    Message.GotSigningFormMessage({
      message: SigningFormMessage.RubricToggled({ checked: true }),
    }),
  ).model;
  expect(changed.signingForm).toEqual({ ...initial.signingForm, rubric: true });
  expect(Object.keys(changed.signingForm).sort()).toEqual([
    "appearance",
    "date",
    "identity",
    "logo",
    "mode",
    "modeTabs",
    "pdf",
    "pfx",
    "rubric",
    "rubricGroup",
    "rubricSource",
  ]);
  expect(JSON.stringify(changed.signingForm)).not.toContain("password");
});
