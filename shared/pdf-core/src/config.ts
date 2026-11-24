import { Schema } from "effect";

export const PdfCoreErrorCodeSchema = Schema.Literals([
  "pdfCore.WASM_LOAD_FAILED",
  "pdfCore.INVALID_PDF",
  "pdfCore.ENCRYPTED_PDF",
  "pdfCore.LIMIT_EXCEEDED",
  "pdfCore.UNSUPPORTED_FEATURE",
  "pdfCore.INVALID_OPTIONS",
  "pdfCore.PAINT_FAILED",
  "pdfCore.RANGE_READ_FAILED",
  "pdfCore.DOCUMENT_CLOSED",
  "pdfCore.DAMAGED_XREF",
]);
export type PdfCoreErrorCode = (typeof PdfCoreErrorCodeSchema)["Type"];

export const PdfCoreErrorCodeValue = {
  wasmLoadFailed: "pdfCore.WASM_LOAD_FAILED",
  invalidPdf: "pdfCore.INVALID_PDF",
  encryptedPdf: "pdfCore.ENCRYPTED_PDF",
  limitExceeded: "pdfCore.LIMIT_EXCEEDED",
  unsupportedFeature: "pdfCore.UNSUPPORTED_FEATURE",
  invalidOptions: "pdfCore.INVALID_OPTIONS",
  paintFailed: "pdfCore.PAINT_FAILED",
  rangeReadFailed: "pdfCore.RANGE_READ_FAILED",
  documentClosed: "pdfCore.DOCUMENT_CLOSED",
  damagedXref: "pdfCore.DAMAGED_XREF",
} satisfies Record<string, PdfCoreErrorCode>;

export const PdfCoreErrorMessageLocaleSchema = Schema.Literals(["en-US", "pt-BR"]);
export type PdfCoreErrorMessageLocale = (typeof PdfCoreErrorMessageLocaleSchema)["Type"];
export const PdfCoreErrorMessagesSchema = Schema.Record(
  PdfCoreErrorMessageLocaleSchema,
  Schema.Record(PdfCoreErrorCodeSchema, Schema.String),
);
export type PdfCoreErrorMessages = (typeof PdfCoreErrorMessagesSchema)["Type"];

export const pdfCoreErrorMessages = {
  "en-US": {
    "pdfCore.WASM_LOAD_FAILED": "The PDF core WebAssembly module could not be loaded.",
    "pdfCore.INVALID_PDF": "Invalid PDF document.",
    "pdfCore.ENCRYPTED_PDF": "The operation could not process this encrypted PDF.",
    "pdfCore.LIMIT_EXCEEDED": "The PDF document exceeds a processing limit.",
    "pdfCore.UNSUPPORTED_FEATURE": "The PDF document uses an unsupported feature.",
    "pdfCore.INVALID_OPTIONS": "Invalid PDF options.",
    "pdfCore.PAINT_FAILED": "The PDF page could not be painted.",
    "pdfCore.RANGE_READ_FAILED": "The PDF byte range could not be read.",
    "pdfCore.DOCUMENT_CLOSED": "The PDF document is closed.",
    "pdfCore.DAMAGED_XREF":
      "The PDF cross-reference chain is damaged, so changes cannot be appended without rewriting the file.",
  },
  "pt-BR": {
    "pdfCore.WASM_LOAD_FAILED": "Não foi possível carregar o módulo WebAssembly do núcleo PDF.",
    "pdfCore.INVALID_PDF": "Documento PDF inválido.",
    "pdfCore.ENCRYPTED_PDF": "A operação não pôde processar este PDF criptografado.",
    "pdfCore.LIMIT_EXCEEDED": "O documento PDF excede um limite de processamento.",
    "pdfCore.UNSUPPORTED_FEATURE": "O documento PDF usa um recurso não suportado.",
    "pdfCore.INVALID_OPTIONS": "Opções de PDF inválidas.",
    "pdfCore.PAINT_FAILED": "Não foi possível desenhar a página do PDF.",
    "pdfCore.RANGE_READ_FAILED": "Não foi possível ler o intervalo de bytes do PDF.",
    "pdfCore.DOCUMENT_CLOSED": "O documento PDF está fechado.",
    "pdfCore.DAMAGED_XREF":
      "A tabela de referências cruzadas do PDF está danificada; não é possível acrescentar alterações sem reescrever o arquivo.",
  },
} satisfies Record<PdfCoreErrorMessageLocale, Record<PdfCoreErrorCode, string>>;

export const PdfCoreOperationSchema = Schema.Literals([
  "pdfCore.load",
  "pdfCore.openLazy",
  "pdfCore.readRange",
  "pdfCore.inspect",
  "pdfCore.text",
  "pdfCore.tables",
  "pdfCore.pageDiagnostics",
  "pdfCore.render",
  "pdfCore.paint",
  "pdfCore.signatures",
  "pdfCore.revision",
  "pdfCore.document",
  "pdfCore.edit",
  "pdfCore.merge",
  "pdfCore.deflate",
  "pdfCore.create",
  "pdfCore.fontMetrics",
  "pdfCore.pngSize",
]);
export type PdfCoreOperation = (typeof PdfCoreOperationSchema)["Type"];
export const PdfCoreOperationValue = {
  load: "pdfCore.load",
  openLazy: "pdfCore.openLazy",
  readRange: "pdfCore.readRange",
  inspect: "pdfCore.inspect",
  text: "pdfCore.text",
  tables: "pdfCore.tables",
  pageDiagnostics: "pdfCore.pageDiagnostics",
  render: "pdfCore.render",
  paint: "pdfCore.paint",
  signatures: "pdfCore.signatures",
  revision: "pdfCore.revision",
  document: "pdfCore.document",
  edit: "pdfCore.edit",
  merge: "pdfCore.merge",
  deflate: "pdfCore.deflate",
  create: "pdfCore.create",
  fontMetrics: "pdfCore.fontMetrics",
  pngSize: "pdfCore.pngSize",
} satisfies Record<string, PdfCoreOperation>;

export const PdfCoreSchemaNameSchema = Schema.Literals([
  "PdfCoreExports",
  "PdfCoreLazyOptions",
  "PdfCoreInspectOptions",
  "PdfCoreInspection",
  "PdfCoreTextOptions",
  "PdfCoreText",
  "PdfCoreTablesOptions",
  "PdfCoreTables",
  "PdfCorePageDiagnosticsOptions",
  "PdfCorePageDiagnostics",
  "PdfCoreRenderOptions",
  "PdfCoreDisplayLists",
  "PdfCorePaintOptions",
  "PdfCoreSignatureReport",
  "PdfCoreDocumentOptions",
  "PdfCoreDocument",
  "PdfCoreEditOperations",
  "PdfCoreEditOptions",
  "PdfCoreMergeSources",
  "PdfCoreMergeOptions",
  "PdfCoreCreateOptions",
  "PdfCoreFontName",
]);
export type PdfCoreSchemaName = (typeof PdfCoreSchemaNameSchema)["Type"];
export const PdfCoreSchemaNameValue = {
  exports: "PdfCoreExports",
  lazyOptions: "PdfCoreLazyOptions",
  inspectOptions: "PdfCoreInspectOptions",
  inspection: "PdfCoreInspection",
  textOptions: "PdfCoreTextOptions",
  text: "PdfCoreText",
  tablesOptions: "PdfCoreTablesOptions",
  tables: "PdfCoreTables",
  pageDiagnosticsOptions: "PdfCorePageDiagnosticsOptions",
  pageDiagnostics: "PdfCorePageDiagnostics",
  renderOptions: "PdfCoreRenderOptions",
  displayLists: "PdfCoreDisplayLists",
  paintOptions: "PdfCorePaintOptions",
  signatureReport: "PdfCoreSignatureReport",
  documentOptions: "PdfCoreDocumentOptions",
  document: "PdfCoreDocument",
  editOperations: "PdfCoreEditOperations",
  editOptions: "PdfCoreEditOptions",
  mergeSources: "PdfCoreMergeSources",
  mergeOptions: "PdfCoreMergeOptions",
  createOptions: "PdfCoreCreateOptions",
  fontName: "PdfCoreFontName",
} satisfies Record<string, PdfCoreSchemaName>;

export class PdfCoreError extends Schema.TaggedError<
  PdfCoreError,
  { readonly brand: unique symbol }
>()("PdfCoreError", {
  code: PdfCoreErrorCodeSchema,
  operation: Schema.optional(PdfCoreOperationSchema),
  reason: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Int),
  schemaName: Schema.optional(PdfCoreSchemaNameSchema),
  issueMessage: Schema.optional(Schema.String),
}) {
  get message(): string {
    return this.reason ?? pdfCoreErrorMessages["en-US"][this.code];
  }
}

const maxUint32 = 0xffff_ffff;
const pageIndexSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxUint32 }));

export const PdfCoreInspectOptionsSchema = Schema.Struct({
  text: Schema.Boolean,
  links: Schema.Boolean,
  runs: Schema.optional(Schema.Boolean),
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
});
export type PdfCoreInspectOptions = (typeof PdfCoreInspectOptionsSchema)["Type"];

export const PdfCoreTextFormatSchema = Schema.Literals(["text", "markdown"]);
export type PdfCoreTextFormat = (typeof PdfCoreTextFormatSchema)["Type"];

export const PdfCoreTextOptionsSchema = Schema.Struct({
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
  format: Schema.optional(PdfCoreTextFormatSchema),
  dropRunningHeaders: Schema.optional(Schema.Boolean),
  mergeAcrossPages: Schema.optional(Schema.Boolean),
});
export type PdfCoreTextOptions = (typeof PdfCoreTextOptionsSchema)["Type"];

export const PdfCoreTablesOptionsSchema = Schema.Struct({
  dropRunningHeaders: Schema.optional(Schema.Boolean),
  mergeAcrossPages: Schema.optional(Schema.Boolean),
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
});
export type PdfCoreTablesOptions = (typeof PdfCoreTablesOptionsSchema)["Type"];

export const PdfCorePageDiagnosticsOptionsSchema = Schema.Struct({
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
});
export type PdfCorePageDiagnosticsOptions = (typeof PdfCorePageDiagnosticsOptionsSchema)["Type"];

export const PdfCoreTextLayerSchema = Schema.Literals(["none", "usable", "weak"]);
export type PdfCoreTextLayer = (typeof PdfCoreTextLayerSchema)["Type"];

export const PdfCorePageDiagnosticsSchema = Schema.Array(
  Schema.Struct({
    pageIndex: pageIndexSchema,
    textLayer: PdfCoreTextLayerSchema,
    glyphs: pageIndexSchema,
    usableChars: pageIndexSchema,
    unmapped: pageIndexSchema,
    imageCount: pageIndexSchema,
  }),
);
export type PdfCorePageDiagnostics = (typeof PdfCorePageDiagnosticsSchema)["Type"];

export const PDF_CORE_DEFAULT_RENDER_SCALE = 150 / 72;
const renderScaleSchema = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(64),
);

export const PdfCoreRenderOptionsSchema = Schema.Struct({
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
  scale: Schema.optional(renderScaleSchema),
});
export type PdfCoreRenderOptions = (typeof PdfCoreRenderOptionsSchema)["Type"];

export const PdfCoreImageTypeSchema = Schema.Literals(["image/png", "image/webp", "image/jpeg"]);
export type PdfCoreImageType = (typeof PdfCoreImageTypeSchema)["Type"];
export const PDF_CORE_DEFAULT_PAGE_IMAGE_TYPE: PdfCoreImageType = "image/png";

export const PdfCorePaintOptionsSchema = Schema.Struct({
  scale: Schema.optional(renderScaleSchema),
  type: Schema.optional(PdfCoreImageTypeSchema),
  quality: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
});
export type PdfCorePaintOptions = (typeof PdfCorePaintOptionsSchema)["Type"];

export const PdfCoreTextSchema = Schema.Array(Schema.String);
export type PdfCoreText = (typeof PdfCoreTextSchema)["Type"];

export const PdfCoreBoxSchema = Schema.Tuple([
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
]);
export type PdfCoreBox = (typeof PdfCoreBoxSchema)["Type"];

export const PdfCoreCellSchema = Schema.Struct({
  pageIndex: Schema.optional(pageIndexSchema),
  row: pageIndexSchema,
  col: pageIndexSchema,
  rowSpan: pageIndexSchema,
  colSpan: pageIndexSchema,
  bbox: PdfCoreBoxSchema,
  text: Schema.String,
});
export type PdfCoreCell = (typeof PdfCoreCellSchema)["Type"];

export const PdfCoreTableSchema = Schema.Struct({
  pages: Schema.optional(Schema.Array(pageIndexSchema)),
  pageIndex: pageIndexSchema,
  bbox: PdfCoreBoxSchema,
  rows: pageIndexSchema,
  cols: pageIndexSchema,
  cells: Schema.Array(PdfCoreCellSchema),
});
export type PdfCoreTable = (typeof PdfCoreTableSchema)["Type"];

export const PdfCoreTablesSchema = Schema.Array(PdfCoreTableSchema);
export type PdfCoreTables = (typeof PdfCoreTablesSchema)["Type"];

export const PdfCoreDisplayListSchema = Schema.Struct({
  pageIndex: pageIndexSchema,
  view: PdfCoreBoxSchema,
  rotate: Schema.Int,
  scale: renderScaleSchema,
  ops: Schema.instanceOf(Uint8Array),
  blobs: Schema.Array(Schema.instanceOf(Uint8Array)),
});
export type PdfCoreDisplayList = (typeof PdfCoreDisplayListSchema)["Type"];

export const PdfCoreDisplayListsSchema = Schema.Array(PdfCoreDisplayListSchema);
export type PdfCoreDisplayLists = (typeof PdfCoreDisplayListsSchema)["Type"];

export const PdfCorePageSchema = Schema.Struct({
  mediaBox: PdfCoreBoxSchema,
  cropBox: PdfCoreBoxSchema,
  rotate: Schema.Int,
});
export type PdfCorePage = (typeof PdfCorePageSchema)["Type"];

export const PdfCoreLinkSchema = Schema.Struct({
  pageIndex: pageIndexSchema,
  uri: Schema.String,
  rect: PdfCoreBoxSchema,
});
export type PdfCoreLink = (typeof PdfCoreLinkSchema)["Type"];

export const PdfCoreTextPageSchema = Schema.Struct({
  pageIndex: pageIndexSchema,
  rects: Schema.instanceOf(Float64Array),
  text: Schema.String,
  offsets: Schema.instanceOf(Uint32Array),
  styles: Schema.instanceOf(Uint8Array),
});
export type PdfCoreTextPage = (typeof PdfCoreTextPageSchema)["Type"];

export const PdfCoreInspectionSchema = Schema.Struct({
  pages: Schema.Array(PdfCorePageSchema),
  links: Schema.Array(PdfCoreLinkSchema),
  text: Schema.Array(PdfCoreTextPageSchema),
});
export type PdfCoreInspection = (typeof PdfCoreInspectionSchema)["Type"];

const isAllocFunction = (value: unknown): value is (length: number) => number =>
  typeof value === "function" && value.length === 1;
const isFreeFunction = (value: unknown): value is (pointer: number, length: number) => void =>
  typeof value === "function" && value.length === 2;
const isInspectFunction = (
  value: unknown,
): value is (
  pdfPointer: number,
  pdfLength: number,
  flags: number,
  pagesPointer: number,
  pagesLength: number,
) => number => typeof value === "function" && value.length === 5;
const isTextFunction = isInspectFunction;
const isRenderFunction = (
  value: unknown,
): value is (
  pdfPointer: number,
  pdfLength: number,
  flags: number,
  pagesPointer: number,
  pagesLength: number,
  scale: number,
) => number => typeof value === "function" && value.length === 6;
const isBufferFunction = (value: unknown): value is (pointer: number, length: number) => number =>
  typeof value === "function" && value.length === 2;
const isSignaturesFunction = (
  value: unknown,
): value is (pdfPointer: number, pdfLength: number, mode: number) => number =>
  typeof value === "function" && value.length === 3;
const isDocumentFunction = (
  value: unknown,
): value is (
  pdfPointer: number,
  pdfLength: number,
  flags: number,
  pagesPointer: number,
  pagesLength: number,
  prefixPointer: number,
  prefixLength: number,
) => number => typeof value === "function" && value.length === 7;
const isEditFunction = (
  value: unknown,
): value is (
  pdfPointer: number,
  pdfLength: number,
  operationsPointer: number,
  operationsLength: number,
) => number => typeof value === "function" && value.length === 4;

const isLazyOpenFunction = (
  value: unknown,
): value is (size: number, probe: number, gap: number, roundBytes: number) => number =>
  typeof value === "function" && value.length === 4;
const isLazyCloseFunction = (value: unknown): value is (handle: number) => void =>
  typeof value === "function" && value.length === 1;
const isLazyFullBytesFunction = (value: unknown): value is (handle: number) => number =>
  typeof value === "function" && value.length === 1;
const isLazyTrimFunction = (value: unknown): value is (handle: number, limit: number) => number =>
  typeof value === "function" && value.length === 2;
const isLazyFeedFunction = (
  value: unknown,
): value is (handle: number, offset: number, pointer: number, length: number) => number =>
  typeof value === "function" && value.length === 4;
const isLazyPlanFunction = (
  value: unknown,
): value is (
  handle: number,
  flags: number,
  pages: number,
  count: number,
  profile: number,
) => number => typeof value === "function" && value.length === 5;
const isLazyRunFunction = (
  value: unknown,
): value is (handle: number, profile: number, flags: number, scale: number) => number =>
  typeof value === "function" && value.length === 4;

export const PdfCoreExportsSchema = Schema.Struct({
  memory: Schema.instanceOf(WebAssembly.Memory),
  pdf_core_alloc: Schema.declare(isAllocFunction, { identifier: "pdf_core_alloc" }),
  pdf_core_free: Schema.declare(isFreeFunction, { identifier: "pdf_core_free" }),
  pdf_core_inspect: Schema.declare(isInspectFunction, { identifier: "pdf_core_inspect" }),
  pdf_core_text: Schema.declare(isTextFunction, { identifier: "pdf_core_text" }),
  pdf_core_tables: Schema.declare(isTextFunction, { identifier: "pdf_core_tables" }),
  pdf_core_page_diagnostics: Schema.declare(isTextFunction, {
    identifier: "pdf_core_page_diagnostics",
  }),
  pdf_core_render: Schema.declare(isRenderFunction, { identifier: "pdf_core_render" }),
  pdf_core_signatures: Schema.declare(isSignaturesFunction, { identifier: "pdf_core_signatures" }),
  pdf_core_revision_complete: Schema.declare(isSignaturesFunction, {
    identifier: "pdf_core_revision_complete",
  }),
  pdf_core_document: Schema.declare(isDocumentFunction, { identifier: "pdf_core_document" }),
  pdf_core_edit: Schema.declare(isEditFunction, { identifier: "pdf_core_edit" }),
  pdf_core_merge: Schema.declare(isSignaturesFunction, { identifier: "pdf_core_merge" }),
  pdf_core_deflate: Schema.declare(isBufferFunction, { identifier: "pdf_core_deflate" }),
  pdf_core_create: Schema.declare(isBufferFunction, { identifier: "pdf_core_create" }),
  pdf_core_font_metrics: Schema.declare(isBufferFunction, { identifier: "pdf_core_font_metrics" }),
  pdf_core_png_size: Schema.declare(isBufferFunction, { identifier: "pdf_core_png_size" }),
  pdf_core_lazy_open: Schema.declare(isLazyOpenFunction, { identifier: "pdf_core_lazy_open" }),
  pdf_core_lazy_close: Schema.declare(isLazyCloseFunction, { identifier: "pdf_core_lazy_close" }),
  pdf_core_lazy_full_bytes: Schema.declare(isLazyFullBytesFunction, {
    identifier: "pdf_core_lazy_full_bytes",
  }),
  pdf_core_lazy_feed: Schema.declare(isLazyFeedFunction, { identifier: "pdf_core_lazy_feed" }),
  pdf_core_lazy_plan: Schema.declare(isLazyPlanFunction, { identifier: "pdf_core_lazy_plan" }),
  pdf_core_lazy_run: Schema.declare(isLazyRunFunction, { identifier: "pdf_core_lazy_run" }),
  pdf_core_lazy_trim: Schema.declare(isLazyTrimFunction, { identifier: "pdf_core_lazy_trim" }),
});
export type PdfCoreExports = (typeof PdfCoreExportsSchema)["Type"];

const byteOffsetSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxUint32 }));

export const PDF_CORE_MAX_LAZY_BYTES = 512 * 1024 * 1024;
export const PdfCoreLazyOptionsSchema = Schema.Struct({
  allowFullRead: Schema.optional(Schema.Boolean),
  maxCachedBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: PDF_CORE_MAX_LAZY_BYTES })),
  ),
  pageLimit: Schema.optional(pageIndexSchema),
  probeBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 1024 * 1024 })),
  ),
  gapBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1024 * 1024 })),
  ),
  maxRoundBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 64 * 1024 * 1024 })),
  ),
});
export type PdfCoreLazyOptions = (typeof PdfCoreLazyOptionsSchema)["Type"];
export const PdfCoreLazyStatsSchema = Schema.Struct({
  bytesRead: Schema.Int,
  cachedBytes: Schema.Int,
  rounds: Schema.Int,
  strategy: Schema.Literals(["lazy", "fallback"]),
});
export type PdfCoreLazyStats = (typeof PdfCoreLazyStatsSchema)["Type"];

const safeOffsetSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const PdfCoreRangeSizeSchema = safeOffsetSchema;

export const PdfCoreSignatureAnalysisSchema = Schema.Literals([
  "scan",
  "dictionaries",
  "verification",
]);
export type PdfCoreSignatureAnalysis = (typeof PdfCoreSignatureAnalysisSchema)["Type"];

export const PdfCoreSignatureFailureSchema = Schema.Literals([
  "streamEnd",
  "revisionLengths",
  "indirectLengths",
  "lengthBudget",
  "dictionaryParse",
  "revisionStructure",
  "crossReferenceStream",
  "objectStream",
  "traversalBudget",
  "invalidByteRange",
]);
export type PdfCoreSignatureFailure = (typeof PdfCoreSignatureFailureSchema)["Type"];

export const PdfCoreFieldSpanSchema = Schema.Struct({
  keyStart: byteOffsetSchema,
  valueStart: byteOffsetSchema,
  valueEnd: byteOffsetSchema,
});
export type PdfCoreFieldSpan = (typeof PdfCoreFieldSpanSchema)["Type"];

export const PdfCoreSignatureDictionaryKindSchema = Schema.Literals([
  "signature",
  "documentTimestamp",
]);
export type PdfCoreSignatureDictionaryKind = (typeof PdfCoreSignatureDictionaryKindSchema)["Type"];

export const PdfCoreSignatureDictionarySchema = Schema.Struct({
  kind: PdfCoreSignatureDictionaryKindSchema,
  objectNumber: byteOffsetSchema,
  generation: byteOffsetSchema,
  objectStart: byteOffsetSchema,
  byteRange: Schema.optional(PdfCoreFieldSpanSchema),
  byteRangeValues: Schema.optional(
    Schema.Tuple([safeOffsetSchema, safeOffsetSchema, safeOffsetSchema, safeOffsetSchema]),
  ),
  contents: Schema.optional(PdfCoreFieldSpanSchema),
  unsignedPlaceholder: Schema.Boolean,
  subFilter: Schema.optional(Schema.String),
});
export type PdfCoreSignatureDictionary = (typeof PdfCoreSignatureDictionarySchema)["Type"];

export const PdfCoreSignatureReportSchema = Schema.Struct({
  failure: Schema.optional(PdfCoreSignatureFailureSchema),
  parseFailed: Schema.Boolean,
  streamFailed: Schema.Boolean,
  streamUncertain: Schema.Boolean,
  limitExceeded: Schema.Boolean,
  dictionaries: Schema.Array(PdfCoreSignatureDictionarySchema),
});
export type PdfCoreSignatureReport = (typeof PdfCoreSignatureReportSchema)["Type"];

export const PdfCoreObjectRefSchema = Schema.Struct({
  number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxUint32 })),
  generation: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
});
export type PdfCoreObjectRef = (typeof PdfCoreObjectRefSchema)["Type"];

export const PdfCoreDocumentOptionsSchema = Schema.Struct({
  annotationPages: Schema.optional(Schema.Array(pageIndexSchema)),
  fieldNamePrefix: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});
export type PdfCoreDocumentOptions = (typeof PdfCoreDocumentOptionsSchema)["Type"];

export const PdfCoreDocumentPageSchema = Schema.Struct({
  ref: Schema.optional(PdfCoreObjectRefSchema),
  mediaBox: PdfCoreBoxSchema,
  cropBox: PdfCoreBoxSchema,
  rotate: Schema.Int,
  annotationCount: byteOffsetSchema,
});
export type PdfCoreDocumentPage = (typeof PdfCoreDocumentPageSchema)["Type"];

export const PdfCoreFieldTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("widget") }),
  Schema.Struct({ kind: Schema.Literal("widgetParent") }),
  Schema.Struct({ kind: Schema.Literal("object"), ref: PdfCoreObjectRefSchema }),
]);
export type PdfCoreFieldTarget = (typeof PdfCoreFieldTargetSchema)["Type"];

export const PdfCoreSignatureSlotFailureSchema = Schema.Literals([
  "cyclic",
  "invalidParent",
  "depth",
]);
export type PdfCoreSignatureSlotFailure = (typeof PdfCoreSignatureSlotFailureSchema)["Type"];

export const PdfCoreSignatureSlotSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("open"), field: PdfCoreFieldTargetSchema }),
  Schema.Struct({
    kind: Schema.Literal("malformed"),
    reason: PdfCoreSignatureSlotFailureSchema,
  }),
]);
export type PdfCoreSignatureSlot = (typeof PdfCoreSignatureSlotSchema)["Type"];

export const PdfCoreAnnotationSchema = Schema.Struct({
  pageIndex: pageIndexSchema,
  index: byteOffsetSchema,
  ref: Schema.optional(PdfCoreObjectRefSchema),
  widget: Schema.Boolean,
  titled: Schema.Boolean,
  rect: Schema.optional(PdfCoreBoxSchema),
  uri: Schema.optional(Schema.String),
  signatureSlot: PdfCoreSignatureSlotSchema,
});
export type PdfCoreAnnotation = (typeof PdfCoreAnnotationSchema)["Type"];

export const PdfCoreFieldNameFailureSchema = Schema.Literals([
  "depth",
  "nodeBudget",
  "cyclic",
  "nameLength",
  "qualifiedNameLength",
  "characterBudget",
]);
export type PdfCoreFieldNameFailure = (typeof PdfCoreFieldNameFailureSchema)["Type"];

export const PdfCoreFieldNameSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("available"), name: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("failed"), reason: PdfCoreFieldNameFailureSchema }),
]);
export type PdfCoreFieldName = (typeof PdfCoreFieldNameSchema)["Type"];

export const PdfCoreDocumentSchema = Schema.Struct({
  nextObjectNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxUint32 })),
  acroForm: Schema.Boolean,
  pages: Schema.Array(PdfCoreDocumentPageSchema),
  annotations: Schema.Array(PdfCoreAnnotationSchema),
  fieldName: Schema.optional(PdfCoreFieldNameSchema),
});
export type PdfCoreDocument = (typeof PdfCoreDocumentSchema)["Type"];

const pdfKeySchema = Schema.String.check(Schema.isMinLength(1));

export const PdfCoreEditTargetSchema = Schema.Struct({
  base: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("catalog") }),
    Schema.Struct({ kind: Schema.Literal("page"), pageIndex: pageIndexSchema }),
    Schema.Struct({ kind: Schema.Literal("object"), ref: PdfCoreObjectRefSchema }),
  ]),
  path: Schema.optional(Schema.Array(Schema.Union([pdfKeySchema, byteOffsetSchema]))),
});
export type PdfCoreEditTarget = (typeof PdfCoreEditTargetSchema)["Type"];

export const PdfCoreResourceCategorySchema = Schema.Literals([
  "Font",
  "XObject",
  "ExtGState",
  "ColorSpace",
  "Pattern",
  "Shading",
  "Properties",
]);
export type PdfCoreResourceCategory = (typeof PdfCoreResourceCategorySchema)["Type"];

export const PdfCoreStandardFontSchema = Schema.Literals([
  "Courier",
  "Courier-Bold",
  "Courier-BoldOblique",
  "Courier-Oblique",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-BoldOblique",
  "Helvetica-Oblique",
  "Times-Roman",
  "Times-Bold",
  "Times-BoldItalic",
  "Times-Italic",
  "Symbol",
  "ZapfDingbats",
]);
export type PdfCoreStandardFont = (typeof PdfCoreStandardFontSchema)["Type"];

export const MAX_PDF_CORE_SIGNATURE_CONTENTS = 16 * 1024 * 1024;

export const PdfCoreEditOperationSchema = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("setObject"),
    ref: PdfCoreObjectRefSchema,
    value: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("setStream"),
    ref: PdfCoreObjectRefSchema,
    dict: Schema.String,
    data: Schema.Uint8Array,
    compress: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    op: Schema.Literal("set"),
    target: PdfCoreEditTargetSchema,
    key: pdfKeySchema,
    value: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    target: PdfCoreEditTargetSchema,
    key: pdfKeySchema,
  }),
  Schema.Struct({
    op: Schema.Literal("append"),
    target: PdfCoreEditTargetSchema,
    key: pdfKeySchema,
    value: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("removeItem"),
    target: PdfCoreEditTargetSchema,
    key: pdfKeySchema,
    value: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("setFlags"),
    target: PdfCoreEditTargetSchema,
    key: pdfKeySchema,
    flags: byteOffsetSchema,
  }),
  Schema.Struct({
    op: Schema.Literal("appendContent"),
    pageIndex: pageIndexSchema,
    ref: PdfCoreObjectRefSchema,
    wrapRef: Schema.optional(PdfCoreObjectRefSchema),
    data: Schema.Uint8Array,
    compress: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    op: Schema.Literal("addResource"),
    pageIndex: pageIndexSchema,
    category: PdfCoreResourceCategorySchema,
    name: pdfKeySchema,
    value: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("image"),
    ref: PdfCoreObjectRefSchema,
    softMaskRef: Schema.optional(PdfCoreObjectRefSchema),
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxUint32 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxUint32 })),
    colorSpace: Schema.Literals(["gray", "rgb"]),
    alpha: Schema.Boolean,
    samples: Schema.Uint8Array,
  }),
  Schema.Struct({
    op: Schema.Literal("png"),
    ref: PdfCoreObjectRefSchema,
    softMaskRef: Schema.optional(PdfCoreObjectRefSchema),
    png: Schema.Uint8Array,
  }),
  Schema.Struct({
    op: Schema.Literal("standardFont"),
    ref: PdfCoreObjectRefSchema,
    baseFont: PdfCoreStandardFontSchema,
  }),
  Schema.Struct({
    op: Schema.Literal("signature"),
    ref: PdfCoreObjectRefSchema,
    contentsLength: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_PDF_CORE_SIGNATURE_CONTENTS }),
    ),
    entries: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("repairCatalog") }),
]);
export type PdfCoreEditOperation = (typeof PdfCoreEditOperationSchema)["Type"];

export const PdfCoreEditOperationsSchema = Schema.Array(PdfCoreEditOperationSchema);
export type PdfCoreEditOperations = (typeof PdfCoreEditOperationsSchema)["Type"];

export const PdfCoreWriteModeSchema = Schema.Literals(["auto", "incremental", "rewrite"]);
export type PdfCoreWriteMode = (typeof PdfCoreWriteModeSchema)["Type"];

export const PdfCoreEditOptionsSchema = Schema.Struct({
  mode: Schema.optional(PdfCoreWriteModeSchema),
  objectStreams: Schema.optional(Schema.Boolean),
});
export type PdfCoreEditOptions = (typeof PdfCoreEditOptionsSchema)["Type"];

export const PdfCoreMergeSourceSchema = Schema.Struct({
  pdf: Schema.Uint8Array,
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
});
export type PdfCoreMergeSource = (typeof PdfCoreMergeSourceSchema)["Type"];

export const PdfCoreMergeSourcesSchema = Schema.Array(PdfCoreMergeSourceSchema).check(
  Schema.isMinLength(1),
);
export type PdfCoreMergeSources = (typeof PdfCoreMergeSourcesSchema)["Type"];

export const PdfCoreMergeOptionsSchema = Schema.Struct({
  dropWidgets: Schema.optional(Schema.Boolean),
  objectStreams: Schema.optional(Schema.Boolean),
});
export type PdfCoreMergeOptions = (typeof PdfCoreMergeOptionsSchema)["Type"];

export const MAX_PDF_CORE_PAGE_SIDE = 14_400;

const pageSideSchema = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_PDF_CORE_PAGE_SIDE),
);

export const PdfCoreCreateOptionsSchema = Schema.Struct({
  pages: Schema.NonEmptyArray(
    Schema.Struct({ width: pageSideSchema, height: pageSideSchema }),
  ).check(Schema.isMaxLength(10_000)),
});
export type PdfCoreCreateOptions = (typeof PdfCoreCreateOptionsSchema)["Type"];

export const PdfCoreWinAnsiFontSchema = Schema.Literals([
  "Courier",
  "Courier-Bold",
  "Courier-BoldOblique",
  "Courier-Oblique",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-BoldOblique",
  "Helvetica-Oblique",
  "Times-Roman",
  "Times-Bold",
  "Times-BoldItalic",
  "Times-Italic",
]);
export type PdfCoreWinAnsiFont = (typeof PdfCoreWinAnsiFontSchema)["Type"];

export const PdfCoreFontMetricsSchema = Schema.Struct({
  baseFont: PdfCoreWinAnsiFontSchema,
  unicode: Schema.instanceOf(Uint16Array),
  widths: Schema.instanceOf(Uint16Array),
});
export type PdfCoreFontMetrics = (typeof PdfCoreFontMetricsSchema)["Type"];

export const PdfCorePngSizeSchema = Schema.Struct({
  width: Schema.Int,
  height: Schema.Int,
});
export type PdfCorePngSize = (typeof PdfCorePngSizeSchema)["Type"];
