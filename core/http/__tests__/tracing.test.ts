import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { SignatureHttpClient, signatureHttpClientLive } from "../src/http";
import { localHttpServer } from "../../../tooling/testing/local-http";
import { recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";

const OkSchema = Schema.Struct({ ok: Schema.Boolean });

const server = localHttpServer(async (request) =>
  request.pathname === "/ok"
    ? { status: 200, headers: { "Content-Type": "application/json" }, body: '{"ok":true}' }
    : { status: 503, headers: { "Content-Type": "text/plain" }, body: "provider down" },
);

describe("SignatureHttpClient tracing", () => {
  it.effect("records a client span with method, server, provider and status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* server;
        const url = new URL(local.baseUrl);
        const { exit, spans } = yield* recordSpans(
          SignatureHttpClient.use((http) =>
            http.requestJson(
              {
                method: "GET",
                url: `${local.baseUrl}/ok?token=secret-token`,
                provider: "example",
                headers: { Authorization: "Bearer secret-token" },
              },
              OkSchema,
              "Ok",
            ),
          ).pipe(Effect.provide(signatureHttpClientLive)),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        const span = spanNamed(spans, "GET");
        expect(span?.kind).toBe(2);
        expect(span?.attributes).toStrictEqual({
          "http.request.method": "GET",
          "http.response.status_code": 200,
          "server.address": url.hostname,
          "server.port": Number(url.port),
          "signature_kit.provider": "example",
        });
        expect(JSON.stringify(spans.map((recorded) => recorded.attributes))).not.toContain(
          "secret-token",
        );
      }),
    ),
  );

  it.effect("marks HTTP status failures as span errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* server;
        const { exit, spans } = yield* recordSpans(
          SignatureHttpClient.use((http) =>
            http.requestVoid({ method: "POST", url: `${local.baseUrl}/down` }),
          ).pipe(Effect.provide(signatureHttpClientLive)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const span = spanNamed(spans, "POST");
        expect(span?.attributes["http.response.status_code"]).toBe(503);
        expect(span?.status.code).toBe(2);
        expect(span?.events.map((event) => event.name)).toContain("exception");
      }),
    ),
  );
});
