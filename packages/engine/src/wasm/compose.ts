import { Effect, FileSystem, Layer, Path, Result, Schema, Semaphore } from "effect";
import { Base64 } from "effect/encoding";
import { ComposeRuntime } from "../compose.js";
import { ComposeError } from "../composition/config.js";
import type { ComposeFont } from "../composition/config.js";
import { sha256 } from "../crypto/primitives/sha256.js";

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
  pdf_compose_register_asset: Run,
  pdf_compose_unregister_asset: Schema.declare(
    (value): value is (id: number) => void => typeof value === "function",
  ),
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

const assetLimit = 64 * 1024 * 1024;
const requestLimit = 128 * 1024 * 1024;
const registryCapacity = 512;
const assetIdOffset = 12;

const make = (load: Effect.Effect<ArrayBuffer | Uint8Array<ArrayBuffer>, ComposeError>) =>
  Layer.effect(
    ComposeRuntime,
    Effect.gen(function* () {
      const fonts = yield* Effect.cached(defaultFonts);
      const bundled = yield* Effect.cached(
        fonts.pipe(Effect.map((faces) => new Set(faces.map(({ bytes }) => bytes)))),
      );
      const exports = yield* Effect.cached(instantiate(load));
      const permit = yield* Semaphore.make(1);
      const registry = new Map<Uint8Array | string, { id: number; size: number }>();
      let resident = 0;
      return ComposeRuntime.of({
        fonts,
        render: Effect.fn(
          function* ({ request, assets }) {
            if (assets.some((asset) => asset.length === 0 || asset.length > assetLimit)) {
              return yield* new ComposeError({
                code: "composeFailed",
                reason: "Compose asset must contain between 1 byte and 64 MiB",
              });
            }
            const requestSize = assets.reduce((size, asset) => size + asset.length, request.length);
            if (requestSize > requestLimit) {
              return yield* new ComposeError({
                code: "invalidDocument",
                reason: "Compose request and its assets exceed 128 MiB",
              });
            }
            const defaultBytes = yield* bundled;
            const entries = assets.map((bytes) => ({
              key: defaultBytes.has(bytes) ? bytes : Base64.encode(sha256(bytes)),
              bytes,
            }));
            const required = new Map(entries.map(({ key, bytes }) => [key, bytes.length]));
            const {
              memory,
              pdf_compose_alloc,
              pdf_compose_free,
              pdf_compose_run,
              pdf_compose_register_asset,
              pdf_compose_unregister_asset,
            } = yield* exports;
            let addedBytes = 0;
            let addedCount = 0;
            for (const [key, size] of required) {
              if (!registry.has(key)) {
                addedBytes += size;
                addedCount++;
              }
            }
            for (const [key, asset] of registry) {
              if (
                resident + addedBytes <= requestLimit &&
                registry.size + addedCount <= registryCapacity
              )
                break;
              if (required.has(key)) continue;
              pdf_compose_unregister_asset(asset.id);
              registry.delete(key);
              resident -= asset.size;
            }
            const ids = [];
            for (const { key, bytes } of entries) {
              const prior = registry.get(key);
              if (prior !== undefined) {
                registry.delete(key);
                registry.set(key, prior);
                ids.push(prior.id);
                continue;
              }
              const id = yield* Effect.acquireUseRelease(
                Effect.try({
                  try: () => pdf_compose_alloc(bytes.length),
                  catch: () =>
                    new ComposeError({
                      code: "wasmFailed",
                      reason: "Compose asset allocation failed",
                    }),
                }),
                (pointer) =>
                  Effect.try({
                    try: () => {
                      new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
                      const registered = pdf_compose_register_asset(pointer, bytes.length) >>> 0;
                      if (registered !== 0) {
                        registry.set(key, { id: registered, size: bytes.length });
                        resident += bytes.length;
                      }
                      return registered;
                    },
                    catch: () =>
                      new ComposeError({
                        code: "wasmFailed",
                        reason: "Compose asset registration trapped",
                      }),
                  }),
                (pointer) => Effect.sync(() => pdf_compose_free(pointer, bytes.length)),
              );
              if (id === 0) {
                return yield* new ComposeError({
                  code: "wasmFailed",
                  reason: "Compose asset registration failed",
                });
              }
              ids.push(id);
            }
            const input = yield* Effect.acquireRelease(
              Effect.try({
                try: () => Number(pdf_compose_alloc(request.length)),
                catch: () =>
                  new ComposeError({ code: "wasmFailed", reason: "Compose allocation failed" }),
              }),
              (pointer) => Effect.sync(() => pdf_compose_free(pointer, request.length)),
            );
            new Uint8Array(memory.buffer, input, request.length).set(request);
            const view = new DataView(memory.buffer, input, request.length);
            for (const [index, id] of ids.entries())
              view.setUint32(assetIdOffset + index * 4, id, true);
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
          },
          Effect.scoped,
          (effect) => permit.withPermit(effect),
        ),
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
