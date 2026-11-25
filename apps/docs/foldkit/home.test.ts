import { describe, expect, it } from "vitest";
import { Effect, Fiber, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { serverAnalyticsLayer } from "../lib/posthog/server";
import { contentPaths, resolveContent } from "./content";
import { createServerComposition, renderDocument, renderPage } from "./entry.server";
import { Message, init, update } from "./main";
import { ExpireHomeCopy, installCommand } from "./home";

describe("Foldkit home", () => {
  it("renders each home section and metadata on the server", async () => {
    const assets = { entryScript: "/entry.js", stylesheets: [], modulePreloads: [] };
    const result = await renderPage(new Request("https://signaturekit.dev/"), "test");
    if (result._tag !== "Rendered") return expect.fail("Missing home");
    const html = renderDocument(result.application, assets);
    expect(html).toContain("Assinatura digital com certificado A1.");
    expect(html).toContain('lang="pt-BR"');
    for (const id of ["assinar", "site-footer"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="auto-sign"');
    expect(html).not.toContain("hreflang");
    expect(html.split(installCommand)).toHaveLength(3);
    expect(html).toContain('rel="canonical" href="https://signaturekit.dev/"');
    expect(html).toContain('data-overlay="signer"');
    expect(html).toContain('href="/assine-documentos-gratis"');
    expect(html).not.toContain('id="provedores"');
    expect(html).not.toContain("/landing/clicksign.svg");
    for (const href of [
      "/blog",
      "/changelog",
      "/docs/get-started/quickstart",
      "https://licitei.com.br",
      "https://github.com/Licitei/signature-kit",
    ])
      expect(html).toContain(`href="${href}"`);
    expect(html).toContain("Apoiado pela");
    expect(html).not.toContain("Não tem certificado A1?");
    expect(html).toContain("CC BY-SA 4.0");
    expect(html).not.toContain("en-US");
  });
  it("renders the Portuguese signing landing and structured data", async () => {
    const result = await renderPage(
      new Request("https://signaturekit.dev/assine-documentos-gratis"),
      "test",
    );
    if (result._tag !== "Rendered") return expect.fail("Missing signing landing");
    const html = renderDocument(result.application, {
      entryScript: "/entry.js",
      stylesheets: [],
      modulePreloads: [],
    });
    for (const text of [
      "Quatro passos, tudo no navegador.",
      "Sem upload do PDF",
      "Precisa de cadastro?",
      "Funciona com A3?",
      "/docs/a1-signing/browser-pdf-flow",
      'id="assinar"',
      'name="pfx"',
    ])
      expect(html).toContain(text);
    const match = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html);
    if (match?.[1] === undefined) return expect.fail("Missing JSON-LD");
    const data: unknown = JSON.parse(match[1]);
    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "SoftwareApplication",
          url: "https://signaturekit.dev/assine-documentos-gratis",
        },
        {
          "@type": "HowTo",
          step: expect.arrayContaining([
            expect.objectContaining({ name: "Envie o PDF" }),
            expect.objectContaining({ name: "Baixe assinado" }),
          ]),
        },
        {
          "@type": "FAQPage",
          mainEntity: expect.arrayContaining([
            expect.objectContaining({ name: "Funciona com A3?" }),
          ]),
        },
      ],
    });
  });
  it("sends only bounded search dimensions through the real analytics transport", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const received: string[] = [];
          const receiver = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((request, response) => {
                const chunks: Uint8Array[] = [];
                request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
                request.on("end", () => {
                  const body = Buffer.concat(chunks);
                  received.push(
                    (request.headers["content-encoding"] === "gzip"
                      ? gunzipSync(body)
                      : body
                    ).toString(),
                  );
                  response.writeHead(200).end("{}");
                });
              }).listen(0, "127.0.0.1"),
            ),
            (server) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                  }),
              ).pipe(Effect.timeout("3 seconds"), Effect.orDie),
          );
          yield* Effect.promise(() => once(receiver, "listening"));
          const address = receiver.address();
          if (address === null || typeof address === "string")
            return expect.fail("Missing analytics receiver");
          const server = createServerComposition(
            { paths: contentPaths, resolve: resolveContent },
            serverAnalyticsLayer({
              token: "local-test-token",
              host: `http://127.0.0.1:${address.port}`,
            }),
          );
          const secret = "private-search-content";
          const result = yield* Effect.promise(() =>
            server.renderPage(
              new Request(`https://signaturekit.dev/search?q=${secret}${"x".repeat(250)}`, {
                headers: {
                  referer: "https://private.example/secret",
                  "user-agent": "private-agent",
                },
              }),
              "test",
            ),
          );
          expect(result._tag).toBe("Rendered");
          expect(received).toHaveLength(1);
          const payload = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              batch: Schema.Array(
                Schema.Struct({
                  event: Schema.String,
                  properties: Schema.Record(Schema.String, Schema.Unknown),
                }),
              ),
            }),
          )(JSON.parse(received[0] ?? ""));
          expect(payload.batch[0]?.event).toContain("search_requested");
          expect(payload.batch[0]?.properties).toMatchObject({
            query_present: true,
            query_length: 200,
          });
          expect(JSON.stringify(payload)).not.toContain(secret);
          expect(JSON.stringify(payload)).not.toContain("private.example");
          expect(JSON.stringify(payload)).not.toContain("private-agent");
        }),
      ).pipe(Effect.timeout("15 seconds")),
    );
  }, 20000);
  it("records copy success or failure", () => {
    const initial = init({ path: "" }).model;
    const requested = update(initial, Message.HomeCopyRequested()).model;
    expect(requested.homeCopyRequest).toBe(initial.homeCopyRequest + 1);
    const ok = update(
      requested,
      Message.HomeCopyFinished({ request: requested.homeCopyRequest, ok: true }),
    ).model;
    expect(ok.homeCopied).toBe(true);
    expect(ok.copyToast.entries.at(-1)?.payload.text).toBe("Comando copiado.");
    const failed = update(
      requested,
      Message.HomeCopyFinished({ request: requested.homeCopyRequest, ok: false }),
    ).model;
    expect(failed.homeCopied).toBe(false);
    expect(failed.copyToast.entries.at(-1)?.payload.text).toBe("Não foi possível copiar.");
  });
  effectIt.effect("expires current feedback and ignores stale copies and timers", () =>
    Effect.gen(function* () {
      const initial = init({ path: "" }).model;
      const first = update(initial, Message.HomeCopyRequested()).model;
      const second = update(first, Message.HomeCopyRequested()).model;
      const old = Message.HomeCopyFinished({ request: first.homeCopyRequest, ok: true });
      expect(update(second, old).model.homeCopied).toBe(false);
      const completed = update(
        second,
        Message.HomeCopyFinished({ request: second.homeCopyRequest, ok: true }),
      ).model;
      expect(completed.homeCopied).toBe(true);
      const fiber = yield* Effect.forkChild(
        ExpireHomeCopy({ request: second.homeCopyRequest }).effect,
      );
      yield* TestClock.adjust("1800 millis");
      const expired = yield* Fiber.join(fiber);
      const next = update(completed, Message.HomeCopyRequested()).model;
      const nextDone = update(
        next,
        Message.HomeCopyFinished({ request: next.homeCopyRequest, ok: true }),
      ).model;
      expect(update(nextDone, expired).model.homeCopied).toBe(true);
      expect(update(completed, expired).model.homeCopied).toBe(false);
    }),
  );
});
