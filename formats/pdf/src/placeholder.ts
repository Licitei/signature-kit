import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type {
  PdfCoreAnnotation,
  PdfCoreEditOperation,
  PdfCoreEditTarget,
  PdfCoreFieldNameFailure,
  PdfCoreFieldTarget,
  PdfCoreObjectRef,
} from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Clock, Effect, Match, Schema } from "effect";
import { hasPdfByteRange } from "./byte-range.js";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  PdfSigningRequestSchema,
} from "./config.js";
import type { PdfSigningRequest } from "./config.js";
import { describePdf, resolvePlacementForDocument } from "./placement.js";

export const DEFAULT_SIGNATURE_LENGTH = 16384;
export const DEFAULT_ICP_BRASIL_SIGNATURE_LENGTH = 32768;
const SIGNATURES_EXIST = 0x01;
const APPEND_ONLY = 0x02;
const PRINT_ANNOTATION = 0x04;
const SIGNATURE_FIELD_NAME_PREFIX = "SignatureKitSignature";

const fieldNameFailureReasons = {
  depth: "Signature field hierarchy exceeds the supported depth.",
  nodeBudget: "Signature field hierarchy exceeds the supported node budget.",
  cyclic: "Signature field hierarchy is cyclic.",
  nameLength: "Signature field name exceeds the supported length.",
  qualifiedNameLength: "Fully-qualified signature field name exceeds the supported length.",
  characterBudget: "Signature field names exceed the supported processing budget.",
} satisfies Record<PdfCoreFieldNameFailure, string>;

const pdfNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/\.?0+$/u, "");

const pdfRef = (ref: PdfCoreObjectRef): string => `${ref.number} ${ref.generation} R`;

const pdfTextString = (text: string): string => {
  let hex = "FEFF";
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
};

const pdfDate = (date: Date): string => {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `(D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(
    date.getUTCDate(),
    2,
  )}${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z)`;
};

const widgetTarget = (widget: PdfCoreAnnotation): PdfCoreEditTarget =>
  widget.ref === undefined
    ? { base: { kind: "page", pageIndex: widget.pageIndex }, path: ["Annots", widget.index] }
    : { base: { kind: "object", ref: widget.ref } };

const fieldTarget = (widget: PdfCoreAnnotation, field: PdfCoreFieldTarget): PdfCoreEditTarget =>
  Match.value(field).pipe(
    Match.when({ kind: "widget" }, (): PdfCoreEditTarget => widgetTarget(widget)),
    Match.when({ kind: "object" }, (object): PdfCoreEditTarget => ({
      base: { kind: "object", ref: object.ref },
    })),
    Match.when({ kind: "widgetParent" }, (): PdfCoreEditTarget => {
      const target = widgetTarget(widget);
      return { base: target.base, path: [...(target.path ?? []), "Parent"] };
    }),
    Match.exhaustive,
  );

export const addSignaturePlaceholder = (
  input: PdfSigningRequest,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(PdfSigningRequestSchema)(input).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidBuilderInput,
            retryable: false,
            operation: PdfOperationValue.placeholder,
            reason: "PDF signing input failed schema validation.",
            issueMessage: String(issue),
          }),
      ),
    );
    const signed = yield* hasPdfByteRange(request.pdf);
    const document = yield* describePdf(request.pdf, {
      fieldNamePrefix: SIGNATURE_FIELD_NAME_PREFIX,
    });
    const placement = yield* resolvePlacementForDocument(
      request.pdf,
      document,
      request.appearance ?? {},
    );
    const page = document.pages[placement.pageIndex];
    if (page === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        reason: "The selected PDF page does not exist.",
        operation: PdfOperationValue.placeholder,
      });
    }

    const [left, bottom, right, top] = placement.widgetRect;
    const isInvisibleWidget =
      placement.invisible === true && left === 0 && bottom === 0 && right === 0 && top === 0;
    const isVisibleWidget =
      Number.isFinite(left) &&
      Number.isFinite(bottom) &&
      Number.isFinite(right) &&
      Number.isFinite(top) &&
      left < right &&
      bottom < top;
    if (!isInvisibleWidget && !isVisibleWidget) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        operation: PdfOperationValue.placeholder,
        reason: "Signature widget coordinates must form a finite non-empty rectangle.",
      });
    }

    const fieldName = document.fieldName;
    if (fieldName === undefined || fieldName._tag === "failed") {
      return yield* new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        operation: PdfOperationValue.placeholder,
        ...(fieldName === undefined ? {} : { reason: fieldNameFailureReasons[fieldName.reason] }),
      });
    }
    const pageRef = page.ref;
    if (pageRef === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        reason: "The selected PDF page is not an indirect object.",
        operation: PdfOperationValue.placeholder,
      });
    }

    const signatureLength =
      request.signatureLength ??
      (request.policy === "pades-icp-brasil"
        ? DEFAULT_ICP_BRASIL_SIGNATURE_LENGTH
        : DEFAULT_SIGNATURE_LENGTH);
    const subFilter =
      request.policy === "pades-icp-brasil" ? "ETSI.CAdES.detached" : "adbe.pkcs7.detached";
    yield* Effect.annotateCurrentSpan({
      "signature_kit.pdf.bytes": request.pdf.byteLength,
      "signature_kit.pdf.page_count": document.pages.length,
      "signature_kit.pdf.contents_bytes": signatureLength,
      "signature_kit.signature.subfilter": subFilter,
      "signature_kit.pdf.visible_widget": isVisibleWidget,
      "signature_kit.pdf.already_signed": signed,
    });
    const signingTime = request.signingTime ?? new Date(yield* Clock.currentTimeMillis);
    const signatureRef = { number: document.nextObjectNumber, generation: 0 };
    const widgetRef = { number: document.nextObjectNumber + 1, generation: 0 };
    const acroFormRef = { number: document.nextObjectNumber + 2, generation: 0 };
    const catalog: PdfCoreEditTarget = { base: { kind: "catalog" } };
    const acroForm: PdfCoreEditTarget = { base: { kind: "catalog" }, path: ["AcroForm"] };
    const operations: Array<PdfCoreEditOperation> = [
      {
        op: "signature",
        ref: signatureRef,
        contentsLength: signatureLength,
        entries: [
          `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter}`,
          `/Reason ${pdfTextString(request.reason ?? "Digital signature")}`,
          `/M ${pdfDate(signingTime)}`,
          `/ContactInfo ${pdfTextString(request.contactInfo ?? "")}`,
          `/Name ${pdfTextString(request.name ?? "SignatureKit signer")}`,
          `/Location ${pdfTextString(request.location ?? "")}`,
          "/Prop_Build << /Filter << /Name /Adobe.PPKLite >> /App << /Name /SignatureKit >> >> >>",
        ].join(" "),
      },
    ];
    if (!document.acroForm) {
      operations.push(
        { op: "setObject", ref: acroFormRef, value: "<< /Fields [] >>" },
        { op: "set", target: catalog, key: "AcroForm", value: pdfRef(acroFormRef) },
      );
    }
    const existingWidget = placement.existingWidgetObject;
    const existingField = placement.existingSignatureFieldObject;
    if (existingWidget !== undefined && existingField !== undefined) {
      const widget = widgetTarget(existingWidget);
      operations.push(
        {
          op: "set",
          target: fieldTarget(existingWidget, existingField),
          key: "V",
          value: pdfRef(signatureRef),
        },
        { op: "setFlags", target: widget, key: "F", flags: PRINT_ANNOTATION },
        { op: "set", target: widget, key: "P", value: pdfRef(pageRef) },
      );
      if (existingField.kind === "widget" && !existingWidget.titled) {
        operations.push({ op: "set", target: widget, key: "T", value: `(${fieldName.name})` });
      }
      operations.push({
        op: "setFlags",
        target: acroForm,
        key: "SigFlags",
        flags: SIGNATURES_EXIST | APPEND_ONLY,
      });
    } else {
      operations.push(
        {
          op: "setObject",
          ref: widgetRef,
          value: [
            "<< /Type /Annot /Subtype /Widget /FT /Sig",
            `/Rect [${placement.widgetRect.map(pdfNumber).join(" ")}]`,
            `/V ${pdfRef(signatureRef)} /T (${fieldName.name}) /F ${PRINT_ANNOTATION}`,
            `/P ${pdfRef(pageRef)} >>`,
          ].join(" "),
        },
        {
          op: "append",
          target: { base: { kind: "page", pageIndex: placement.pageIndex } },
          key: "Annots",
          value: pdfRef(widgetRef),
        },
        {
          op: "setFlags",
          target: acroForm,
          key: "SigFlags",
          flags: SIGNATURES_EXIST | APPEND_ONLY,
        },
        { op: "append", target: acroForm, key: "Fields", value: pdfRef(widgetRef) },
      );
    }

    const core = yield* PdfCore;
    return yield* core
      .edit(request.pdf, operations, { mode: signed ? "incremental" : "auto" })
      .pipe(
        Effect.mapError(
          (error) =>
            new PdfError({
              code: Match.value(error.code).pipe(
                Match.when(
                  PdfCoreErrorCodeValue.limitExceeded,
                  () => PdfErrorCodeValue.limitExceeded,
                ),
                Match.when(
                  PdfCoreErrorCodeValue.damagedXref,
                  () => PdfErrorCodeValue.damagedSignedPdf,
                ),
                Match.orElse(() => PdfErrorCodeValue.invalidPdf),
              ),
              retryable: false,
              operation: PdfOperationValue.placeholder,
              ...(error.reason === undefined ? {} : { reason: error.reason }),
            }),
        ),
      );
  }).pipe(Effect.withSpan(PdfOperationValue.placeholder));
