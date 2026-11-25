import { Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TimeoutMillisSchema } from "./cms/config.js";
import { EvidenceFetchError } from "./validation/config.js";
import type { EvidenceOperation } from "./validation/config.js";
import { EvidenceFetcher } from "./validation/fetcher.js";

export { EvidenceFetcher, EvidenceFetchError };
export { requestTimestampForImprint } from "./cms/timestamp.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const transientStatuses = new Set([408, 429, 502, 503, 504]);

export const evidenceFetcherHttpLayer = Layer.effect(
  EvidenceFetcher,
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const fetchEvidence = Effect.fn(function* (
      operation: EvidenceOperation,
      address: string,
      request: Uint8Array | undefined,
      timeoutMillis: number = 15_000,
    ) {
      const timeout = yield* Schema.decodeUnknownEffect(TimeoutMillisSchema)(timeoutMillis).pipe(
        Effect.mapError(() => new EvidenceFetchError({ code: "invalidRequest", operation })),
      );
      if (!URL.canParse(address))
        return yield* new EvidenceFetchError({ code: "invalidUrl", operation });
      const url = new URL(address);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
        return yield* new EvidenceFetchError({ code: "invalidUrl", operation });
      }
      const httpRequest =
        operation === "crl"
          ? HttpClientRequest.get(url, { accept: "application/pkix-crl" })
          : HttpClientRequest.post(url, {
              accept:
                operation === "ocsp" ? "application/ocsp-response" : "application/timestamp-reply",
            }).pipe(
              HttpClientRequest.bodyUint8Array(
                new Uint8Array(request ?? []),
                operation === "ocsp" ? "application/ocsp-request" : "application/timestamp-query",
              ),
            );
      if (
        operation !== "crl" &&
        (request === undefined || request.length === 0 || request.length > MAX_RESPONSE_BYTES)
      ) {
        return yield* new EvidenceFetchError({ code: "invalidRequest", operation });
      }
      const exchange = Effect.scoped(
        Effect.gen(function* () {
          const response = yield* client.execute(httpRequest).pipe(
            Effect.withTracerEnabled(false),
            Effect.mapError(
              ({ reason }) =>
                new EvidenceFetchError({
                  code: reason._tag === "TransportError" ? "transport" : "invalidRequest",
                  operation,
                }),
            ),
          );
          yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
          if (response.status < 200 || response.status >= 300) {
            return yield* new EvidenceFetchError({
              code: "status",
              operation,
              status: response.status,
            });
          }
          const parts: Uint8Array[] = [];
          const length = yield* response.stream.pipe(
            Stream.mapError(() => new EvidenceFetchError({ code: "response", operation })),
            Stream.runFoldEffect(
              () => 0,
              (total, part) => {
                const next = total + part.length;
                if (next > MAX_RESPONSE_BYTES)
                  return Effect.fail(new EvidenceFetchError({ code: "response", operation }));
                parts.push(part);
                return Effect.succeed(next);
              },
            ),
          );
          if (length === 0) return yield* new EvidenceFetchError({ code: "response", operation });
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          return bytes;
        }),
      );
      return yield* exchange.pipe(
        Effect.retry({
          times: 2,
          schedule: Schedule.exponential(Duration.millis(100)),
          while: ({ code, status }) =>
            code === "transport" ||
            (code === "status" && status !== undefined && transientStatuses.has(status)),
        }),
        Effect.timeoutOrElse({
          duration: Duration.millis(timeout),
          orElse: () => Effect.fail(new EvidenceFetchError({ code: "timeout", operation })),
        }),
        Effect.withSpan(httpRequest.method, {
          kind: "client",
          attributes: { "http.request.method": httpRequest.method, "server.address": url.hostname },
        }),
      );
    });
    return EvidenceFetcher.of({
      ocsp: (url, request, timeoutMillis) => fetchEvidence("ocsp", url, request, timeoutMillis),
      crl: (url, timeoutMillis) => fetchEvidence("crl", url, undefined, timeoutMillis),
      timestamp: (url, request, timeoutMillis) =>
        fetchEvidence("timestamp", url, request, timeoutMillis),
    });
  }),
);
