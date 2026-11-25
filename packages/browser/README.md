# @signature-kit/browser

Local document revisions and A1 signing sessions for SignatureKit 2.0. The browser client takes a factory for a dedicated module worker. The same engine runs on Node 20+ and in the worker.

```ts
import LocalWorker from "@signature-kit/browser/worker?worker";
import { LocalClient, localClientLayer } from "@signature-kit/browser/client";
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

## Offline PDF viewer

Host the Vite-built worker and its emitted WASM asset with your application. The
worker loads the bundled `signature-kit.wasm` before the handshake completes and
then starts its signing helpers in the background. Once `prewarm()` resolves,
opening, inspecting, rendering, signing and releasing local documents need no
network access.

```ts
import { Effect } from "effect";
import { LocalClient } from "@signature-kit/browser/client";
import { paintPage, pdfToCanvasRect } from "@signature-kit/browser/viewer";

const preview = (pdf: Uint8Array, canvas: HTMLCanvasElement) =>
  Effect.gen(function* () {
    const client = yield* LocalClient;
    const { handle } = yield* Effect.acquireRelease(client.openDocument(pdf), ({ handle }) =>
      client.releaseDocument(handle).pipe(Effect.ignore),
    );
    const { pageCount, pages } = yield* client.inspectPdf(handle);
    const viewport = yield* paintPage(canvas, {
      handle,
      pageIndex: 0,
      scale: 1.5,
      rotation: 90,
    });
    const widgetPixels = pdfToCanvasRect(viewport, [40, 30, 100, 65]);
    return { pageCount, pages, widgetPixels };
  }).pipe(Effect.scoped);
```

Page indexes are zero-based. Inspection reports the media and crop boxes in
PDF user space and each page's intrinsic rotation. Scale is in canvas pixels
per PDF unit, and rotation adds clockwise quarter-turns to the PDF's page
rotation. The viewport matrix maps PDF user space to the canvas backing store.
`canvasToPdfRect` applies the inverse. Both functions use rectangle edges
`[x0, y0, x1, y1]`. Apply any CSS scaling separately when positioning HTML
over the canvas.

`LocalClient.renderPage` is also available directly. It returns row-major RGBA
pixels with an opaque white page background and transfers the buffer over RPC.
A raster may have up to 8,192 pixels on an edge and 16,777,216 pixels total.
`renderTooLarge` lets callers retry at a smaller scale.

For a non-browser engine, import `pdfEngineLayer` from `@signature-kit/engine/engine` and provide it with `localRuntimeLayer()`
and your platform's `PdfCore` layer. Use the `Documents` service returned by
`pdfEngineLayer`; its release also closes the corresponding parsed WASM
document. The display list returned by the engine can be painted at the
platform boundary.

The Chromium parity gate checks every page of six fixtures at 1× and 2×,
including an embedded font, images, transparency masks, intrinsic page
rotations and a signed widget with an appearance stream. The reference comes
from the test-only pdf.js dependency. A pixel counts as ink if either renderer
has an RGB channel below 245. Fewer than 5% of those pixels on each page may
differ by more than 64 in any RGB channel. The test also checks that the widget
bounds match the oracle and that the mapped interior lands on the same color.

To measure the Chromium-targeted worker, WASM and protocol/client bundles after
building the packages, run `bun run bench:bundle`.

## Local telemetry

The default worker leaves RPC tracing disabled and does not install a telemetry
tracer. To opt in, use the telemetry worker and provide the page buffer to the
client layer.

```ts
import TelemetryWorker from "@signature-kit/browser/worker-telemetry?worker";
import { localClientLayer } from "@signature-kit/browser/client";
import { localTelemetryLayer } from "@signature-kit/engine/telemetry";
import { Layer } from "effect";

const runtime = localClientLayer(() => new TelemetryWorker()).pipe(
  Layer.provideMerge(localTelemetryLayer()),
);
```

Call `LocalClient.collectTelemetry()` to pull finished worker spans into the
page buffer. `LocalTelemetry.snapshot` reads the current batch.
`LocalTelemetry.drain` removes it and resets its drop counts. Each buffer keeps
up to 512 spans and 256 KiB of serialized span records by default, evicting the
oldest records first. Failed exports can temporarily hold one additional
bounded batch while new spans continue to accumulate.

`summarizeTelemetry` groups completed worker RPCs by operation and reports
outcomes, server handling time, queue wait, execution time excluding the measured
queue wait, instrumented WASM and crypto time,
and bytes copied at the WASM input and render output boundaries. For matched
client and server spans, RPC wait is client round-trip time minus worker
handling time. Truncated traces can leave some measurements unmatched.

For optional OTLP HTTP export, install the optional OpenTelemetry peers and compose
`localTelemetryOtlpLayer(collectorUrl).pipe(Layer.provideMerge(runtime))` at
the page assembly boundary. Its scoped background worker pulls and exports
allowlisted span records periodically. Failed transient exports return their
batch to the bounded page buffer after a limited retry. The collector must
allow requests from the page's origin.

## PDF signatures

Use `addPdfSignatureFields(source, fields)` to place named empty signature widgets before
sending a PDF for signature. It returns a new revision with all supplied fields. Each placement
takes a name, zero-based page index, and rectangle in PDF points.

Call `preparePdf(source, options)` with an A1 session id and generation. Choose an existing
unsigned signature field by name, or supply a new name, zero-based page index, and
`[left, bottom, right, top]` rectangle in PDF points. A visible appearance uses the certificate
holder name, holder kind, and preparation date unless you supply `appearance.lines`. Choose
`cades` or `icpBrasilAdRbV11` for the signing policy.

Pass `previewRevision.handle` to `renderPage` or `paintPage`, then use `pdfToCanvasRect`
with the returned widget rectangle to place a highlight on the preview.
Call `confirmPdf(preparationId)` after approval. It checks the session and certificate at
confirmation time, embeds the detached CMS, and verifies the incremental revision before
returning a receipt. Repeated confirmation returns the retained receipt. Export the signed
revision with `exportDocument(receipt.signedRevision.handle)`. Revisions carry a handle and a
byte length; call `documentDigest(revision)` when you need the content SHA-256 (for example in an
audit record). The worker computes it on demand once per revision, so signing a large document
hashes its bytes only once, for the ByteRange digest.

Use `releasePdf(preparationId)` to discard the preparation or its retained receipt. Release the
source, preview, and signed document handles independently with `releaseDocument`. An open PDF
can be inspected with `pdfSignatureFields` and verified with `verifyPdf`. Trust evaluation
requires explicit DER roots and accepts an optional evaluation date.

Open both the sent and returned PDFs and call `comparePdf(sent, returned, { trust, at })`.
The report identifies the preserved revision, new signatures, their coverage and trust, and
changes across the returned revisions. Embedded CMS revocation evidence carries OCSP and CRL
counts. Its status is `embeddedEvidence`. Use `exportComparisonReport` from
`@signature-kit/engine/rpc` to archive the report as JSON in stable key order. The report can
contain signer CPF and CNPJ values.

For a Node runtime, assemble `pdfSignaturesLayer` from `@signature-kit/engine/pdf-signatures`
with `pdfEngineLayer`, `localRuntimeLayer()` and a `PdfCore` layer. The worker supplies its own browser WASM layer.

See [warm A1 signing benchmarks](../engine/docs/signing-performance.md) for the Node and
Chromium worker measurements and WASM copy breakdown.

## Local batches

Use `prepareBatch` with a session binding, document revisions and a shared signing
template. The template can select an existing field by name, create a field at a
fixed placement, or resolve a named anchor from each document's `anchors` map.
The review snapshot includes the prepared preview revision for each ready item
and a typed reason for each item that needs attention.

Pass the reviewed `itemId` and `preparationId` pairs to `confirmBatch`. Read the
initial snapshot and ordered deltas with `batchEvents`. If a sequence number is
missing, fetch `batchSnapshot` and discard deltas at or below its sequence number.
The events stream ends at the current terminal state. Use a new stream for retries.
Export previews and signed revisions through `exportDocument`. `releaseBatch`
invalidates the batch-owned handles and returns its final byte counters.

The worker reserves bytes per batch for source documents, retained signing
buffers, previews and signed outputs. The reservation also covers the signed
copy used in self-verification and an export copy when persistence is enabled.
The peak counter measures these reservations. Chromium's heap, internal PDF and
cryptographic scratch allocations, and browser storage overhead have their own
lifetimes.

The shipped worker signs batch items on `min(4, navigator.hardwareConcurrency - 1)`
helper workers; the Chromium benchmark stopped improving past four. Helpers receive
the session's non-extractable `CryptoKey` and certificate chain from the runtime
worker, so the PFX is parsed once, and the runtime worker's compiled
`WebAssembly.Module`, so `signature-kit.wasm` is fetched and compiled once. The
runtime worker keeps handles, digests, receipts, admission, the byte budget and
events. A custom entry sets the count with the Schema-checked `signingWorkers`
option (0–64) and passes the helper factory as the third argument of `localWorker`,
for example
`localWorker(false, { signingWorkers: 2 }, () => new Worker(new URL("./signing-helper.js", import.meta.url), { type: "module" }))`;
omit either to sign batch items in the runtime worker.

Helpers start in the background when the worker boots, so a batch started after
the network drops still runs on them. Helpers that do not start (for example when
the network drops before their script loads) or that stop responding are left
out, and their items run in the runtime worker. Every batch snapshot reports the
effective helper count in `signingWorkers`; `0` means the batch signs in the runtime
worker. `LocalClient.prewarm()` waits for the configured helpers and warms the
signing path in each of them.

To opt in to recovery, import `localWorker` from
`@signature-kit/browser/worker-runtime`. In your worker entry, pass
`localWorker(false, { resumeBatches: true })` to `BrowserRuntime.runMain`.
Pass a stable UUID as
`resumeId` to `prepareBatch`. On reload, open a new A1 session and pass the same
template and source documents with that UUID. Committed signed results are
restored with new document handles. Prepare and confirm the remaining items
using the new review snapshot. The worker holds a same-origin Web Lock for the
batch until release or worker exit. After release, call `deleteBatch` to remove
the recovery record and signed outputs.
