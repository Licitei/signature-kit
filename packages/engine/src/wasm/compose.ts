import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { ComposeRuntime } from "../compose.js";
import { ComposeError } from "../composition/config.js";
import type { ComposeFont } from "../composition/config.js";

const wasm = new URL("./compose.wasm", import.meta.url);
const Allocate = Schema.declare(
  (value): value is (length: number) => number => typeof value === "function",
);
const Run = Schema.declare(
  (value): value is (address: number, length: number) => number => typeof value === "function",
);
const Free = Schema.declare(
  (value): value is (address: number, length: number) => void => typeof value === "function",
);
const WasmExports = Schema.Struct({
  memory: Schema.instanceOf(WebAssembly.Memory),
  pdf_compose_alloc: Allocate,
  pdf_compose_free: Free,
  pdf_compose_run: Run,
});
const defaultFonts = Effect.gen(function* () {
  const { bold, italic, medium, regular } = yield* Effect.tryPromise({
    try: () => import("./compose-fonts.mjs"),
    catch: () =>
      new ComposeError({ code: "assetLoadFailed", reason: "Could not load the bundled fonts" }),
  });
  const sources = [
    { weight: 400, style: "normal", source: regular },
    { weight: 500, style: "normal", source: medium },
    { weight: 700, style: "normal", source: bold },
    { weight: 400, style: "italic", source: italic },
  ] satisfies ReadonlyArray<Pick<ComposeFont, "weight" | "style"> & { source: string }>;
  return yield* Effect.forEach(sources, ({ source, ...face }) =>
    Result.match(Base64.decode(source), {
      onSuccess: (bytes) => Effect.succeed({ ...face, family: "Plex Sans", bytes }),
      onFailure: () =>
        Effect.fail(
          new ComposeError({
            code: "assetLoadFailed",
            reason: "The bundled font could not be decoded",
          }),
        ),
    }),
  );
});

const instantiate = Effect.fn(function* (
  load: Effect.Effect<ArrayBuffer | Uint8Array<ArrayBuffer>, ComposeError>,
) {
  const bytes = yield* load;
  const { instance } = yield* Effect.tryPromise({
    try: () => WebAssembly.instantiate(bytes),
    catch: () =>
      new ComposeError({ code: "assetLoadFailed", reason: "Could not instantiate compose.wasm" }),
  });
  return yield* Schema.decodeUnknownEffect(WasmExports)(instance.exports).pipe(
    Effect.mapError(
      () => new ComposeError({ code: "assetLoadFailed", reason: "Invalid compose.wasm exports" }),
    ),
  );
});

const make = (load: Effect.Effect<ArrayBuffer | Uint8Array<ArrayBuffer>, ComposeError>) =>
  Layer.effect(
    ComposeRuntime,
    Effect.gen(function* () {
      const fonts = yield* Effect.cached(defaultFonts);
      const exports = yield* Effect.cached(instantiate(load));
      return ComposeRuntime.of({
        fonts,
        render: Effect.fn(function* (request) {
          if (request.length > 128 * 1024 * 1024) {
            return yield* new ComposeError({
              code: "invalidDocument",
              reason: "Compose payload exceeds 128 MiB",
            });
          }
          const { memory, pdf_compose_alloc, pdf_compose_free, pdf_compose_run } = yield* exports;
          const input = yield* Effect.acquireRelease(
            Effect.try({
              try: () => Number(pdf_compose_alloc(request.length)),
              catch: () =>
                new ComposeError({ code: "wasmFailed", reason: "Compose allocation failed" }),
            }),
            (pointer) => Effect.sync(() => pdf_compose_free(pointer, request.length)),
          );
          new Uint8Array(memory.buffer, input, request.length).set(request);
          const result = yield* Effect.try({
            try: () => Number(pdf_compose_run(input, request.length)),
            catch: () =>
              new ComposeError({ code: "wasmFailed", reason: "Compose execution trapped" }),
          });
          if (result === 0)
            return yield* new ComposeError({
              code: "wasmFailed",
              reason: "Compose returned no output",
            });
          const header = new DataView(memory.buffer, result, 8);
          const status = header.getUint32(0, true);
          const length = header.getUint32(4, true);
          const body = yield* Effect.acquireUseRelease(
            Effect.succeed(result),
            (pointer) =>
              Effect.sync(() => new Uint8Array(memory.buffer, pointer + 8, length).slice()),
            (pointer) => Effect.sync(() => pdf_compose_free(pointer, length + 8)),
          );
          if (status !== 0) {
            return yield* new ComposeError({
              code: "composeFailed",
              status,
              reason: new TextDecoder().decode(body),
            });
          }
          return body;
        }, Effect.scoped),
      });
    }),
  );

export const composeBrowserLayer = make(
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(wasm, { signal });
      return response.ok ? response.arrayBuffer() : Promise.reject(response.status);
    },
    catch: () =>
      new ComposeError({ code: "assetLoadFailed", reason: "Could not load compose.wasm" }),
  }),
);

export const composeFileLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return make(
      path.fromFileUrl(wasm).pipe(
        Effect.flatMap((location) => fs.readFile(location)),
        Effect.map((bytes) => new Uint8Array(bytes)),
        Effect.mapError(
          () =>
            new ComposeError({ code: "assetLoadFailed", reason: "Could not read compose.wasm" }),
        ),
      ),
    );
  }),
);
