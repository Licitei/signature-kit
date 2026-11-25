import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { serverAnalyticsLayer } from "../lib/posthog/server";
import { contentPaths, resolveContent } from "./content";
import { createServerComposition, renderDocument, renderPage } from "./entry.server";
import { Message, init, update } from "./main";

describe("Foldkit home", () => {
  it("renders localized landing pages with a link to the 2.0 docs", async () => {
    for (const locale of ["en-US", "pt-BR"]) {
      const result = await renderPage(new Request(`https://signaturekit.dev/${locale}`), "test");
      if (result._tag !== "Rendered") return expect.fail(`Missing ${locale} home`);
      const html = renderDocument(result.application, {
        entryScript: "/entry.js",
        stylesheets: [],
        modulePreloads: [],
      });
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain(`href="/${locale}/docs"`);
      expect(html).toContain("SignatureKit 2.0");
    }
  });

  it("renders localized navigation and preserves the theme toggle", () => {
    const initial = init({ locale: "pt-BR", path: "" }).model;
    expect(update(initial, Message.ThemeToggled()).model.theme).toBe("dark");
    expect(update({ ...initial, theme: "dark" }, Message.ThemeToggled()).model.theme).toBe("light");
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
              new Request(`https://signaturekit.dev/en-US/search?q=${secret}${"x".repeat(250)}`, {
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
});
