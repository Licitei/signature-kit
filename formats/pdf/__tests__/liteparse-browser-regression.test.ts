import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { LiteParseWorkerFactory, renderPdfPagesBrowser } from "../src/liteparse-browser";
import type { LiteParseWorker } from "../src/liteparse-browser";

const injectedLiteParseWorkerLayer = (
  response: unknown,
  timeoutMillis: number,
  onPost: () => void,
  onTerminate: () => void,
) =>
  Layer.succeed(LiteParseWorkerFactory, {
    timeoutMillis,
    create: () =>
      Effect.sync((): LiteParseWorker => {
        let onMessage: ((message: unknown) => void) | undefined;
        return {
          post: () => {
            onPost();
            if (response !== undefined) {
              queueMicrotask(() => onMessage?.({ kind: "success", result: response }));
            }
          },
          subscribe: (nextMessage) => {
            onMessage = nextMessage;
            return () => {
              if (onMessage === nextMessage) onMessage = undefined;
            };
          },
          terminate: onTerminate,
        };
      }),
  });

const screenshot = (pageNum: number, imageBytes: ReadonlyArray<number> = [137, 80, 78, 71]) => ({
  pageNum,
  imageBytes,
});

describe("LiteParse browser boundary", () => {
  it.effect("fails closed on malformed worker success results", () =>
    Effect.gen(function* () {
      const malformedResults = [
        { pageCount: 1, result: { pages: [] } },
        { pageCount: 1, result: { screenshots: [screenshot(1.5)] } },
        { pageCount: 1, result: { screenshots: [screenshot(2)] } },
        { pageCount: 1, result: { screenshots: [screenshot(1, [])] } },
        { pageCount: 1, result: { screenshots: [screenshot(1, [256])] } },
        { pageCount: 2, result: { screenshots: [screenshot(1)] } },
        { pageCount: 2, result: { screenshots: [screenshot(2), screenshot(1)] } },
      ];

      for (const { pageCount, result: malformedResult } of malformedResults) {
        let terminations = 0;
        const result = yield* Effect.result(
          renderPdfPagesBrowser(new Uint8Array([1]), pageCount).pipe(
            Effect.provide(
              injectedLiteParseWorkerLayer(
                malformedResult,
                100,
                () => {},
                () => {
                  terminations += 1;
                },
              ),
            ),
          ),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe("pdf.INVALID_PDF");
          expect(result.failure.operation).toBe("pdf.parse");
        }
        expect(terminations).toBe(1);
      }
    }),
  );

  it.effect("returns complete screenshots in page order", () =>
    Effect.gen(function* () {
      let terminations = 0;
      const pages = yield* renderPdfPagesBrowser(new Uint8Array([1]), 2).pipe(
        Effect.provide(
          injectedLiteParseWorkerLayer(
            { screenshots: [screenshot(1, [1, 2]), screenshot(2, [3])] },
            100,
            () => {},
            () => {
              terminations += 1;
            },
          ),
        ),
      );

      expect(pages).toStrictEqual([screenshot(1, [1, 2]), screenshot(2, [3])]);
      expect(terminations).toBe(1);
    }),
  );

  it.effect("rejects malformed injected worker timeouts before starting a worker", () =>
    Effect.gen(function* () {
      for (const timeoutMillis of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 5001]) {
        let posts = 0;
        const result = yield* Effect.result(
          renderPdfPagesBrowser(new Uint8Array([1]), 1).pipe(
            Effect.provide(
              injectedLiteParseWorkerLayer(
                undefined,
                timeoutMillis,
                () => {
                  posts += 1;
                },
                () => {},
              ),
            ),
          ),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe("pdf.INVALID_PDF");
          expect(result.failure.operation).toBe("pdf.parse");
        }
        expect(posts).toBe(0);
      }
    }),
  );
});
