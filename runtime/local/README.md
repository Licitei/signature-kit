# @signature-kit/local

Local document revisions and A1 signing sessions for SignatureKit 2.0. The browser client takes a factory for a dedicated module worker. The same engine runs on Node 20+ and in the worker.

```ts
import LocalWorker from "@signature-kit/local/worker?worker";
import { LocalClient, localClientLayer } from "@signature-kit/local/client";
import { Effect } from "effect";

const readBack = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const client = yield* LocalClient;
    const { handle } = yield* client.openDocument(bytes);
    return yield* client
      .exportDocument(handle)
      .pipe(Effect.ensuring(client.releaseDocument(handle).pipe(Effect.ignore)));
  });

const runtime = localClientLayer(() => new LocalWorker());
const result = readBack(new Uint8Array([1, 2, 3])).pipe(Effect.provide(runtime));
```

The client checks the protocol version when the layer starts. Keep the layer open as long as its handles and A1 sessions are needed. Scope closure drains admitted calls within their request deadlines, then terminates the worker. Calls default to a 30-second deadline, configurable with an Effect `Duration`.

The client preserves caller buffers. The worker transport transfers the client-owned snapshots and independent export buffers. Direct calls through `LocalRpcs` transfer ownership of their byte-array backing buffers.

Pass PFX bytes and passwords to `openA1` as `Redacted` values. A successful open returns public certificate metadata. Each open or close invalidates the preceding generation. Private signing keys stay inside the engine as non-extractable WebCrypto keys. The holder classification reads ICP-Brasil OIDs from X.509 Subject Alternative Name otherNames.
