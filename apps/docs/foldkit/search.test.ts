import { Popover } from "@foldkit/ui";
import { describe, expect, it } from "vitest";
import { searchDocs } from "./search";
import { parseContent, renderContent } from "./content";
import type { HtmlBuilder } from "foldkit/html";
import { renderPage } from "./entry.server";
import { Flags, init, Message, update, view } from "./main";
import { Effect } from "effect";
import * as Server from "foldkit/experimental/server";

describe("documentation search", () => {
  it("indexes visible literal expressions rendered by native SSR", async () => {
    const page = parseContent(
      '---\ntitle: Fixture\n---\n\nBefore {"unique needle"} after\n\n{12345}',
    );
    const pages = [{ slug: "fixture", page }];
    const result = await Effect.runPromise(
      Server.renderToString(
        {
          Flags,
          init,
          view: (_model: object, h: HtmlBuilder<never>) => ({
            title: page.title,
            body: h.main([], renderContent(page.nodes, h)),
          }),
        },
        { flags: { locale: "en-US", path: "/docs" }, buildId: "test" },
      ),
    );
    for (const term of ["unique needle", "12345"]) {
      expect(result.html).toContain(term);
      expect(searchDocs("en-US", term, pages).length).toBeGreaterThan(0);
    }
  });

  it("finds titles and accent-insensitive body text in the selected locale", () => {
    expect(searchDocs("en-US", "SignatureKit 2.0").some(({ href }) => href === "/en-US/docs")).toBe(
      true,
    );
    const results = searchDocs("pt-BR", "servicos");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(({ href }) => href.startsWith("/pt-BR/docs"))).toBe(true);
    expect(results).toEqual(searchDocs("pt-BR", "serviços"));
  });

  it("uses the rendered explicit heading anchor and bounds unsafe queries", () => {
    expect(
      searchDocs("pt-BR", "requisitos do runtime").some((result) =>
        result.href.endsWith("#runtime-requirements"),
      ),
    ).toBe(true);
    expect(searchDocs("en-US", " ")).toEqual([]);
    expect(searchDocs("en-US", "x".repeat(201))).toEqual([]);
    expect(searchDocs("en-US", "<script>alert(1)</script>")).toEqual([]);
  });

  it("indexes callout and step titles in documentation content", () => {
    const page = parseContent(
      '---\ntitle: Fixture\n---\n\n<Callout title="Unique callout">Body</Callout>\n\n<Steps><Step title="Unique step">Body</Step></Steps>',
    );
    const pages = [{ slug: "fixture", page }];
    expect(searchDocs("en-US", "unique callout", pages)[0]?.href).toBe("/en-US/docs/fixture");
    expect(searchDocs("en-US", "unique step", pages)[0]?.heading).toBe("Unique step");
  });

  it("updates the single model and recalculates results for the locale", async () => {
    const initial = init({ locale: "pt-BR", path: "/search" }).model;
    const changed = update(initial, Message.QueryChanged({ value: "configuração & a/b" })).model;
    expect(changed.query).toBe("configuração & a/b");
    expect(update(changed, Message.SearchSubmitted()).model.results).toEqual(
      searchDocs("pt-BR", changed.query),
    );
    const toggled = update(
      changed,
      Message.GotLanguagePopoverMessage({ message: Popover.Message.RequestedOpen() }),
    ).model;
    expect(toggled.languagePopover.isOpen).toBe(true);
    const rendered = await Effect.runPromise(
      Server.renderToString(
        { Flags, init: () => ({ model: toggled }), view },
        { flags: { locale: "pt-BR", path: "/search" }, isHydratable: false },
      ),
    );
    expect(rendered.html).toContain("/en-US/search?q=configura%C3%A7%C3%A3o+%26+a%2Fb");
    expect(rendered.html).toContain('aria-current="page"');
    expect(init({ locale: "en-US", path: "/search", query: changed.query }).model.results).toEqual(
      searchDocs("en-US", changed.query),
    );
  });

  it("bounds and escapes SSR query flags", async () => {
    const malicious = "</script><script>alert(1)</script>";
    const page = await renderPage(
      new Request(`https://signaturekit.dev/en-US/search?q=${encodeURIComponent(malicious)}`),
      "test",
    );
    expect(page._tag).toBe("Rendered");
    if (page._tag === "Rendered") expect(page.application.html).not.toContain(malicious);
    const long = await renderPage(
      new Request(`https://signaturekit.dev/en-US/search?q=${"x".repeat(201)}`),
      "test",
    );
    expect(JSON.stringify(long)).not.toContain("x".repeat(201));
  });

  it("renders a localized GET search and results on the server", async () => {
    const result = JSON.stringify(
      await renderPage(
        new Request("https://signaturekit.dev/pt-BR/search?q=requisitos%20do%20runtime"),
        "test",
      ),
    );
    expect(result).toContain("Buscar na documentação");
    expect(result).toContain("#runtime-requirements");
    expect(result).toContain('name=\\"q\\"');
    const empty = JSON.stringify(
      await renderPage(new Request("https://signaturekit.dev/en-US/search"), "test"),
    );
    expect(empty).toContain("Enter a search term");
  });
});
