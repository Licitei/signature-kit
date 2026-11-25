# @signature-kit/engine

SignatureKit’s RPC contract and engine services for document revisions, A1 sessions and PDF operations. Internal TypeScript modules implement ASN.1, PKCS#12, CMS and X.509 codecs. The in-house PDF engine is compiled to WebAssembly. It inspects page geometry, link annotations, and positioned text, renders pages, analyzes signature revisions, and writes PDFs (incremental updates, full rewrites, page merges) without any third-party PDF library. The Rust PDF crate lives in `crates/pdf`. TypeScript calls it through the C ABI in `crates/wasm`.

## Install

```sh
bun add @signature-kit/engine effect
```

Apps that do not use Effect skip `effect` and use the Promise client (see [Without Effect](#without-effect)).

## Public surface

- `@signature-kit/engine/rpc` — wire schemas, typed errors, the RPC group and protocol version.
- `@signature-kit/engine/engine` — Effect services for documents, sessions and PDF operations.
- `@signature-kit/engine/telemetry` — bounded tracing and telemetry summaries.

- `@signature-kit/engine/wasm/config` — `PdfCoreError`, `PdfCoreErrorCodeValue`, `pdfCoreErrorMessages`, and the option and inspection schemas.
- `@signature-kit/engine/wasm/pdf-core` — the `PdfCore` service, `makePdfCore(module)`, and `pdfCoreLayer(module)`.
- `@signature-kit/engine/wasm/browser` — `pdfCoreBrowserLayer` (and `pdfCoreBrowserModule`, the loader behind it): fetches `signature-kit.wasm` next to the module, compiles it with `WebAssembly.compileStreaming`, and falls back to `WebAssembly.compile` when the response is not served as `application/wasm`.
- `@signature-kit/engine/wasm/file` — `pdfCoreFileLayer`: reads `signature-kit.wasm` through the Effect `FileSystem` and `Path` services. The caller provides the Node or Bun platform layer.
- `@signature-kit/engine/wasm/promise` — `loadPdfCoreBrowser()` and `createPdfCoreClient(module)`: the same operations as `PdfCore`, returning Promises.
- `@signature-kit/engine/wasm/node` — `loadPdfCoreNode()`: reads `signature-kit.wasm` next to the module with `node:fs` and returns the Promise client.
- `@signature-kit/engine/wasm/canvas` — browser painter for render display lists: `paintDisplayList`, `prepareDisplayListImages`, `renderDisplayListImage`, `displayListViewport`, and `displayListImageBlobs`. It uses Canvas 2D (`OffscreenCanvas`, `Path2D`, `createImageBitmap`), so it runs in windows and workers.
- `@signature-kit/engine/signature-kit.wasm` — the compiled module for bundlers and custom loaders.

`WebAssembly`, `fetch`, `TextEncoder`, and `TextDecoder` are standard Web APIs and are part of this package's declared cross-runtime contract. Each layer compiles the module once when the layer is built.

## Bundling

`pdfCoreFileLayer` reads `new URL("./signature-kit.wasm", import.meta.url)` through the file system. The npm package ships `dist/wasm/signature-kit.wasm` next to `dist/wasm/file.js`. When deploying a server bundle, keep the package external and ship its files together so the relative URL still points to the Wasm file.

- **Nitro 3 / Vercel.** With the `vercel` preset, include `traceDeps: ["@signature-kit/engine"]` in the Nitro config (or the `nitro({ ... })` Vite plugin options). Check that the traced package in the function output includes `dist/wasm/signature-kit.wasm`. [Nitro dependency tracing](https://nitro.build/config/build#tracedeps)
- **Next.js.** Use the Node.js runtime and add `"@signature-kit/engine"` to `serverExternalPackages`. For a traced deployment, check the route's trace and, if necessary, add `"./node_modules/@signature-kit/engine/wasm/dist/wasm/signature-kit.wasm"` to `outputFileTracingIncludes` for the routes that use the layer. [External packages](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages) · [Output file tracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- **esbuild.** Use `--platform=node --format=esm --external:@signature-kit/engine` and deploy the installed package with the bundle. The external flag also covers the `/file` subpath. [esbuild external](https://esbuild.github.io/api/#external)
- **Vite.** For client and worker builds, use `pdfCoreBrowserLayer`. Vite 8's static asset handling rewrites its `new URL("./signature-kit.wasm", import.meta.url)` to the emitted Wasm asset in production, including when imported by the A1 worker. For a Vite SSR server using the file layer, keep the package external and ship the installed files. [Vite asset handling](https://vite.dev/guide/assets.html#new-url-url-import-meta-url)

## Example

```ts
import { NodeServices } from "@effect/platform-node";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { Effect, Layer } from "effect";

declare const pdf: Uint8Array;

const program = Effect.gen(function* () {
  const core = yield* PdfCore;
  const inspection = yield* core.inspect(pdf, { text: true, links: true });
  return inspection.pages.map((page) => page.mediaBox);
});

program.pipe(Effect.provide(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))));
```

### Without Effect

```ts
import { PdfCoreErrorCodeValue } from "@signature-kit/engine/wasm/config";
import { loadPdfCoreNode } from "@signature-kit/engine/wasm/node";

const core = await loadPdfCoreNode();
const { pages } = await core.document(pdf);
const chunk = await core.merge([{ pdf, pageIndexes: [0, 1] }]);
```

In the browser use `loadPdfCoreBrowser()` from `@signature-kit/engine/wasm/promise`. Load the client once and reuse it. Each method has the same arguments and result as the `PdfCore` method of the same name, and rejects with the `PdfCoreError` (`error.code` is a `PdfCoreErrorCodeValue`). `effect` is installed as a dependency of this package; the app does not import it.

`text` returns one reading-order plain-text string per page (pdftotext style). It clusters positioned runs into lines, splits lines into cells on wide gaps, groups cells into blocks, orders blocks with an XY-cut (columns are read column by column, table rows row by row), honours `/Rotate` and sideways text, and ignores content streams that cannot show text. A gap between two glyphs becomes a space when it exceeds half the width of the font's space (clamped to 0.1–0.2 em; a subset font that leaves the space without a width uses the width of `.` or `,`, and a font without a space in its encoding uses 0.2 em), so tightly justified `TJ` arrays keep their word breaks while kerning stays inside words. A line split into cells whose neighbours above and below are single cells starting at the same left edge, such as a numbered code line with an indented statement, stays one line.

Before lines become blocks, the page is split into column regions. A column gutter is a vertical strip that stays empty for at least four consecutive lines with text on both sides. Gutter widths are measured in the line's body text size (the size of its longest run), so a large margin icon does not bridge a gutter, and a lone bullet glyph stays attached to the text after it. A gutter is kept only when both sides read as columns: prose (about three or more words of three or more letters per line, at least a quarter of the line breaks continue a sentence, and at least a quarter of the lines leave less than 4 em between the two sides) or, for gutters narrower than 4.5 em, an index-style list of at least twelve lines with about one word of three or more letters per line (so columns of form numbers such as `1120S:` count) whose lines start on at most four indent levels within 5 em. Gutters where at least 60% of the paragraph breaks of the side with more breaks line up with the other side are table columns and stay together. Text above a gutter is read first, then the left side, the right side and the text below it, recursively, so a title spanning two columns comes before both and 3–4 narrow columns are read one after the other even when the gutter is only about 1 em wide. Each region gets its own lines, borderless tables and blocks, so prose columns never become table cells. Small text (under 91% of the page's dominant size) at the bottom of a column that is not the last one, such as a footnote or copyright notice, moves to the end of the page. Superscript and subscript runs (45–80% of the neighbouring size, at most six characters, touching it horizontally and inside its line band) join that line, so footnote markers stay with their text:

```ts
const pages = yield * core.text(pdf, { pageIndexes: [0, 1] });
```

`pageIndexes` is optional; omitted, every page is returned. Pages whose content cannot be decoded come back as empty strings instead of failing the document.

Text options:

- `format`: `"text"` (default) or `"markdown"`. Markdown keeps the reading order of `text` (columns that each hold flowing paragraphs are read column by column) and groups lines into paragraphs: a line joins the previous one unless the vertical gap exceeds the line pitch, a list or clause marker starts it, the size or emphasis changes, or the previous line ends a sentence and the next word would have fit on it; in an index, a line ending in a page number also ends the paragraph when the next line is a capitalised entry that ends in a page number or a colon. End-of-line hyphenation is joined with a dictionary-free rule, in this order: the hyphen stays when the next fragment does not start in lowercase, when the left word already has a hyphen or a digit, or for clitics, `ex-`/`pré-` style prefixes and `-feira`; it is dropped when the joined word appears elsewhere in the document; it stays when the hyphenated word appears elsewhere, or when both halves (four or more letters each) appear at least twice as words of their own (`high-`/`level`); it stays when the left fragment has two or more capitals (`GPU-`/`based`); otherwise it is dropped (`administra-`/`tivo` becomes `administrativo`). The same rule applies when a paragraph continues in the next column or on the next page. A paragraph cut by a page break continues on the previous page when it does not end a sentence and the next page starts in lowercase, skipping page stamps in between. Footnotes (small text relative to the page), figure and table captions (`Table 3:`, `Figura 2`) and tables are skipped on both sides, so body text never continues into a footnote or caption; a footnote only continues a footnote. Headings come from the size ratio to the body text, bold or uppercase lines and the numbering depth (`1.` is `##`, `1.1.` is `###`); numbered clauses inside body text stay paragraphs. Bold and italic come from the embedded font (`OS/2`, `head`), the font names and descriptors and fill-and-stroke render mode; when a style covers most of the body text it is not marked. Bullets become `- `, numbered items keep their number, and `a)` or `I -` items keep their marker inside a `- ` item, nested by indentation. Link annotations over text become `[text](url)`, bare URLs stay as they are, and every detected table is a GFM table (`|` escaped, wrapped cell lines joined like paragraphs, merged cells left empty after their first slot). There are no page separators; each page is its own string.
- `dropRunningHeaders` (default `true`): lines repeated in the top or bottom 10% of at least half of the selected pages (markdown: at least three pages and 5% of them) (digits normalised, so `Página 3 de 79` matches `Página 4 de 79`) are dropped, so sentences continue across page breaks. When the repeated line is identical on every page (a fixed address, say) the first page keeps one copy; when its digits change (page numbers) it is dropped everywhere. It needs at least two selected pages. `inspect` is never affected.

Ruled tables (cell borders drawn as strokes or thin filled rectangles, with the CTM applied; clipping-only paths and page-sized frames are ignored) are laid out cell by cell in both formats, so a bordered form reads row by row and a heading below the table never merges into its last cell. Borderless tables are detected from column alignment of the text runs and are structured in `markdown` and `tables` only; `text` keeps the row-major block layout for them.

`tables` returns the structure of every table:

```ts
const tables = yield * core.tables(pdf, { pageIndexes: [0] });
// [{ pageIndex, bbox, rows, cols, cells: [{ row, col, rowSpan, colSpan, bbox, text }] }]
```

`bbox` values are in page user space like `inspect` rects; `row`/`col` follow the visible reading orientation (top to bottom, left to right) even on rotated pages. Merged cells appear once with `rowSpan`/`colSpan` greater than 1.

Pass `mergeAcrossPages: true` to `tables` or to `text` with `format: "markdown"` to join matching tables across consecutive selected pages. Matching uses page-edge placement, column alignment and evidence from the header or body rows. Repeated table headers are removed. In a ruled table, complementary cells can be joined when both row fragments are shorter than nearby whole rows. The matcher uses geometry and row content, so visually indistinguishable tables can still be ambiguous. Enabling the option runs reading-order layout on all selected pages, including in `tables`.

Merged tables include zero-based `pages` in reading order. Standalone tables omit `pages`. The table `pageIndex` and `bbox` describe the first fragment. In merged tables, each cell includes its source `pageIndex` so its `bbox` remains page-local. Markdown renders the merged table in the first page's string and keeps one output string per selected page. Running headers and page numbers are skipped when matching tables, unless `dropRunningHeaders: false` is set in either API.

Marked-content `/ActualText` replaces the glyph text of its span, glyphs fully outside a Form XObject `/BBox` are skipped, and text render modes 4-7 (clip) still extract text, in `text`, `markdown` and `tables`.

`inspect` returns `pages` (`mediaBox`, `cropBox`, `rotate`), `links` (`pageIndex`, `uri`, `rect`), and `text` pages. Each text page carries `rects` (a `Float64Array` of `[x0, y0, x1, y1, fontSize]` per item), `text` (all item texts joined), `offsets` (a `Uint32Array` of `items + 1` UTF-16 code unit offsets into `text`, so item `n` is `text.slice(offsets[n], offsets[n + 1])`), and `styles` (a `Uint8Array` with one byte per item: bit 0 bold, bit 1 italic).

By default an item is a run of text that continues on one baseline, so `17/06/2026 15:39:26    MENSAGEM` (two columns drawn by separate text operators) is one item. With `runs: true` an item also ends where its bold/italic style changes, or where the text is repositioned (`Td`, `Tm`, `T*`, a new `BT`) to a point more than 0.2 em past the end of the last visible glyph, which keeps table columns and bold labels apart. Trailing spaces do not count, so a producer that positions every word on its own gives one item per word. A piece positioned within that distance (a `™` drawn by another font) stays in the item, and `TJ` kerning never splits it. `runs` has no effect without `text`:

```ts
const inspection = yield * core.inspect(pdf, { text: true, links: false, runs: true });
```

A style bit is set when every glyph of the item carries it. It comes from the embedded font program, the font name (`Helvetica-Bold`), the font descriptor, and fill-and-stroke rendering. Without `runs` an item can mix styles (its bits then cover only the style shared by all its glyphs), and embedded TrueType fonts are not probed for their weight, so read `styles` with `runs: true`. Results are decoded straight from wasm memory, and the typed arrays copied out, before the wasm buffers are released.

## Signatures and revisions

`signatures(pdf, analysis)` reports the signature dictionaries of a PDF. Every dictionary carries its kind (`signature` or `documentTimestamp`), its object number and start offset, the exact byte spans of its `/ByteRange` and `/Contents` entries, the parsed byte-range values when they are four non-negative safe integers, its `subFilter` name when present, and whether it is an unsigned placeholder (`[0 /********** /********** /**********]` with a zero-filled `/Contents`).

- `"scan"` scans every indirect object once. `parseFailed`, `streamFailed`, and `streamUncertain` report syntax the scanner could not bound; callers treat them as fail-closed.
- `"dictionaries"` resolves forward indirect stream lengths from each revision's own number objects before rescanning, and reports `failure: "streamEnd"` when a stream still cannot be bounded.
- `"verification"` additionally reads every revision (classic tables, xref streams with Flate and PNG/TIFF predictors, hybrid `/XRefStm` sections, object streams), binds each dictionary to the revision whose `%%EOF` ends its byte range, and keeps only dictionaries reachable from that revision's AcroForm signature fields. It also resolves indirect `/SubFilter` names against the signature's revision.

Work is bounded: 128 revisions, 1,024 signature dictionaries, 200,000 indirect number values, 500,000 cross-reference entries, 16 MiB per xref or object stream, 64 MiB of decompressed object streams, and 200,000 reachability steps. Exceeding a bound reports a `failure` instead of a partial answer.

`revisionComplete(pdf, end)` is `true` when `pdf.subarray(0, end)` is a complete revision: it ends at `%%EOF` (trailing whitespace allowed), its cross-reference chain is intact, and the prefix opens as a document.

### Preparing a signature

`signatureFields(pdf)` reads the current AcroForm. Each signature field reports its fully qualified name, object reference when indirect, widgets, signed status, and FieldMDP lock. A signature value reports its parsed byte range, SubFilter, and covered revision end when available. The report also includes the catalog's DocMDP permission and the revision end offsets. A revision end includes the line break immediately following its `%%EOF` marker when present.

`prepareSignature(pdf, request)` appends one incremental update and preserves every input byte. Select an unsigned field by its fully qualified name or create a top-level field on a zero-based page. Rectangles use `[left, bottom, right, top]` in PDF points. A visible appearance uses widget-relative coordinates, standard Helvetica fonts with WinAnsi text, gray or RGB components in `[0, 1]`, and an optional border or PNG. A new invisible signature can use `[0, 0, 0, 0]` with `{ kind: "none" }`.

```ts
const prepared =
  yield *
  core.prepareSignature(pdf, {
    field: { kind: "create", name: "Approval", page: 0, rect: [36, 36, 252, 80] },
    appearance: {
      kind: "visible",
      lines: [
        { text: "Approved", font: "Helvetica-Bold", size: 12, position: [8, 16], color: [0] },
      ],
    },
    date: "D:20261125123000Z",
    contentsCapacity: 16384,
    sha512: true,
  });
```

The result contains the PDF, its four ByteRange numbers, SHA-256, and SHA-512 when requested. Embed the hex-encoded detached CMS at `contentsStart`, leaving any remaining zero padding in place through `contentsEnd` (exclusive). These offsets exclude the angle brackets. The default SubFilter is `ETSI.CAdES.detached`. `docMdp` can certify the first signature with permission 1, 2, or 3. Creating a field accepts `lock` with action `All`, `Include`, or `Exclude` and the applicable list of field names.

`revisionChanges(pdf, fromRevisionEnd)` compares consecutive revisions after the supplied boundary. Each entry identifies its object, revision end, category, and whether the object was added, modified, or removed. `pageContentChanged` indicates a page content or resource change, including inherited resources. Entries with an unrecognized role are reported as `unknown`. A change to the document trailer uses the current catalog reference and the `catalogOther` category.

## Writing

`document(pdf, options)` describes what an edit needs: `nextObjectNumber`, every page (`ref`, boxes, rotation, annotation count), whether the catalog has an AcroForm, the annotations of `annotationPages` (reference, widget flag, `/T` presence, `/Rect`, the `uri` of `/Link` annotations with a URI action, and the signature slot analysis of empty signature widgets), and with `fieldNamePrefix` the first unused `<prefix><n>` field name (or why the field tree could not be read within its depth, node, and name-length budgets).

`edit(pdf, operations, options)` applies typed operations and serializes the result. Values are PDF syntax (`"<< /Fields [] >>"`, `"12 0 R"`, `"(text)"`); new objects use numbers from `nextObjectNumber` upward. Operations:

| `op`             | Effect                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `setObject`      | Replaces or adds an indirect object.                                                                                                |
| `setStream`      | Replaces or adds a stream object; `compress` Flate-encodes the data with the in-house zlib encoder.                                 |
| `set` / `remove` | Sets or removes a dictionary key at a target. Targets start at the catalog, a page, or an object and follow a path of keys/indexes. |
| `append`         | Appends to an array entry (indirect arrays are edited in place; a missing entry becomes a new array).                               |
| `removeItem`     | Removes every equal item from an array entry (for example an annotation reference).                                                 |
| `setFlags`       | ORs bits into an integer entry such as `/F` or `/SigFlags`.                                                                         |
| `appendContent`  | Adds a content stream to a page; with `wrapRef` the existing content is wrapped in `q`/`Q` first.                                   |
| `addResource`    | Adds a named resource (`Font`, `XObject`, `ExtGState`, …) to a page, materializing inherited resources.                             |
| `image`          | Adds an 8-bit gray or RGB image XObject; with `alpha` the alpha channel becomes an `/SMask` object.                                 |
| `png`            | Decodes a PNG (every color type and bit depth, Adam7 interlacing, `tRNS`) into an 8-bit image XObject with an `/SMask` when alpha.  |
| `standardFont`   | Adds a standard-14 Type 1 font (`WinAnsiEncoding` except Symbol and ZapfDingbats).                                                  |
| `signature`      | Adds a signature dictionary with a `/ByteRange` placeholder and a zero-filled `/Contents` of `contentsLength` bytes.                |
| `repairCatalog`  | Sets `/Type /Catalog` on the document catalog.                                                                                      |

`mode` chooses the serialization. `"incremental"` appends the changed objects after the untouched original bytes with a new cross-reference section linked by `/Prev` (a classic table, or an xref stream when the previous section is one), so earlier signatures stay valid; it fails when the cross-reference chain had to be repaired. `"rewrite"` copies the reachable object graph into a new file with renumbered objects, dropping unreachable ones; `objectStreams: true` packs non-stream objects into Flate object streams. `"auto"` (default) is incremental when possible and a rewrite otherwise.

PNG input is bounded to 16 MiB, 16 Mi pixels, 64 MiB of decoded scanlines and 4,096 chunks; malformed PNGs fail with `pdfCore.INVALID_OPTIONS`.

`create({ pages })` writes a new document with blank pages of the given sizes (1 to 10,000 pages, sides up to 14,400 points); edit it like any other PDF.

`fontMetrics(baseFont)` returns, for one of the twelve WinAnsi standard-14 fonts, the Unicode code point (`unicode`, `0` when undefined) and the advance width in 1/1000 em (`widths`) of each of the 256 WinAnsi codes, so callers can encode and measure text drawn with the `standardFont` operation.

`pngSize(png)` decodes a PNG with the same bounded decoder as the `png` edit operation and returns its `width` and `height`; it fails with `pdfCore.INVALID_OPTIONS` or `pdfCore.LIMIT_EXCEEDED` for anything that operation would reject, including animated PNG chunks and bytes after `IEND`.

`merge(sources, options)` copies pages into a new document: each source may select `pageIndexes`; inherited boxes, rotation, and resources are materialized, references to pages that are not copied become `null`, and `dropWidgets` removes widget annotations. `deflate(bytes)` returns a zlib stream.

## Rendering

`renderPages` turns pages into compact display lists; the browser painter draws them with Canvas 2D, so JPEG decoding and anti-aliased rasterization stay in the browser and the wasm module stays small.

```ts
import { renderDisplayListImage } from "@signature-kit/engine/wasm/canvas";

const lists = yield * core.renderPages(pdf, { pageIndexes: [0], scale: 150 / 72 });
const thumbnail = yield * renderDisplayListImage(lists[0]); // { pageIndex, width, height, image: Blob }
```

`scale` is device pixels per PDF point (default `150 / 72`, i.e. 150 DPI). Each display list carries `pageIndex`, `view` (crop box clipped to the media box), `rotate`, `scale`, the `ops` bytes, and `blobs`. `scale` also bounds image work: images larger than their device footprint are box-filtered down in Rust before they cross the wasm boundary. `renderDisplayListImage(list, { scale, type, quality })` paints into an `OffscreenCanvas` on a white background and encodes a `Blob` (`type` is `image/png` by default, or `image/jpeg` / `image/webp` with an optional `quality`); a page whose canvas would exceed 16 384 px per side or 16 384² px in area is painted at the largest scale that fits, so `width`/`height` report the clamped size. `paintDisplayList(context, list, images, scale)` returns an `Effect` that paints into any 2D context and fails with `pdfCore.PAINT_FAILED` when the display list is malformed (truncated operands, unknown opcodes or path verbs) or the canvas rejects an operation. `prepareDisplayListImages(list)` decodes the page images into a map keyed by blob index; it requires a `Scope`, and every `ImageBitmap` it creates is closed when that scope closes (including when a later image fails).

PNG stays the default encoding: on 60 pages of five public tenders at 150 DPI in Chromium, PNG took 38 ms per page, JPEG (quality 0.92) 35 ms per page but lossy (a mean error of 3 levels on ink pixels), and WebP (quality 0.92) 376 ms per page. Images are drawn with smoothing only when they are downscaled or carry `/Interpolate true`, so upscaled 1-bit scans, QR codes and barcodes stay crisp.

Covered: paths (`m l c v y h re`), fill, stroke and even-odd rules, clipping (`W W*`), line width, cap, join, miter limit and dash patterns (lines thinner than one device pixel are drawn one pixel wide), `cm`, `q`/`Q`, DeviceGray/RGB/CMYK, CalGray/CalRGB, ICCBased (by `/N` or `/Alternate`), Lab, Indexed, Separation and DeviceN through their tint transforms (sampled, exponential, stitching and bounded PostScript calculator functions), ExtGState `LW LC LJ ML D CA ca BM Font`, Form XObjects clipped to their `/BBox`, image XObjects and inline images (Flate, LZW, RunLength, ASCIIHex, ASCII85 and raw samples decoded to RGBA in Rust with 1/2/4/8/16 bits per component, `/Decode` arrays, stencil masks, `/SMask` with `/Matte`, colour-key and stencil `/Mask`; DCT JPEG bytes are passed to the browser decoder; CCITT Group 3 and Group 4 are decoded in Rust), axial and radial shadings for `sh` and shading patterns, embedded TrueType, CFF (including CID-keyed), OpenType CFF and Type 1 (eexec) glyph outlines drawn as cached glyph paths, Type 3 glyph procedures, text render modes 0–7 (3 is invisible, 4–7 clip), and the normal appearance stream of every annotation that is not hidden, no-view or a popup. Non-embedded fonts are drawn with `fillText` in a mapped sans, serif or monospace family stretched to the PDF `/Widths`.

Approximations and gaps: JPX and JBIG2 images are drawn as a neutral grey placeholder; function-based and mesh shadings fill with their `/Background` (function-based ones with the colour at the domain centre); tiling patterns fill with the first non-white colour of the tile; ExtGState soft masks and transparency-group isolation/knockout are ignored; optional content honours the default configuration (`/D` with `/OFF`, `/ON` and `/BaseState`) for OCGs and OCMDs (`/P` policies and `/VE` expressions) in `BDC /OC` marked content, Form and image XObjects and annotations, while usage-based states and `/AS` arrays are not applied; clip render modes (4–7) with non-embedded fonts clip to one box per glyph (advance width wide, from 0.2 em below to 0.8 em above the baseline) instead of the glyph outline; a gradient painted on text uses its middle colour. Hostile input is bounded: content streams share the decoded-stream byte budget, a page stops after 4 000 000 operators or 96 MiB of display list, decoded images are capped at 64 Mi pixels (16 Mi after downsampling) and 384 MiB per page, Form XObject and Type 3 nesting stops at 16 levels with cycle detection and every Form or Type 3 glyph invocation counts as an operator, graphics-state and marked-content nesting stop at 256 and 1 024 levels, and glyph outlines are capped at 512 composite parts per glyph and 16 M units of outline work (points, parts and charstring steps) per page. Decoded Form XObject and Type 3 glyph streams (up to 64 MiB) and parsed colour spaces (with their Indexed lookups and tint functions) are cached per document. A page that hits a budget is returned truncated instead of failing.

## Encrypted PDFs

`inspect`, `text`, `tables`, `document`, `renderPages`, and `merge` accept Standard Security PDFs whose user password is empty. The supported algorithms are RC4 (40-bit or up to 128-bit, revisions 2–4), AESV2 (revision 4), and AESV3 (revisions 5–6). PDFs that require a nonempty opening password fail with `pdfCore.ENCRYPTED_PDF`.

`merge` writes an unencrypted PDF. When `edit` receives an encrypted PDF it uses a full rewrite in `auto` or `rewrite` mode, producing an unencrypted PDF. This lets a first signature cover the rewritten bytes. Rewriting changes the original bytes and invalidates any existing signatures. An explicit `incremental` edit fails with `pdfCore.ENCRYPTED_PDF`.

## Errors

Failures use `PdfCoreError` with the codes `pdfCore.WASM_LOAD_FAILED`, `pdfCore.INVALID_PDF`, `pdfCore.ENCRYPTED_PDF`, `pdfCore.LIMIT_EXCEEDED`, `pdfCore.UNSUPPORTED_FEATURE`, `pdfCore.INVALID_OPTIONS`, and `pdfCore.PAINT_FAILED` (the browser could not create a canvas, decode an image, or encode the page image). Invalid edit operations (malformed PDF syntax, missing targets, impossible incremental updates) fail with `pdfCore.INVALID_OPTIONS`. `pdfCoreErrorMessages` carries `en-US` and `pt-BR` copy.

## Read selected pages from a byte-range source

Use `openLazy` when the PDF lives on disk, in a Blob, or behind a byte-range API. The source provides the file size and a positional reader. Return exactly the requested bytes, keep the source immutable for the document's lifetime, and allow up to four ranges in flight per document.

```ts
import { Effect } from "effect";
import { PdfCore, pdfCoreBlobSource } from "@signature-kit/engine/wasm/pdf-core";

const firstPageMarkdown = (pdf: Blob) =>
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const doc = yield* core.openLazy(pdfCoreBlobSource(pdf), { pageLimit: 1 });
      const pages = yield* doc.text({ format: "markdown" });
      return { pages, stats: yield* doc.stats };
    }),
  );
```

The service also exports `pdfCoreBytesSource(bytes)`. For disk files, `pdfCoreFileSource(path)` from `@signature-kit/engine/wasm/file` opens a scoped Effect `FileSystem` handle and uses positional reads. Provide the platform's file system as you do for `pdfCoreFileLayer`.

```ts
import { open } from "node:fs/promises";
import { loadPdfCoreNode, pdfCoreNodeSource } from "@signature-kit/engine/wasm/node";

const core = await loadPdfCoreNode();
await using file = await open("notice.pdf");
await using doc = await core.openLazy(pdfCoreNodeSource(file, (await file.stat()).size));
const pages = await doc.text({ pageIndexes: [0], format: "markdown" });
const stats = await doc.stats();
```

The Promise client also accepts readers returning a plain `Uint8Array`. Call `close()` if you manage its lifetime without `await using`. The caller owns any underlying resource passed to the Promise reader.

Both clients accept `pageLimit` and range tuning in the second argument. `pageLimit` reads the first N pages, up to the document length. Zero selects no pages. An explicit `pageIndexes` list on `text`, `tables` or `renderPages` overrides the limit, so `doc.text({ pageIndexes: [7] })` parses only page 8. Omit both settings to process every page. The defaults are `probeBytes: 65536` for each end of the file, `gapBytes: 32768` for read-ahead and coalescing, and `maxRoundBytes: 2097152` for a batch of selective reads. Small files use smaller probes. Set `gapBytes: 0` to fetch the required ranges without read-ahead. The core uses valid linearization hints to prefetch the first page section and checks the cross-reference chain before using the bytes.

Page indexes are zero-based and retain their original values in results. For selected pages, the reader stops walking the page tree when it reaches the last requested page. It fetches page content and dependencies only for the selection. The retained ranges can serve later calls on the same document. When the cross-reference data or requested objects require repair, the core fetches only the missing bytes in batches bounded by `maxRoundBytes` and reuses the complete input on later calls. Set `allowFullRead: false` to return `pdfCore.UNSUPPORTED_FEATURE` when the file requires full recovery.

`maxCachedBytes` controls how many source bytes remain in the selective cache between operations. The default is 2 MiB. When the cache exceeds that limit, the core releases page ranges and parsed objects while retaining the cross-reference index and a small prefix of the file. Set it to zero to release page ranges after each operation. The limit applies between operations because a selected page may itself need larger streams. Fully recovered input stays cached until the handle closes.

Stats include cumulative `bytesRead`, request `rounds`, and retained source `cachedBytes` after each operation. `strategy` reports `"lazy"` or `"fallback"`. `pdfCore.RANGE_READ_FAILED` means the source read failed or returned the wrong byte count. `pdfCore.DOCUMENT_CLOSED` means the document's scope has closed. `pdfCore.LIMIT_EXCEEDED` covers sources over 512 MiB, exhausted Wasm handles or allocations, and the usual extraction limits. Invalid tuning reports `pdfCore.INVALID_OPTIONS`. Use `core.wasmMemoryBytes()` for the instance's current linear-memory capacity, which is also its high-water capacity.

### Choose pages for external OCR

`pageDiagnostics()` reports the native text layer on each selected page. `usable` means the parser found readable native text. `weak` flags uncertain extraction, such as a short stamp over a full-page scan or glyphs with missing mappings. `none` means no native text was found and includes blank pages. The result includes the original zero-based `pageIndex` and counts for glyphs, usable characters, unmapped glyphs and images. Diagnostics are heuristic and preserve the caller's decision about when to use OCR.

The Effect and Promise clients expose diagnostics on both full PDFs and lazy documents. On a lazy document, the same `pageLimit` and `pageIndexes` rules apply. Render only the candidate pages for your OCR pipeline:

```ts
await using doc = await core.openLazy(source, { pageLimit: 8 });
const diagnostics = await doc.pageDiagnostics();
const pageIndexes = diagnostics
  .filter((page) => page.textLayer === "weak" || (page.textLayer === "none" && page.imageCount > 0))
  .map((page) => page.pageIndex);
const pagesForOcr = await doc.renderPages({ pageIndexes });
```

### Build an OCR-only PDF

If your OCR service accepts a PDF and you have the original bytes, pass the diagnosed page indices to the existing page copier. It preserves page order and copies the page content and resources without rendering images. Keep `sourcePageIndexes` alongside the new PDF to map each OCR page back to its source. This policy includes blank pages and pages whose text is drawn as vectors. If you only want image-only and weak pages, use the filter from the previous example. For a range source without the original bytes in memory, use the per-page rendering flow above.

```ts
const diagnostics = await core.pageDiagnostics(pdf);
const sourcePageIndexes = diagnostics
  .filter((page) => page.textLayer !== "usable")
  .map((page) => page.pageIndex);

if (sourcePageIndexes.length > 0) {
  const ocrPdf = await core.merge([{ pdf, pageIndexes: sourcePageIndexes }], {
    dropWidgets: true,
  });
  await submitForOcr(ocrPdf, sourcePageIndexes);
}
```

Run `PDF_CORPUS=/path/to/pdfs bun run bench:pdf --quick` to measure PDF operations.
After building the repository, run `PDF_CORPUS=/path/to/pdfs bun packages/engine/bench/lazy.bench.ts` to compare Markdown output and measure a fresh process per path and PDF. Append `--warm` for a long-lived Wasm instance with one warm-up and the median of three trials per PDF, `--rtt` for a real 40 ms timer per request with four concurrent range reads, or `--http` for real loopback HTTP Range requests on up to twelve evenly spaced files. Set `PDF_PROBE_BYTES`, `PDF_GAP_BYTES`, and `PDF_MAX_ROUND_BYTES` to compare tuning. The benchmark exits nonzero on mismatches or failed extractions.

## Extraction benchmarks

The benchmark exercises text and Markdown extraction with all input bytes already in memory. OCR is disabled. Timings exclude file reads and engine initialization. The numbers describe these inputs and runtimes.

### Reproduce the comparison

Build the checkout with `bun run build`. The [benchmark runner](https://github.com/Licitei/signature-kit/tree/main/packages/engine/bench/comparison) uses an isolated lockfile for the comparison engines. The example uses Bun 1.4.5 on Linux x64.

```sh
export SIGNATURE_KIT_ROOT="$PWD"
bench_dir=$(mktemp -d)
cp packages/engine/bench/comparison/{package.json,bun.lock,run.ts} "$bench_dir/"
(
  cd "$bench_dir"
  bun install --frozen-lockfile
  bun run run.ts
) > pdf-parser-benchmark.jsonl
```

By default this runs the repository fixtures. Set `PDF_CORPUS` to an absolute directory containing `pdfs/` and optionally `gabarito/` to run your own procurement corpus. Use `PDF_BENCH_TRIALS` to set the number of timed calls per file, engine, and workload. Run one benchmark at a time on a quiet host. The runner warms each engine once per file and rotates engine order. Every engine receives the same bytes and page selection, with OCR disabled. The output includes all timings, output hashes, empty results, failures, evidence counts, and retained Wasm memory. Compare latencies and evidence on the common successful, nonempty cohort, and report excluded files separately.

The procurement corpus behind the results below is maintained separately from the repository. The committed fixtures provide an immediately runnable comparison using the same engine versions.

### Public procurement PDFs

Thirty Brazilian public-procurement documents with selectable text, totaling 5,435 pages. Individual files range from 15 to 697 pages.

| Engine                                                                      | First-page Markdown p50 / p90 | Whole-document Markdown p50 / p90 | Whole-document ms/page |  Evidence found | Whole-document failures |
| --------------------------------------------------------------------------- | ----------------------------: | --------------------------------: | ---------------------: | --------------: | ----------------------: |
| SignatureKit pdf-core (Wasm)                                                |               5.07 / 18.15 ms |                 71.92 ms / 1.54 s |                   2.42 | 248/251 (98.8%) |                    0/30 |
| [LiteParse 2.20.0](https://github.com/run-llama/liteparse) (native PDFium)  |              22.69 / 56.23 ms |                382.55 ms / 9.75 s |                  13.41 | 229/251 (91.2%) |                    0/30 |
| [PDF Inspector 1.27.0](https://github.com/firecrawl/pdf-inspector) (native) |           379.84 ms / 13.82 s |                    1.55 / 19.80 s |                  34.68 | 211/251 (84.1%) |                    1/30 |
| PDF Inspector 1.27.0 (Wasm)                                                 |            208.96 ms / 3.69 s |                    2.25 / 33.32 s |                  49.26 | 211/251 (84.1%) |                    1/30 |

The same Bun 1.4.5 process ran the public parser APIs in rotating order. The first file warmed up each engine. Each file contributes one timed call per workload. Timings and evidence use the 29 successful, nonempty files common to all engines for each workload. The native Inspector returned an empty first page for the 626-page file. Both Inspector builds reported a parse error on the 559-page whole-document run. The Inspector's native first-page API computes document-wide font statistics, which contributes to the cost of selecting one page.

The corpus answer key supplies literal evidence for questions such as opening date, contract value and deadlines. The evaluator searches for contiguous normalized evidence in the whole-document Markdown after stripping case, accents, punctuation and whitespace. This measures recovery of those snippets in order. Table geometry, visual layout, and accuracy on scanned PDFs are outside the score. Among the 96 first-page snippets, pdf-core recovered 94, LiteParse 86, and each Inspector build 83.

#### Evidence audit

Across all 30 documents, the original raw Markdown evaluator found 257 of 260 evidence snippets. A separate audit found all 260 after checking the raw Markdown and its rendered text and correcting one reference against the source PDF. The two email-related snippets were contiguous in the rendered text because it omits link destinations. The 633-page IFMA document shows the opening time once, while the reference snippet repeated `09h`. The audit preserves the original Markdown output and reports the original benchmark score in the comparison table.

With a local file-backed range source, pdf-core's first-page Markdown p50 was **5.02 ms** and p90 was **8.73 ms** on the common first-page cohort. It read **46.85%** of file bytes at p50 in **3 rounds** and completed all 30 files without falling back to a full-file recovery. Network round-trip time is outside these measurements.

#### Selected-page traversal

A separate run isolates a subsequent change that stops the full-input page-tree walk after the requested pages. With the PDF already in memory, pass `pageIndexes: [0]` to `text` with `format: "markdown"`. Across all 30 files, the first-page median fell from **4.82 ms to 3.31 ms** and p90 from **11.80 ms to 6.49 ms** versus `67c61c3`. The final build's slowest first page took **11.83 ms**. Whole-document Markdown took **74.29 ms** at p50, **1.34 s** at p90, and **2.08 s** on the slowest file.

Each build warmed up once per file and workload. First-page results use seven timed calls per file, interleaved between builds. Whole-document results use one timed call per file after warm-up. All 60 first-page and whole-document outputs matched the baseline byte for byte.

#### Markdown rendering

A separate paired run compared whole-document Markdown before and after removing temporary renderer allocations. Each of the 30 procurement PDFs warmed up both builds and contributed five timed calls per build in alternating order. The median paired latency improved **2.35%**. The candidate was faster on 26 of 30 files. Across the corpus, p50 moved from 67.49 to 66.61 ms, p90 from 1.519 to 1.524 s, and the slowest file from 2.282 to 2.118 s. Output hashes matched on all 30 files. The optimized Wasm was 1,144,819 bytes.

A follow-up profile of two large procurement PDFs found number parsing among the largest hot paths. The parser now uses bounded accumulation for the first 19 integer digits and the first 18 fractional digits, with the existing checked path for longer integers. In a separate paired run over the same 30 files, the number parser improved median paired latency by **2.03%**, and p90 moved from **1.329 s to 1.268 s**. All 30 whole-document outputs matched the prior build byte for byte. The optimized Wasm was 1,144,864 bytes.

### Repository fixtures

Sixteen PDFs from [the fixture directory](./__tests__/fixtures) run in Bun 1.4.5. Each engine gets one unmeasured warm-up per file and workload, followed by seven timed calls in rotating engine order. The table reports the median of the per-file medians.

| Engine                                                                      | First-page Markdown | Whole-document Markdown | Whole-document text |
| --------------------------------------------------------------------------- | ------------------: | ----------------------: | ------------------: |
| SignatureKit pdf-core (Wasm)                                                |             1.21 ms |                 0.90 ms |             0.71 ms |
| [LiteParse 2.20.0](https://github.com/run-llama/liteparse) (native PDFium)  |             3.34 ms |                 3.54 ms |             2.86 ms |
| [PDF Inspector 1.27.0](https://github.com/firecrawl/pdf-inspector) (native) |             1.99 ms |                 1.70 ms |             0.51 ms |
| PDF Inspector 1.27.0 (Wasm)                                                 |             3.58 ms |                 2.82 ms |             2.23 ms |

All four engines returned nonempty output for every fixture. On six [hand-written Markdown fixtures](./__tests__/fixtures), the mean word-overlap F1 was 100% for pdf-core, 97.8% for LiteParse, and 90.1% for both PDF Inspector builds. The order of all words matched in 6/6, 3/6, and 1/6 fixtures, respectively. Word overlap ignores formatting and order. These fixtures are maintained by SignatureKit and measure regression against its target output.

The pdf-core Wasm binary was 1,144,864 bytes. The PDF Inspector Wasm binary was 6,003,685 bytes. After the full run, their retained linear memory was 1.94 MiB and 6.31 MiB, respectively. The native variants are timed as Node addons and have different memory accounting.

## Wasm ABI

The module exports `memory` and the functions below. The caller owns input and result buffers and releases them with `pdf_core_free`. Each Wasm instance owns its lazy handles until `pdf_core_lazy_close`.

| Export                                                                                                   | Contract                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pdf_core_alloc(len) -> ptr`                                                                             | 8-byte aligned block of `len` bytes, or `0` when out of memory.                                                  |
| `pdf_core_free(ptr, len)`                                                                                | Releases a block returned by `pdf_core_alloc` or any result-returning export.                                    |
| `pdf_core_inspect(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                          | Returns a result block, or `0` when out of memory.                                                               |
| `pdf_core_text(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                             | Returns a text result block, or `0` when out of memory.                                                          |
| `pdf_core_tables(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                           | Returns a tables result block, or `0` when out of memory.                                                        |
| `pdf_core_page_diagnostics(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                 | Returns native text layer diagnostics for the selected pages.                                                    |
| `pdf_core_render(pdf_ptr, pdf_len, flags, pages_ptr, pages_len, scale: f64) -> result_ptr`               | Returns a render result block, or `0` when out of memory. `scale` is device pixels per point, `0 < scale <= 64`. |
| `pdf_core_signatures(pdf_ptr, pdf_len, mode) -> result_ptr`                                              | Signature analysis; `mode` `0` scan, `1` dictionaries, `2` verification.                                         |
| `pdf_core_signature_fields(pdf_ptr, pdf_len) -> result_ptr`                                              | Current signature fields, permissions, and revision boundaries.                                                  |
| `pdf_core_prepare_signature(pdf_ptr, pdf_len, request_ptr, request_len) -> result_ptr`                   | Appends and hashes a single signature preparation.                                                               |
| `pdf_core_revision_changes(pdf_ptr, pdf_len, from_revision_end) -> result_ptr`                           | Classifies object changes by revision.                                                                           |
| `pdf_core_revision_complete(pdf_ptr, pdf_len, end) -> u32`                                               | `1` when the first `end` bytes are a complete revision, else `0`.                                                |
| `pdf_core_document(pdf_ptr, pdf_len, flags, pages_ptr, pages_len, prefix_ptr, prefix_len) -> result_ptr` | Document description; `flags` bit 2 selects annotation pages.                                                    |
| `pdf_core_edit(pdf_ptr, pdf_len, ops_ptr, ops_len) -> result_ptr`                                        | Applies an edit payload; the result payload is the new PDF.                                                      |
| `pdf_core_merge(payload_ptr, payload_len, flags) -> result_ptr`                                          | Merges sources; `flags` bit 0 drops widgets, bit 1 packs object streams.                                         |
| `pdf_core_deflate(data_ptr, data_len) -> result_ptr`                                                     | The result payload is a zlib stream.                                                                             |
| `pdf_core_create(sizes_ptr, sizes_len) -> result_ptr`                                                    | `sizes_len` `f64` values, width and height per page; the payload is the new PDF.                                 |
| `pdf_core_font_metrics(name_ptr, name_len) -> result_ptr`                                                | Standard-14 font metrics; see the font metrics payload.                                                          |
| `pdf_core_png_size(png_ptr, png_len) -> result_ptr`                                                      | Decoded PNG `width` and `height` as two little-endian `u32` values.                                              |

`flags`: bit 0 = extract text, bit 1 = extract links, bit 2 = `pages_ptr` holds `pages_len` little-endian `u32` page indexes (otherwise every page), bit 3 = markdown output (`pdf_core_text`), bit 4 = drop running headers and footers (`pdf_core_text` and table continuation matching), bit 5 = split text items at repositioning and style changes (`pdf_core_inspect`), bit 6 = merge continuations across pages (`pdf_core_tables` and Markdown `pdf_core_text`), bit 7 = the explicit selection holds one page limit, bit 8 = force recovery in `pdf_core_lazy_plan`.

### Lazy handle and plan

| Export                                                                           | Contract                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdf_core_lazy_open(size, probe_bytes, gap_bytes, max_round_bytes) -> handle`    | Registers a document of `size` bytes and returns a nonzero handle, or `0` if the file size or handle space exceeds a limit.                                                                                                                                                                                                       |
| `pdf_core_lazy_feed(handle, offset, ptr, len) -> u32`                            | Copies `len` bytes from the caller's buffer at file offset `offset`. Returns `1` when accepted or `0` on an invalid handle or range.                                                                                                                                                                                              |
| `pdf_core_lazy_plan(handle, flags, pages_ptr, pages_len, profile) -> result_ptr` | Uses bits 2 and 7 for page selection and bit 8 to enter recovery. The success payload starts with a `u32` plan state.                                                                                                                                                                                                             |
| `pdf_core_lazy_run(handle, profile, flags, scale: f64) -> result_ptr`            | Runs the last ready plan, with the same profile and the standard text, tables, or render flags. Returns the text, tables, render, or page diagnostics payload. An empty successful payload requests recovery with plan flag bit 8. A single `u32` of value `1` asks the caller to plan more ranges before retrying the operation. |
| `pdf_core_lazy_full_bytes(handle) -> ptr`                                        | Borrows the complete recovered input from the handle. Returns zero until recovery finishes. The pointer is valid until the handle closes.                                                                                                                                                                                         |
| `pdf_core_lazy_trim(handle, limit) -> usize`                                     | Applies the selective cache byte limit and reports the remaining source bytes.                                                                                                                                                                                                                                                    |
| `pdf_core_lazy_close(handle)`                                                    | Releases the handle and all its cached bytes. Closing an unknown handle is harmless.                                                                                                                                                                                                                                              |

The profiles are `0` for text, `1` for tables, `2` for rendering, and `3` for page diagnostics. Plan states are `0` ready, `1` need ranges, `2` complete recovered input, and `3` need recovery ranges. In states `1` and `3`, the remaining payload is a sequence of little-endian `u32 offset, u32 length` pairs in file order. Feed each pair and call plan again with the same arguments. A plan or run result pointer of `0` indicates allocation failure.

### Result block

All integers are little-endian. The block is 8-byte aligned and `total_len` is the length to pass to `pdf_core_free`.

| Offset | Type  | Field                                                                                                       |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------- |
| 0      | `u32` | `total_len` — header plus payload                                                                           |
| 4      | `u32` | `status` — `0` ok, `1` invalid PDF, `2` encrypted, `3` limit exceeded, `4` unsupported, `5` invalid request |
| 8      | bytes | payload (UTF-8 reason when `status != 0`)                                                                   |

### Payload (version 3)

Payload offsets are relative to the payload start, so every float section stays 8-byte aligned in memory and can be viewed as a `Float64Array` without copying. Every section is padded with zero bytes to a multiple of 8.

Header (32 bytes), all `u32`: `magic` (`0x43464450`, "PDFC"), `version` (`3`), `page_count`, `link_count`, `text_page_count`, `pages_offset`, `links_offset`, `text_offset`.

Pages — `page_count` records of 72 bytes: `media_box` (4 × `f64`), `crop_box` (4 × `f64`), `rotate` (`i32`), 4 bytes padding.

Links — `link_count` records of 48 bytes: `rect` (4 × `f64`), `page_index` (`u32`), `uri_offset` (`u32`), `uri_len` (`u32`), 4 bytes padding; then one UTF-8 blob holding every URI (`uri_offset` is relative to the blob start), padded to 8.

Text — `text_page_count` pages back to back. Each page: header of 16 bytes (`page_index`, `item_count`, `text_len` — all `u32` — and 4 bytes padding); `item_count` × 5 `f64` (`x0`, `y0`, `x1`, `y1`, `font_size`); `item_count + 1` `u32` UTF-16 code unit offsets into the decoded text blob, padded to 8; `item_count` style bytes (bit 0 bold, bit 1 italic), padded to 8; the UTF-8 text blob of `text_len` bytes, padded to 8. Version 2 had no style bytes; version 1 used UTF-8 byte offsets.

### Text payload (version 1)

`pdf_core_text` uses the same result block and status codes. `flags` bits 2 (page indexes), 3 (markdown), 4 (drop running headers) and 6 (merge tables in Markdown) apply. The payload is little-endian and 8-byte aligned: `magic` (`0x58544450`, "PDTX"), `version` (`1`), `page_count`, `text_len` — all `u32`; then `page_count + 1` `u32` offsets into the blob, padded to 8; then the UTF-8 blob of `text_len` bytes, padded to 8. Page `n` is `blob[offsets[n]..offsets[n + 1]]`.

### Page diagnostics payload (version 1)

The 16-byte header contains four little-endian `u32` values `magic` (`0x47444450`, "PDDG"), `version` (`1`), page count, and padding. Each 24-byte record holds six `u32` values in this order: page index, text layer (`0` none, `1` usable, `2` weak), glyph count, usable character count, unmapped glyph count, and image count.

### Tables payload (version 2)

`pdf_core_tables` uses the same result block and status codes. `flags` bits 2 (page indexes), 4 (ignore running headers) and 6 (merge tables) apply. The payload is little-endian and 8-byte aligned. Header of 16 bytes, all `u32`: `magic` (`0x42544450`, "PDTB"), `version` (`2`), `table_count`, `cell_count`. Then `table_count` tables back to back, each a 56-byte record — `page_index`, `rows`, `cols`, `cell_count` (all `u32`), `bbox` (4 × `f64`), `last_page_index` (`u32`, inclusive) and 4 bytes of padding — followed by its cells in row-major order, 64 bytes each: `row`, `col`, `row_span`, `col_span` (all `u32`), `bbox` (4 × `f64`), `text_offset`, `text_len` (`u32`, relative to the text blob), `page_index` (`u32`), and 4 bytes of padding. The UTF-8 text blob follows the last record and is padded to 8.

### Signatures payload (version 2)

Header of 24 bytes, all `u32`: `magic` (`0x47534450`, "PDSG"), `version` (`2`), `failure` (`0` none, then `1`–`10` in the order `streamEnd`, `revisionLengths`, `indirectLengths`, `lengthBudget`, `dictionaryParse`, `revisionStructure`, `crossReferenceStream`, `objectStream`, `traversalBudget`, `invalidByteRange`), `flags` (bit 0 parse failed, bit 1 stream failed, bit 2 stream uncertain, bit 3 limit exceeded), `count`, padding. Then `count` records of 80 bytes: `object_number`, `generation`, `object_start`, `flags` (bit 0 document timestamp, bit 1 has `/ByteRange`, bit 2 has `/Contents`, bit 3 byte-range values valid, bit 4 unsigned placeholder), the `/ByteRange` span and the `/Contents` span (`key_start`, `value_start`, `value_end` each, all `u32`), the four byte-range values as `f64`, and `sub_filter_offset` and `sub_filter_len` (both `u32`). The offset is relative to the payload start, with zero indicating an absent name. The UTF-8 name blob follows the records and is padded to 8 bytes.

### Document payload (version 2)

Header of 32 bytes, all `u32`: `magic` (`0x49444450`, "PDDI"), `version` (`2`), `page_count`, `annotation_count`, `next_object_number`, `flags` (bit 0 AcroForm, bit 1 field name available, bit 2 field name failed), `field_failure` (`1`–`6`: depth, node budget, cyclic, name length, qualified name length, character budget), `field_name_len`. Pages are 80-byte records: `media_box` and `crop_box` (4 × `f64` each), `rotate` (`i32`), `ref_number`, `ref_generation` (`0` when the page is not indirect), `annotation_count`. Annotations are 72-byte records: `page_index`, `index`, `ref_number`, `ref_generation`, `flags` (bit 0 widget, bit 1 has rect, bit 2 has `/T`, bit 3 has a link URI), `slot` (`0` none, `1` open on the widget, `2` open on the referenced field, `3` open on the widget's direct `/Parent`, `4` malformed), `slot_a` (field object number, or `1` cyclic, `2` invalid parent, `3` depth), `slot_b` (field generation), `rect` (4 × `f64`), then `uri_offset` and `uri_len` (`u32`, relative to the URI blob). The UTF-8 URI blob (every link URI back to back) follows the records, then the UTF-8 field name, padded to 8. Version 1 had 64-byte records and no URIs.

### Font metrics payload (version 1)

Little-endian: `magic` (`0x4d464450`, "PDFM"), `version` (`1`), then 256 records of `unicode` and `width` (`u16` each), indexed by WinAnsi code.

### Edit payload (version 1)

Little-endian and unaligned: `magic` (`0x44455044`, "PDED"), `version` (`1`), `flags` (bits 0–1 mode: `0` auto, `1` incremental, `2` rewrite; bit 2 object streams), `count`, then `count` operations. Each operation starts with its opcode (`1` setObject … `10` image, `11` standardFont, `12` signature, `13` repairCatalog, `14` png). Byte strings are a `u32` length followed by the bytes; references are `number`, `generation`; optional references use number `0` for none; targets are `kind` (`0` catalog, `1` page, `2` object), two `u32` arguments (page index, or number and generation), a step count, and steps (`0` + key bytes, or `1` + `u32` index).

### Signature preparation and revision changes payloads

All values are little-endian and unaligned. Integers are `u32` unless specified. A sized string or byte array is a byte length followed by data. Strings are UTF-8. Object references are number and generation, with zero number indicating an absent reference. Optional request data begins with a 0/1 presence word.

- Preparation request (`0x52505350`, version 1) contains the field selector (0 existing, 1 create), name, page and four `f64` rectangle coordinates for create, contents capacity, SubFilter (0 CAdES, 1 PKCS#7), SHA-512 flag, DocMDP permission (0 absent), date, and optional reason, location, and contact. The lock word (0 absent, 1 All, 2 Include, 3 Exclude) precedes a counted list of field names when present. The optional appearance contains counted text lines (bold flag, `f64` size and two positions, color, text), optional border (width and color), and optional image (rectangle and PNG bytes). Colors use a component count and `f64` components.
- Preparation result (`0x4F505350`, version 1) contains four ByteRange numbers, the two contents offsets, 32 raw SHA-256 bytes, sized SHA-512 bytes (zero length when absent), and the sized PDF.
- Fields result (`0x46435350`, version 1) contains DocMDP, a counted list of revision ends, and a counted list of fields. Each field has name, reference, and flags (bits 0 signed, 1 signature details, 2 lock). Signature details contain an optional four-element `f64` ByteRange, revision end (zero absent), and SubFilter. The lock contains action and a counted list of names. Each counted widget has a reference, a page index (`0xFFFFFFFF` absent), and an optional four-element `f64` rectangle.
- Changes result (`0x48435350`, version 1) contains a page-change flag and a count. Each 20-byte record has a reference, category (indices 0 through 9 in `PdfCoreRevisionChangeKindSchema` order), flags (bit 0 added, bit 1 removed), and revision end.

### Merge payload

`count`, then per source `pdf_len` and `page_count` (`0xFFFFFFFF` for every page) followed by that many page indexes, then the PDFs back to back.

### Render payload (version 1)

`pdf_core_render` uses the same result block and status codes; only `flags` bit 2 applies. Header of 16 bytes: `magic` (`0x4C524450`, "PDRL"), `version` (`1`), `page_count`, padding (all `u32`). Then one section per page, 8-byte aligned: `page_index` (`u32`), `rotate` (`i32`), `ops_len` (`u32`), `blob_count` (`u32`), `view` (4 × `f64`), `section_len` (`u32`, from the section start to the next section), padding (`u32`); the `ops_len` op bytes, padded to 8; `blob_count` × (`offset`, `len`) `u32` pairs relative to the blob data, padded to 8; the blob data, each blob padded to 8.

Ops are a byte code followed by little-endian operands (`f32` numbers, `u32` counts and ids). A matrix is 6 × `f32`; a path is `u32` verb count, verbs (`0` move 2, `1` line 2, `2` cubic 6, `3` close 0, `4` quadratic 4 coordinates), `u32` coordinate count, `f32` coordinates. Paths and images are in PDF user space under the last `TRANSFORM`; the painter maps user space to device pixels from `view`, `rotate` and the scale.

| Code | Op                | Operands                                                                                                                                                                                                                       |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `SAVE`            | —                                                                                                                                                                                                                              |
| 2    | `RESTORE`         | —                                                                                                                                                                                                                              |
| 3    | `TRANSFORM`       | matrix (absolute CTM)                                                                                                                                                                                                          |
| 4    | `PATH`            | path (becomes the current path)                                                                                                                                                                                                |
| 5    | `FILL`            | `u8` rule (`0` non-zero, `1` even-odd)                                                                                                                                                                                         |
| 6    | `STROKE`          | —                                                                                                                                                                                                                              |
| 7    | `CLIP`            | `u8` rule                                                                                                                                                                                                                      |
| 8    | `FILL_COLOR`      | 4 × `u8` RGBA                                                                                                                                                                                                                  |
| 9    | `STROKE_COLOR`    | 4 × `u8` RGBA                                                                                                                                                                                                                  |
| 10   | `LINE_WIDTH`      | `f32`                                                                                                                                                                                                                          |
| 11   | `LINE_CAP`        | `u8`                                                                                                                                                                                                                           |
| 12   | `LINE_JOIN`       | `u8`                                                                                                                                                                                                                           |
| 13   | `MITER`           | `f32`                                                                                                                                                                                                                          |
| 14   | `DASH`            | `u32` count, `f32` lengths, `f32` phase                                                                                                                                                                                        |
| 15   | `BLEND`           | `u8` PDF blend mode (`0` Normal … `15` Luminosity)                                                                                                                                                                             |
| 16   | `GLYPH_DEFINE`    | `u32` id, path in glyph space                                                                                                                                                                                                  |
| 17   | `GLYPH`           | `u8` modes (`1` fill, `2` stroke, `4` add to text clip), `u32` id, matrix (glyph space to user space)                                                                                                                          |
| 18   | `TEXT_CLIP`       | — (clip with the glyphs collected since the last `TEXT_CLIP`)                                                                                                                                                                  |
| 19   | `TEXT`            | `u8` flags (`1` serif, `2` monospace, `4` bold, `8` italic, `16` fill, `32` stroke), matrix (em space to user space), `f32` advance in em, `u32` length, UTF-8 text                                                            |
| 20   | `IMAGE`           | `u8` flags (`1` JPEG, `2` JPEG soft mask, `4` matte, `8` interpolate), `u8` alpha, `u32` blob, width, height, mask blob (`0xFFFFFFFF` none), mask width, mask height, 4 × `u8` matte RGB + padding; drawn into the unit square |
| 21   | `SHADE`           | gradient: `u8` flags (`1` radial, `2` extend start, `4` extend end), 6 × `f32` coordinates (`x0 y0 x1 y1` or `x0 y0 r0 x1 y1 r1`), `u32` stop count, stops (`f32` offset, 4 × `u8` RGBA)                                       |
| 22   | `FILL_GRADIENT`   | gradient flags and coordinates, matrix (pattern space to page space), stops; later fills use it until the next fill colour                                                                                                     |
| 23   | `STROKE_GRADIENT` | same as `FILL_GRADIENT` for strokes                                                                                                                                                                                            |

Raw image blobs are RGBA (`width × height × 4`); stencil masks carry the opaque fill colour and the fill alpha travels only in the `IMAGE` alpha operand; raw mask blobs are 8-bit alpha (`mask width × mask height`); JPEG blobs are the stream bytes after any non-image filters.

## Development

```sh
cd crates/pdf
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

### Formal verification

Kani 0.68 runs from `crates/pdf` as `cargo kani -Z stubbing --exact --harness <name>` with `RUSTFLAGS=--cap-lints=warn` (Kani's injected prelude trips the crate's deny lints). The `Kani proofs (pdf-core)` CI job lists the proven harnesses explicitly, every row below except the one marked not in CI: 11 harnesses, about 155 s of CBMC time and 3 minutes wall locally including the build. Times are CBMC verification times with the default CaDiCaL solver.

Proven (every input within the stated bound):

| Harness                                                                    | Property                                                                                                                                                                         | Bound                                                                                                | Time             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| `columns::proofs::column_slots_cover_every_item_and_split_both_sides`      | every item of a column region lands in exactly one of the four parts, and items on both sides of a gutter land in different parts, so the recursive split shrinks and terminates | any `usize` line and gutter                                                                          | 1 s              |
| `markdown::proofs::glue_only_drops_a_trailing_break_hyphen`                | joining two lines drops a character only when the left fragment ends in `-` or a soft hyphen after a non-empty stem, and never panics on multibyte input                         | UTF-8 fragments of 4 and 2 bytes, hyphenation heuristics and `char` classes stubbed nondeterministic | 18 s             |
| `markdown::proofs::page_joins_pair_body_with_body_and_notes_with_notes`    | a page continuation pairs body with body and footnote with footnote, never touches captions or tables, and only appends a paragraph to a paragraph or list item                  | two pages of two blocks, any kind, band, size and line count                                         | 17 s             |
| `syntax::proofs::object_headers_never_panic`                               | `N G obj` header parsing never panics and never returns an end past the input                                                                                                    | 8 arbitrary bytes, any offset                                                                        | 48 s             |
| `syntax::proofs::unsigned_numbers_read_every_leading_digit`                | `read_unsigned` returns exactly the decimal value of the leading digits and stops after the last one, or rejects without moving                                                  | 6 arbitrary bytes, any start                                                                         | 4 s              |
| `syntax::proofs::find_bytes_returns_the_first_match_at_or_after_the_start` | the keyword search behind `startxref`, `xref` and `endstream` lookups returns the first match at or after the start, or none                                                     | 7-byte haystack, 2-byte needle, any start                                                            | 49 s             |
| `filters::proofs::png_reconstruction_matches_the_png_specification`        | PNG row reconstruction (None, Sub, Up, Average, Paeth and unknown tags) equals the PNG specification                                                                             | every byte tuple                                                                                     | 1 s              |
| `filters::proofs::packed_samples_round_trip_and_leave_neighbours_alone`    | the packed-sample reader and writer used by the TIFF predictor round-trip a sample and leave every other sample untouched                                                        | 3-byte row, 1, 2, 4, 8 and 16 bits per component                                                     | 17 s             |
| `filters::proofs::ascii_hex_output_respects_its_budget`                    | `ASCIIHexDecode` never exceeds the output budget                                                                                                                                 | 5 arbitrary bytes, budget up to 4                                                                    | 12 s             |
| `filters::proofs::ascii85_full_groups_decode_to_big_endian_words`          | every full `ASCII85Decode` group whose value fits in 32 bits decodes to its big-endian bytes                                                                                     | every 5-character group                                                                              | 12 s             |
| `inflate::proofs::bit_reader_returns_bits_lsb_first_and_never_overreads`   | the deflate bit reader returns bits least-significant first across its 8-byte refill and the byte-wise tail, and reports exhaustion instead of reading past the input            | 9 arbitrary bytes, two reads of up to 16 bits                                                        | 13 s             |
| `filters::proofs::run_length_output_respects_its_budget`                   | `RunLengthDecode` never exceeds the output budget                                                                                                                                | 3 arbitrary bytes, budget up to 3                                                                    | 411 s, not in CI |

Tested only (randomized properties, fuzzing and fixtures; CBMC does not converge within the 16 GiB job cap on code that allocates, sorts or recurses):

- Reading order, column splits, page joins and line joins: the proptests `reading_order_is_a_permutation`, `partitions_keep_every_item_exactly_once`, `column_layouts_keep_every_word_exactly_once`, `page_joins_conserve_blocks_and_skip_floats` and `line_joins_only_ever_drop_a_break_hyphen`. The XY-cut band step and whole-page join conservation harnesses exhausted memory even at two blocks and were removed.
- Portuguese hyphen rules: `hyphen_keeps_portuguese_clitics_prefixes_and_weekdays` and `hyphen_keeps_digit_groups_and_capitalised_continuations` check stems of up to 12 characters (their Kani versions did not converge).
- Inflate: `inflate_inverts_the_crate_compressor_at_every_cut` and `truncated_streams_yield_a_prefix_or_fail`; the whole-decoder and `copy_match` harnesses exhausted memory in the propositional reduction of their `Vec` copies.
- Stream predictors: `png_predictors_invert_png_filtering` (1 to 4 colours, every row tag, Predictor 10 to 15) and `tiff_predictor_inverts_tiff_differencing` (1, 2, 4, 8 and 16 bits per component).
- The object parser, content lexer and `startxref` lookup on arbitrary input: the fuzz targets below. Their Kani harnesses ran past the 10-minute budget.

Fuzzing uses `cargo-fuzz` on nightly from `crates/pdf` (`cargo +nightly fuzz run <target> --fuzz-dir fuzz fuzz/corpus/<target>`, seeded with `tests/fixtures/pdf/**/*.pdf`). The entry points live in `src/fuzzing.rs` behind `cfg(fuzzing)`:

- `markdown`, `tables`, `inspect` (inspection, diagnostics and form fields), `render` (first page), `signatures` (all three analyses and `revision_complete`).
- `edit_and_merge`: an empty incremental, rewrite or object-stream edit and a two-source merge; every written PDF must reopen.
- `lazy`: drives the range-request planner on the input bytes and asserts every planned range is in bounds, accepted, and that lazy text equals eager text whenever the lazy path answers.
- `decoders`: filter chains and functions of a single indirect object, raw inflate, CCITT, PNG, CMaps, font programs, Type 1 glyphs, the RC4 and AES ciphers, the content lexer and the object parser.

`bun run build` compiles the WASM crate for `wasm32-unknown-unknown` using the root toolchain pin and Rust `opt-level = 2` (the `build-wasm` Nx target), shrinks it with Binaryen `wasm-opt -O3`, and copies it to `dist/wasm/signature-kit.wasm`; it requires a Rust toolchain with that target installed. The size test caps the module at 1184 KiB. The [WASM optimization comparison](docs/signing-performance.md#wasm-optimization-comparison) records the size and runtime trade-offs.

## License

MIT. See `LICENSE`.
