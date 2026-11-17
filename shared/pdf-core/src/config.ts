import { Schema } from "effect";

export const PdfCoreErrorCodeSchema = Schema.Literals([
  "pdfCore.WASM_LOAD_FAILED",
  "pdfCore.INVALID_PDF",
  "pdfCore.ENCRYPTED_PDF",
  "pdfCore.LIMIT_EXCEEDED",
  "pdfCore.UNSUPPORTED_FEATURE",
  "pdfCore.INVALID_OPTIONS",
]);
export type PdfCoreErrorCode = (typeof PdfCoreErrorCodeSchema)["Type"];

export const PdfCoreErrorCodeValue = {
  wasmLoadFailed: "pdfCore.WASM_LOAD_FAILED",
  invalidPdf: "pdfCore.INVALID_PDF",
  encryptedPdf: "pdfCore.ENCRYPTED_PDF",
  limitExceeded: "pdfCore.LIMIT_EXCEEDED",
  unsupportedFeature: "pdfCore.UNSUPPORTED_FEATURE",
  invalidOptions: "pdfCore.INVALID_OPTIONS",
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
    "pdfCore.ENCRYPTED_PDF": "Encrypted PDF documents are not supported.",
    "pdfCore.LIMIT_EXCEEDED": "The PDF document exceeds a processing limit.",
    "pdfCore.UNSUPPORTED_FEATURE": "The PDF document uses an unsupported feature.",
    "pdfCore.INVALID_OPTIONS": "Invalid PDF inspection options.",
  },
  "pt-BR": {
    "pdfCore.WASM_LOAD_FAILED": "Não foi possível carregar o módulo WebAssembly do núcleo PDF.",
    "pdfCore.INVALID_PDF": "Documento PDF inválido.",
    "pdfCore.ENCRYPTED_PDF": "Documentos PDF criptografados não são suportados.",
    "pdfCore.LIMIT_EXCEEDED": "O documento PDF excede um limite de processamento.",
    "pdfCore.UNSUPPORTED_FEATURE": "O documento PDF usa um recurso não suportado.",
    "pdfCore.INVALID_OPTIONS": "Opções de inspeção de PDF inválidas.",
  },
} satisfies Record<PdfCoreErrorMessageLocale, Record<PdfCoreErrorCode, string>>;

export const PdfCoreOperationSchema = Schema.Literals([
  "pdfCore.load",
  "pdfCore.inspect",
  "pdfCore.text",
  "pdfCore.tables",
]);
export type PdfCoreOperation = (typeof PdfCoreOperationSchema)["Type"];
export const PdfCoreOperationValue = {
  load: "pdfCore.load",
  inspect: "pdfCore.inspect",
  text: "pdfCore.text",
  tables: "pdfCore.tables",
} satisfies Record<string, PdfCoreOperation>;

export const PdfCoreSchemaNameSchema = Schema.Literals([
  "PdfCoreExports",
  "PdfCoreInspectOptions",
  "PdfCoreInspection",
  "PdfCoreTextOptions",
  "PdfCoreText",
  "PdfCoreTablesOptions",
  "PdfCoreTables",
]);
export type PdfCoreSchemaName = (typeof PdfCoreSchemaNameSchema)["Type"];
export const PdfCoreSchemaNameValue = {
  exports: "PdfCoreExports",
  inspectOptions: "PdfCoreInspectOptions",
  inspection: "PdfCoreInspection",
  textOptions: "PdfCoreTextOptions",
  text: "PdfCoreText",
  tablesOptions: "PdfCoreTablesOptions",
  tables: "PdfCoreTables",
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
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
});
export type PdfCoreInspectOptions = (typeof PdfCoreInspectOptionsSchema)["Type"];

export const PdfCoreTextFormatSchema = Schema.Literals(["text", "markdown"]);
export type PdfCoreTextFormat = (typeof PdfCoreTextFormatSchema)["Type"];

export const PdfCoreTextOptionsSchema = Schema.Struct({
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
  format: Schema.optional(PdfCoreTextFormatSchema),
  dropRunningHeaders: Schema.optional(Schema.Boolean),
});
export type PdfCoreTextOptions = (typeof PdfCoreTextOptionsSchema)["Type"];

export const PdfCoreTablesOptionsSchema = Schema.Struct({
  pageIndexes: Schema.optional(Schema.Array(pageIndexSchema)),
});
export type PdfCoreTablesOptions = (typeof PdfCoreTablesOptionsSchema)["Type"];

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
  row: pageIndexSchema,
  col: pageIndexSchema,
  rowSpan: pageIndexSchema,
  colSpan: pageIndexSchema,
  bbox: PdfCoreBoxSchema,
  text: Schema.String,
});
export type PdfCoreCell = (typeof PdfCoreCellSchema)["Type"];

export const PdfCoreTableSchema = Schema.Struct({
  pageIndex: pageIndexSchema,
  bbox: PdfCoreBoxSchema,
  rows: pageIndexSchema,
  cols: pageIndexSchema,
  cells: Schema.Array(PdfCoreCellSchema),
});
export type PdfCoreTable = (typeof PdfCoreTableSchema)["Type"];

export const PdfCoreTablesSchema = Schema.Array(PdfCoreTableSchema);
export type PdfCoreTables = (typeof PdfCoreTablesSchema)["Type"];

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

export const PdfCoreExportsSchema = Schema.Struct({
  memory: Schema.instanceOf(WebAssembly.Memory),
  pdf_core_alloc: Schema.declare(isAllocFunction, { identifier: "pdf_core_alloc" }),
  pdf_core_free: Schema.declare(isFreeFunction, { identifier: "pdf_core_free" }),
  pdf_core_inspect: Schema.declare(isInspectFunction, { identifier: "pdf_core_inspect" }),
  pdf_core_text: Schema.declare(isTextFunction, { identifier: "pdf_core_text" }),
  pdf_core_tables: Schema.declare(isTextFunction, { identifier: "pdf_core_tables" }),
});
export type PdfCoreExports = (typeof PdfCoreExportsSchema)["Type"];
