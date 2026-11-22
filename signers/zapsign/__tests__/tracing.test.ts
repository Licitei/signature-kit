import { signatureHttpClientLive } from "@signature-kit/http";
import { describe, expect, it } from "@effect/vitest";
import * as Provider from "alchemy/Provider";
import { Effect, Exit, Redacted } from "effect";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { ZapSignSignatureRequest, getZapSignSignatureRequest, providers } from "../src/index";
import type { ZapSignProviderOptions, ZapSignDocumentProps } from "../src/index";
import { reconcileResourceProps } from "../../__tests__/alchemy-provider";
import { localHttpServer } from "../../../tooling/testing/local-http";
import { childSpans, recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";

const SECRET = "zapsign-tracing-secret";
const EMAIL = "tracing-signer@example.org";

const options = (baseUrl: string): ZapSignProviderOptions => ({
  apiToken: Redacted.make(SECRET),
  baseUrl,
});

const props = (): ZapSignDocumentProps => ({
  title: "SignatureKit tracing",
  documents: [
    {
      fileName: "tracing.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4\n%tracing\n").toString("base64"),
    },
  ],
  recipients: [
    {
      name: "Tracing Signer",
      email: EMAIL,
    },
  ],
  send: false,
});

const descendants = (
  spans: ReadonlyArray<ReadableSpan>,
  parent: ReadableSpan | undefined,
): ReadonlyArray<ReadableSpan> =>
  childSpans(spans, parent).flatMap((child) => [child, ...descendants(spans, child)]);

describe("ZapSign tracing", () => {
  it.effect("records the get span with the mapped state and a nested HTTP span", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* localHttpServer(async (request) =>
          request.method === "GET"
            ? {
                status: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: "req-1" }),
              }
            : { status: 404, body: "not found" },
        );
        const { exit, spans } = yield* recordSpans(
          getZapSignSignatureRequest(options(local.baseUrl), "req-1").pipe(
            Effect.provide(signatureHttpClientLive),
          ),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        const span = spanNamed(spans, "zapsign.getSignatureRequest");
        expect(span?.attributes).toMatchObject({
          "signature_kit.provider": "zapsign",
          "signature_kit.signature_request.state": Exit.isSuccess(exit) ? exit.value.state : "",
        });
        expect(childSpans(spans, span).map((child) => child.name)).toContain("GET");
      }),
    ),
  );

  it.effect("marks reconcile as failed when the upstream fails without leaking secrets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* localHttpServer(async () => ({ status: 500, body: "provider down" }));
        const { exit, spans } = yield* recordSpans(
          Effect.gen(function* () {
            const provider = yield* Provider.findProvider(ZapSignSignatureRequest);
            return yield* provider.reconcile(reconcileResourceProps("zapsign-tracing", props()));
          }).pipe(
            Effect.provide(providers(options(local.baseUrl))),
            Effect.provide(signatureHttpClientLive),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const span = spanNamed(spans, "zapsign.reconcile");
        expect(span?.status.code).toBe(2);
        expect(span?.attributes).toMatchObject({
          "signature_kit.provider": "zapsign",
          "signature_kit.document_count": 1,
          "signature_kit.signer_count": 1,
        });
        expect(
          descendants(spans, span).some(
            (child) => child.attributes["http.response.status_code"] === 500,
          ),
        ).toBe(true);
        const attributes = JSON.stringify(spans.map((recorded) => recorded.attributes));
        expect(attributes).not.toContain(SECRET);
        expect(attributes).not.toContain(EMAIL);
      }),
    ),
  );
});
