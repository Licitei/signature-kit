import { describe, expect, it } from "vitest";
import { searchDocs } from "./search";
import { renderContent } from "./content";
import { parseContent } from "./content-parse";
import type { HtmlBuilder } from "foldkit/html";
import { renderPage } from "./entry.server";
import { signatureKitErrorCatalog } from "@signature-kit/signatures";
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
        { flags: { path: "/docs" }, buildId: "test" },
      ),
    );
    for (const term of ["unique needle", "12345"]) {
      expect(result.html).toContain(term);
      expect(searchDocs(term, pages).length).toBeGreaterThan(0);
    }
  });

  it("finds titles and body text in the pt-BR corpus without a locale prefix", () => {
    expect(searchDocs("INTRODUÇÃO").some((result) => result.href === "/docs")).toBe(true);
    expect(
      searchDocs("itens do registry").some((result) =>
        result.href.startsWith("/docs/recipes/react-components"),
      ),
    ).toBe(true);
    const accented = searchDocs("certificado");
    expect(accented.length).toBeGreaterThan(0);
    expect(accented.every((result) => result.href.startsWith("/docs"))).toBe(true);
    expect(searchDocs("ASSINATURA")).toEqual(searchDocs("assinatura"));
    const unaccented = searchDocs("servico");
    expect(unaccented.length).toBeGreaterThan(0);
    expect(unaccented).toEqual(searchDocs("serviço"));
  });

  it("uses the rendered explicit heading anchor and bounds unsafe queries", () => {
    expect(
      searchDocs("catálogo de erros").some((result) => result.href.endsWith("#error-catalog")),
    ).toBe(true);
    expect(searchDocs(" ")).toEqual([]);
    expect(searchDocs("x".repeat(201))).toEqual([]);
    expect(searchDocs("<script>alert(1)</script>")).toEqual([]);
  });

  it("indexes visible attributes and the generated catalog with real anchors", async () => {
    const steps = searchDocs("Instale os pacotes");
    const step = steps.find(
      (result) =>
        result.heading === "Instale os pacotes" &&
        result.href.startsWith("/docs/get-started/installation"),
    );
    expect(step).toBeDefined();
    if (step !== undefined) {
      const [path, anchor] = step.href.split("#");
      const page = await renderPage(new Request(`https://signaturekit.dev${path}`), "test");
      expect(page._tag).toBe("Rendered");
      if (page._tag === "Rendered") {
        expect(page.application.html).toContain("Instale os pacotes");
        if (anchor !== undefined && anchor.length > 0)
          expect(page.application.html).toContain(`id="${decodeURIComponent(anchor)}"`);
      }
    }
    expect(searchDocs("Verificação local não é validade jurídica").length).toBeGreaterThan(0);
    expect(searchDocs("Carregue um A1, leia a identidade").length).toBeGreaterThan(0);
    const entry = signatureKitErrorCatalog[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const match = searchDocs(entry.code).find((result) =>
      result.href.includes("/signing/errors#err-"),
    );
    expect(match).toBeDefined();
    if (match === undefined) return;
    const [path, anchor] = match.href.split("#");
    const page = await renderPage(new Request(`https://signaturekit.dev${path}`), "test");
    expect(page._tag).toBe("Rendered");
    if (page._tag === "Rendered")
      expect(page.application.html).toContain(`id="${decodeURIComponent(anchor ?? "")}"`);
  }, 20_000);

  it("updates the single model and recalculates results", async () => {
    const initial = init({ path: "/search" }).model;
    const changed = update(initial, Message.QueryChanged({ value: "configuração & a/b" })).model;
    expect(changed.query).toBe("configuração & a/b");
    expect(update(changed, Message.SearchSubmitted()).model.results).toEqual(
      searchDocs(changed.query),
    );
    const certificate = update(initial, Message.QueryChanged({ value: "certificado" })).model;
    expect(certificate.results.length).toBeGreaterThan(0);
    const rendered = await Effect.runPromise(
      Server.renderToString(
        { Flags, init: () => ({ model: certificate }), view },
        { flags: { path: "/search" }, isHydratable: false },
      ),
    );
    expect(rendered.html).toContain('action="/search"');
    expect(rendered.html).toContain('value="certificado"');
    expect(rendered.html).not.toMatch(/href="\/(en-US|pt-BR)\//);
    for (const result of certificate.results.slice(0, 3))
      expect(rendered.html).toContain(`href="${result.href}"`);
    expect(init({ path: "/search", query: changed.query }).model.results).toEqual(
      searchDocs(changed.query),
    );
  });

  it("bounds and escapes SSR query flags", async () => {
    const malicious = "</script><script>alert(1)</script>";
    const page = await renderPage(
      new Request(`https://signaturekit.dev/search?q=${encodeURIComponent(malicious)}`),
      "test",
    );
    expect(page._tag).toBe("Rendered");
    if (page._tag === "Rendered") expect(page.application.html).not.toContain(malicious);
    const long = await renderPage(
      new Request(`https://signaturekit.dev/search?q=${"x".repeat(201)}`),
      "test",
    );
    expect(JSON.stringify(long)).not.toContain("x".repeat(201));
  });

  it("renders a GET search and results on the server", async () => {
    const result = JSON.stringify(
      await renderPage(
        new Request("https://signaturekit.dev/search?q=cat%C3%A1logo%20de%20erros"),
        "test",
      ),
    );
    expect(result).toContain("Buscar na documentação");
    expect(result).toContain("#error-catalog");
    expect(result).toContain('name=\\"q\\"');
    const empty = JSON.stringify(
      await renderPage(new Request("https://signaturekit.dev/search"), "test"),
    );
    expect(empty).toContain("Digite um termo para buscar.");
  });
});

it("centres the excerpt on the first match and drops duplicate headings", () => {
  const filler = "palavra ".repeat(40);
  const page = parseContent(
    `---\ntitle: Guia\n---\n\n## Assinar\n\n${filler}certificado final.\n\n## Assinar\n\ncertificado de novo.\n`,
  );
  const results = searchDocs("certificado", [{ slug: "guia", page }]);
  expect(results.filter((result) => result.heading === "Assinar")).toHaveLength(1);
  expect(results[0]?.excerpt.startsWith("…")).toBe(true);
  expect(results[0]?.excerpt).toContain("certificado final");
});
