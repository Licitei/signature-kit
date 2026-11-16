# PDF generation: react-pdf → takumi-pdf

Licitei today builds printable PDFs with `@react-pdf/renderer` (client `usePDF` / `pdf().toBlob()`, server `renderToBuffer()`). Generation is moving to [`takumi-pdf`](https://www.npmjs.com/package/takumi-pdf) (0.20.0, MIT/Apache, Chromium-layout engine, vector PDF, subset fonts, tagged PDF by default). Parsing, anchor search, and signing stay on `@signature-kit/pdf-core` / `formats/pdf`.

## Runtime (spike)

| Environment | Entry | Wasm | Notes |
| --- | --- | --- | --- |
| Bun | `takumi-pdf` → `bundlers/bun.mjs` | `initSync` with bundled `takumi_pdf_wasm_bg.wasm` (~4.2 MiB) | No separate worker; same wasm path as Node in this repo’s benches. |
| Node ≥20.19 | `bundlers/node.mjs` | Same wasm + `initSync` | No native napi binding in the published 0.20.0 tarballs we installed. |
| Browser / Vite | `bundlers/vite.mjs` / `browser.mjs` | Lazy wasm URL via `./wasm-url` | Needs explicit font bytes; no system fonts. |
| Workers | `workerd.mjs` / `next.mjs` | wasm | Same contract as docs site. |

`render(jsx, options)` returns `Promise<Uint8Array>`. Reuse one `PdfRenderer` instance if you batch many documents (optional `prepare` + second `render` for warm paths).

## Feature mapping (react-pdf → takumi)

| react-pdf (app usage) | takumi-pdf | Gap / migration note |
| --- | --- | --- |
| `<Document>` / `<Page size="A4">` | `render(<main>…</main>, { size: "a4", margin })` | One tree; pages flow automatically. Per-page padding → CSS margin/padding on `main` or wrapper. |
| `<View>` flex layout | `<div tw="flex …">` or inline `style` | Flexbox + gap supported; yoga-like, not identical to react-pdf flex defaults. |
| `<Text>` + `StyleSheet` | `<p>`, `<span>`, `tw` / `className` | No `StyleSheet.create`; use Tailwind-like `tw` strings or CSS objects. |
| `Font.register({ family, src })` | `fonts: [{ name, data: Uint8Array }]` in `render` options | Register Liberation/Inter bytes per render or via `PdfRenderer.registerFont`. |
| `<Image src={url}>` | `images: [{ src, data }]` + `<img src={url}>` | Fetch logo/company images in the app; pass bytes (Licitei already resolves storage URLs for PDF). |
| `<Link>` | `<a href="…">` | URI links in PDF; use `licitei:assinatura` if link-based anchors are needed. |
| `position: "absolute"` footer on `<Page>` | `footer: <div>…</div>` render option or `tw="fixed"` bands | Prefer `footer` + `PageNumber` / `TotalPages` from `takumi-pdf/primitives`. |
| `<Text fixed render={({ pageNumber, totalPages }) => …}>` | `footer` with `<PageNumber />`, `<TotalPages />` | Same UX as session report / artifact footers. |
| `wrap={false}` on rows / tables | `break-inside: avoid` / pagination docs (`keepTogether`) | Map `tiptap-pdf-blocks` table rows and proposal total row to takumi pagination primitives. |
| `minPresenceAhead` | CSS break controls + `keepTogether` patterns in [pagination guide](https://takumi.kane.tw/docs/pdf/pagination) | Re-test `render-public-session-report-pdf` section headers. |
| `hyphenationCallback` | Built-in hyphenation / `lang` on root | Session report `keepWord` callback → set `lang: "pt-BR"` and verify long tokens. |
| `usePDF({ document })` | `useState` + `useEffect`/`useMemo` calling `render` → `Blob` | No built-in hook; small app wrapper around `render`. |
| `pdf(<Doc />).toBlob()` | `new Blob([await render(...)])` | Same boundary pattern in `build-statement-pdf-blob.tsx`. |
| `renderToBuffer()` (contract API) | `await render(...)` on server route | `contract-pdf-server.tsx` → async handler returning `Uint8Array`. |

## Gaps to plan for

- **Tiptap → layout**: `TiptapPdfBlocks` is react-pdf-specific (`View`/`Text`). Needs a parallel HTML/JSX mapper for takumi (tables, bullets, `wrap={false}` rows).
- **Proposal multi-page footer `fixed`**: Takumi `footer` option or fixed band; verify alignment with stamp anchor on last page.
- **Catalog item cards with remote images**: Preload `imageUrl` bytes into `images` array.
- **Tagged PDF / PDF-A**: Takumi defaults to tagged output; confirm ITI/signing pipeline tolerates structure (corpus `takumi-declaration.pdf` exercises pdf-core read path).
- **Bundle size**: ~4.2 MiB wasm vs react-pdf’s dependency graph; measure in the app shell separately.

## Suggested migration order (21 touchpoints)

1. **Shared utilities** (low risk, high reuse): `pdf-signature-anchor`, `pdf-styles` tokens → CSS/tw helpers; `pdf-company-logo` image bytes helper.
2. **Single-page artifacts**: `render-artifact-pdf.tsx`, `build-statement-pdf-blob.tsx` + `render-statement-pdf.tsx`.
3. **Headers**: `pdf-document-header.tsx` (logo + metadata).
4. **Rich blocks**: `tiptap-pdf-blocks.tsx` (largest structural change).
5. **Solicitation / weekly agenda**: `render-solicitation-pdf.tsx`, `weekly-agenda-pdf.tsx`.
6. **Catalog**: `render-catalog-pdf.tsx`, `step-preview.tsx` (`usePDF` → custom hook).
7. **Proposal**: `render-proposal-pdf.tsx`, `gerar-proposta.tsx` preview (`usePDF`).
8. **Session report** (hardest pagination): `render-public-session-report-pdf.tsx`.
9. **Artefacts wiring**: `artifact-file.tsx`, `proposal-artifact-preview.tsx`, `pecas-juridicas-card.tsx`.
10. **Server**: `contract-pdf-server.tsx`, `routes/api/contract/send.ts`.

Files importing `@react-pdf/renderer` in `app-licitei-next` today:

- `src/components/pdf/tiptap-pdf-blocks.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/_utils/pdf-styles.ts`
- `src/app/dashboard/minhas-licitacoes/[id]/_utils/pdf-signature-anchor.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/_utils/pdf-company-logo.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/_utils/pdf-document-header.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/_components/statements/render-statement-pdf.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/habilitacao/_utils/build-statement-pdf-blob.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/bidding-solicitation/_components/render-solicitation-pdf.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/gerar-proposta/_components/render-proposal-pdf.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/gerar-catalogo/_components/render-catalog-pdf.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/gerar-catalogo/_components/step-preview.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/_components/pecas-juridicas-card.tsx`
- `src/app/dashboard/minhas-licitacoes/[id]/gerar-proposta` route (`gerar-proposta.tsx`, `usePDF`)
- `src/app/dashboard/artefatos/_components/render-artifact-pdf.tsx`
- `src/app/dashboard/artefatos/_components/render-public-session-report-pdf.tsx`
- `src/app/dashboard/artefatos/_components/proposal-artifact-preview.tsx`
- `src/app/dashboard/artefatos/_utils/artifact-file.tsx`
- `src/app/dashboard/agenda/_components/weekly-agenda-pdf.tsx`
- `src/server/pdf/contract-pdf-server.tsx`
- `src/routes/api/contract/send.ts`

## Docs registry

The shadcn registry item `pdf-signature-anchor` is tied to `@react-pdf/renderer` `<Text>`. A takumi variant would be a second registry item with HTML + invisible `tw` styles; deferred until the app migration lands a stable anchor component.

## Corpus

`shared/pdf-core/scripts/generate-corpus.ts` emits `takumi-declaration.pdf` (multi-page Portuguese body, Liberation TTF, `[[licitei-assinatura]]` text token, `licitei:assinatura` link, footer page numbers). Goldens: `formats/pdf/scripts/capture-liteparse-goldens.ts` and tests in `formats/pdf/__tests__/text-anchors-golden.test.ts` + `shared/pdf-core/__tests__/liteparse-golden.test.ts`.