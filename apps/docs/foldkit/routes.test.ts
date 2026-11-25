import { describe, expect, it } from "vitest";
import { homeRoute, legacyLocaleRedirect, pageRoute, parsePublicUrl } from "./routes";
import { prerenderPaths, renderPage } from "./entry.server";

describe("public routes", () => {
  it("round trips the prerender inventory and encoded paths", () => {
    for (const path of [
      ...prerenderPaths,
      pageRoute({ path: "blog/tags/s%C3%A3o-paulo-%26-100%25" }),
    ]) {
      const route = parsePublicUrl(`https://signaturekit.dev${path}?q=a+%26+b`);
      expect(route, path).toBeDefined();
      if (route === undefined) continue;
      expect(route._tag === "Home" ? homeRoute(route) : pageRoute(route)).toBe(path);
    }
    expect(homeRoute({})).toBe("/");
    expect(pageRoute({ path: "docs" })).toBe("/docs");
  });

  it("rejects noncanonical paths", () => {
    for (const path of ["//docs", "/docs/"]) {
      expect(parsePublicUrl(`https://signaturekit.dev${path}`), path).toBeUndefined();
    }
  });

  it("maps legacy locale prefixes to unprefixed paths", () => {
    expect(legacyLocaleRedirect("/pt-BR")).toBe("/");
    expect(legacyLocaleRedirect("/en-US/")).toBe("/");
    expect(legacyLocaleRedirect("/pt-BR/docs/get-started")).toBe("/docs/get-started");
    expect(legacyLocaleRedirect("/en-US/sign-free")).toBe("/assine-documentos-gratis");
    expect(legacyLocaleRedirect("/docs")).toBeUndefined();
    expect(legacyLocaleRedirect("/fr-FR/docs")).toBeUndefined();
  });

  it("redirects legacy locale URLs permanently and preserves the query", async () => {
    for (const [from, to] of [
      ["/en-US", "/"],
      ["/pt-BR/docs", "/docs"],
      ["/en-US/search?q=a+%26+b", "/search?q=a+%26+b"],
      ["/en-US/sign-free", "/assine-documentos-gratis"],
    ]) {
      const response = await renderPage(new Request(`https://signaturekit.dev${from}`), "test");
      expect(response._tag, from).toBe("Responded");
      if (response._tag !== "Responded") continue;
      expect(response.response.status, from).toBe(301);
      expect(response.response.headers.get("location"), from).toBe(`https://signaturekit.dev${to}`);
    }
  });

  it("preserves public routing and rejects unknown pages at the server boundary", async () => {
    for (const path of ["/", "/search?q=a+%26+b", "/assine-documentos-gratis", "/docs"]) {
      const response = await renderPage(new Request(`https://signaturekit.dev${path}`), "test");
      expect(response._tag, path).toBe("Rendered");
    }
    const response = await renderPage(new Request("https://signaturekit.dev/not-a-page"), "test");
    expect(response._tag).toBe("Responded");
    if (response._tag === "Responded") expect(response.response.status).toBe(404);
  }, 20_000);
});
