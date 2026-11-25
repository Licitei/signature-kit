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

## Offline PDF viewer

Host the Vite-built worker and its emitted WASM asset with your application. The
worker loads the bundled `pdf-core.wasm` before the handshake completes. After
bootstrap, opening, inspecting, rendering and releasing local documents need no
network access.

```ts
import { Effect } from "effect";
import { LocalClient } from "@signature-kit/local/client";
import { paintPage, pdfToCanvasRect } from "@signature-kit/local/viewer";

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

For a non-browser engine, provide `pdfEngineLayer` with `localRuntimeLayer()`
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
