import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { Duration, Effect, Layer, Redacted } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import ecpfUrl from "./fixtures/ecpf.p12?inline";
import { LocalClient, localClientLayer } from "../src/client.js";
import { LocalRpcs, PROTOCOL_VERSION } from "../src/protocol.js";

const createWorker = () =>
  new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });

it("uses the real worker with requests blocked after bootstrap and bounds silent termination", async () => {
  const worker = createWorker();
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      expect(client.instanceId).toMatch(/^[\da-f-]{36}$/);
      const pfx = yield* Effect.promise(async () => {
        const response = await fetch(ecpfUrl);
        return new Uint8Array(await response.arrayBuffer());
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
            () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
          );
          const probe = yield* Effect.promise(() =>
            fetch("/__local_runtime_offline_probe").then(
              () => true,
              () => false,
            ),
          );
          expect(probe).toBe(false);

          const bytes = Uint8Array.of(1, 2, 3);
          const revision = yield* client.openDocument(bytes.subarray(1));
          expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
          const exported = yield* client.exportDocument(revision.handle);
          expect(exported).toEqual(Uint8Array.of(2, 3));
          exported.fill(0);
          expect(yield* client.exportDocument(revision.handle)).toEqual(Uint8Array.of(2, 3));

          const session = yield* client.openA1({
            pfx: Redacted.make(pfx),
            password: Redacted.make("changeit"),
          });
          expect(session.profile.holderKind).toBe("e-cpf");
          expect(session.profile.notBefore.getTime()).toBeLessThan(
            session.profile.notAfter.getTime(),
          );
          expect(pfx.byteLength).toBeGreaterThan(0);
          yield* client.closeA1();
          yield* client.releaseDocument(revision.handle);
          yield* client.releaseDocument(revision.handle);
          expect(yield* Effect.flip(client.exportDocument(revision.handle))).toMatchObject({
            _tag: "LocalError",
            code: "unknownHandle",
          });

          worker.terminate();
          expect(yield* Effect.flip(client.openDocument(Uint8Array.of(1)))).toMatchObject({
            _tag: "LocalError",
            code: "workerUnavailable",
          });
        }),
      );
    }).pipe(
      Effect.provide(localClientLayer(() => worker, { requestTimeout: Duration.seconds(3) })),
    ),
  );
}, 15_000);

it("rejects a skewed Hello and transfers a 16 MiB document over the native RPC protocol", async () => {
  const worker = createWorker();
  const protocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
    Layer.provide(BrowserWorker.layer(() => worker)),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => worker.terminate()));
        yield* Effect.gen(function* () {
          const rpc = yield* RpcClient.make(LocalRpcs);
          expect(yield* Effect.flip(rpc.Hello({ version: PROTOCOL_VERSION + 1 }))).toMatchObject({
            _tag: "LocalError",
            code: "protocolMismatch",
          });
          yield* rpc.Hello({ version: PROTOCOL_VERSION });

          const byteLength = 16 * 1024 * 1024;
          const bytes = new Uint8Array(byteLength).fill(53);
          const started = performance.now();
          const revision = yield* rpc.DocumentsOpen({ bytes });
          const opened = performance.now();
          expect(bytes.buffer.byteLength).toBe(0);
          expect(revision.byteLength).toBe(byteLength);

          const exported = yield* rpc.DocumentsExport({ handle: revision.handle });
          const finished = performance.now();
          expect(exported.byteLength).toBe(byteLength);
          expect(exported.every((byte) => byte === 53)).toBe(true);
          yield* rpc.DocumentsRelease({ handle: revision.handle });
          console.info({
            documentMiB: byteLength / (1024 * 1024),
            openMilliseconds: opened - started,
            exportMilliseconds: finished - opened,
          });
        }).pipe(Effect.provide(protocol));
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );
}, 15_000);
