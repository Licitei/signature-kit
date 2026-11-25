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

## PDF signatures

Call `preparePdf(source, options)` with an A1 session id and generation. Choose an existing
unsigned signature field by name, or supply a new name, zero-based page index, and
`[left, bottom, right, top]` rectangle in PDF points. A visible appearance uses the certificate
holder name, holder kind, and preparation date unless you supply `appearance.lines`. Choose
`cades` or `icpBrasilAdRbV11` for the signing policy.

Render the returned `previewRevision` to show the exact prepared bytes and widget placement.
Call `confirmPdf(preparationId)` after approval. It checks the session and certificate at
confirmation time, embeds the detached CMS, and verifies the incremental revision before
returning a receipt. Repeated confirmation returns the retained receipt. Export the signed
revision with `exportDocument(receipt.signedRevision.handle)`.

Use `releasePdf(preparationId)` to discard the preparation or its retained receipt. Release the
source, preview, and signed document handles independently with `releaseDocument`. An open PDF
can be inspected with `pdfSignatureFields` and verified with `verifyPdf`. Trust evaluation
requires explicit DER roots and accepts an optional evaluation date. Embedded CMS revocation
evidence is reported as present.

For a Node runtime, assemble `pdfSignaturesLayer` from `@signature-kit/local/pdf-signatures`
with `localRuntimeLayer()` and a `PdfCore` layer. The worker supplies its own browser WASM layer.
