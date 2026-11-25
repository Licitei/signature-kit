import { Context, Effect, Schema } from "effect";
import * as Transferable from "effect/workers/Transferable";
import { IcpBrasilPadesPolicy } from "./cms/icp-brasil.js";
import type { CmsError } from "./cms/config.js";
import type { A1Sessions, PdfRevision } from "./engine.js";
import { decodeSignatureContents, embedPreparedSignature } from "./pdf-contents.js";
import { A1SessionBinding, LocalError, PdfPrepareOptionsSchema, PdfWidget } from "./rpc.js";
import {
  PdfCorePrepareSignatureRequestSchema,
  PdfCorePreparedUpdateSchema,
} from "./wasm/config.js";
import type {
  PdfCoreError,
  PdfCorePrepareSignatureRequest,
  PdfCorePreparedUpdate,
  PdfCoreSignatureFields,
} from "./wasm/config.js";
import type { PdfCoreSigningSession } from "./wasm/pdf-core.js";

export const PrepareComputeInputSchema = Schema.Struct({
  options: PdfPrepareOptionsSchema,
  defaultLines: Schema.Array(Schema.String),
  date: Schema.String,
  contentsCapacity: PdfCorePrepareSignatureRequestSchema.fields.contentsCapacity,
});
export type PrepareComputeInput = (typeof PrepareComputeInputSchema)["Type"];

const ClonedBytes = Transferable.schema(Schema.Uint8Array, () => []);

export const PreparedComputeSchema = Schema.Struct({
  widget: PdfWidget,
  appearance: PdfCorePrepareSignatureRequestSchema.fields.appearance,
  prepared: Schema.Struct({
    ...PdfCorePreparedUpdateSchema.fields,
    appendix: ClonedBytes,
  }),
});
export type PreparedCompute = (typeof PreparedComputeSchema)["Type"];

export const SignComputeInputSchema = Schema.Struct({
  session: A1SessionBinding,
  policy: PdfPrepareOptionsSchema.fields.policy,
  signedAt: Schema.Date,
  digest: ClonedBytes,
  prepared: Schema.Struct({ ...PdfCorePreparedUpdateSchema.fields, appendix: ClonedBytes }),
});
export type SignComputeInput = (typeof SignComputeInputSchema)["Type"];

export type ComputeSource = { readonly key: string; readonly revision: PdfRevision };

export type SignatureComputeService = {
  readonly prepare: (
    source: ComputeSource,
    input: PrepareComputeInput,
  ) => Effect.Effect<PreparedCompute, LocalError>;
  readonly sign: (
    source: ComputeSource,
    input: SignComputeInput,
  ) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
  readonly release: (key: string) => Effect.Effect<void>;
};

export class SignaturePool extends Context.Service<
  SignaturePool,
  SignatureComputeService & {
    readonly size: number;
    readonly start: Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/engine/SignaturePool") {}

const resolveWidget = Effect.fnUntraced(function* (
  report: PdfCoreSignatureFields,
  { field, appearance }: PrepareComputeInput["options"],
): Effect.fn.Return<PdfWidget, LocalError> {
  if (report.docMdp === 1) return yield* new LocalError({ code: "documentLocked" });

  const matching = report.fields.filter(({ name }) => name === field.name);
  const selected = matching[0];
  if (matching.length > 1) return yield* new LocalError({ code: "fieldAmbiguous" });
  if (selected?.signed === true) return yield* new LocalError({ code: "fieldSigned" });
  if (field.kind === "create") {
    if (selected !== undefined) return yield* new LocalError({ code: "fieldAmbiguous" });
    return appearance.kind === "none"
      ? { kind: "invisible" }
      : { kind: "visible", page: field.page, rect: field.rect };
  }
  if (selected === undefined) return yield* new LocalError({ code: "fieldNotFound" });
  if (appearance.kind === "none") return { kind: "invisible" };
  const [widget] = selected.widgets;
  if (selected.widgets.length !== 1 || widget?.page === undefined || widget.rect === undefined) {
    return yield* new LocalError({ code: "fieldAmbiguous" });
  }
  return { kind: "visible", page: widget.page, rect: widget.rect };
});

const appearanceFor = (
  widget: PdfWidget,
  lines: readonly string[],
): PdfCorePrepareSignatureRequest["appearance"] => {
  if (widget.kind === "invisible") return { kind: "none" };
  const [left, bottom, right, top] = widget.rect;
  const width = right - left;
  const height = top - bottom;
  const size = Math.max(
    1,
    Math.min(
      10,
      (height - 4) / Math.max(lines.length, 1) / 1.2,
      (width - 4) / Math.max(...lines.map((line) => line.length), 1),
    ),
  );
  return {
    kind: "visible",
    lines: lines.map((text, index) => ({
      text,
      font: index === 0 ? "Helvetica-Bold" : "Helvetica",
      size,
      position: [2, Math.max(0, height - 2 - size * (1 + index * 1.2))],
      color: [0],
    })),
  };
};

export const prepareErrorCode = (reason: PdfCoreError["reason"]): LocalError["code"] => {
  switch (reason) {
    case "DocMDP forbids signing this document":
    case "DocMDP forbids creating signature fields":
    case "FieldMDP forbids changing the selected field":
      return "documentLocked";
    case "signature field name already exists":
    case "signature field name is ambiguous":
      return "fieldAmbiguous";
    case "signature field is missing":
    case "selected field is not a terminal signature field":
      return "fieldNotFound";
    case "signature field is already signed":
      return "fieldSigned";
    case undefined:
    default:
      return "pdfPrepareFailed";
  }
};

const expectedChanges = new Set(["signature", "signatureField", "widgetAppearance", "acroForm"]);

const selfVerify = Effect.fn("local.pdf.selfVerify")(function* (
  prepared: PdfCorePreparedUpdate,
  sourceLength: number,
  verifyCms: (cms: Uint8Array) => Effect.Effect<boolean, CmsError>,
  signed: Uint8Array,
  signing: PdfCoreSigningSession,
) {
  const { contentsStart, contentsEnd, byteRange } = prepared;
  const [start, firstLength, secondStart, secondLength] = byteRange;
  const byteLength = sourceLength + signed.byteLength;
  yield* Effect.annotateCurrentSpan("byteLength", byteLength);
  if (
    start !== 0 ||
    firstLength !== contentsStart - 1 ||
    secondStart !== contentsEnd + 1 ||
    secondStart + secondLength !== byteLength ||
    contentsStart <= sourceLength ||
    contentsEnd <= contentsStart ||
    signed.byteLength !== prepared.appendix.byteLength
  )
    return yield* new LocalError({ code: "selfVerificationFailed" });

  const report = yield* signing
    .signatures("verification")
    .pipe(Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })));
  const signature = report.dictionaries.find(
    (dictionary) =>
      dictionary.kind === "signature" &&
      dictionary.contents?.valueStart === firstLength &&
      dictionary.contents.valueEnd === secondStart &&
      dictionary.byteRangeValues?.every((value, index) => value === byteRange[index]),
  );
  if (report.failure !== undefined || signature === undefined) {
    return yield* new LocalError({ code: "selfVerificationFailed" });
  }
  const holeStart = contentsStart - sourceLength;
  const holeEnd = contentsEnd - sourceLength;
  if (signed[holeStart - 1] !== 0x3c || signed[holeEnd] !== 0x3e) {
    return yield* new LocalError({ code: "selfVerificationFailed" });
  }
  const result = yield* decodeSignatureContents(signed.subarray(holeStart, holeEnd)).pipe(
    Effect.withSpan("local.pdf.decodeContents"),
    Effect.flatMap((cms) => verifyCms(cms).pipe(Effect.withSpan("local.pdf.checkCms"))),
    Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })),
  );
  if (!result) return yield* new LocalError({ code: "selfVerificationFailed" });

  const changes = yield* signing
    .changes(sourceLength)
    .pipe(Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })));
  if (
    changes.pageContentChanged ||
    changes.changes.some(
      ({ kind, change }) => !expectedChanges.has(kind) || change === "removed",
    ) ||
    !changes.changes.some(
      ({ kind, change, revisionEnd }) =>
        kind === "signature" && change === "added" && revisionEnd === byteLength,
    )
  )
    return yield* new LocalError({ code: "selfVerificationFailed" });
});

export const makeLocalCompute = (
  a1: Context.Service.Shape<typeof A1Sessions>,
): SignatureComputeService => ({
  prepare: Effect.fnUntraced(function* ({ revision }, input) {
    const { options, defaultLines, date, contentsCapacity } = input;
    const widget = yield* resolveWidget(yield* revision.fields, options);
    const lines = options.appearance.kind === "visible" ? options.appearance.lines : undefined;
    const appearance = appearanceFor(widget, lines ?? defaultLines);
    const signing = yield* revision.signing;
    const prepared = yield* signing
      .prepare({
        field: options.field,
        appearance,
        date,
        contentsCapacity,
        reason: options.reason,
        location: options.location,
        docMdp: options.docMdp,
      })
      .pipe(
        Effect.mapError(
          ({ reason, code }) => new LocalError({ code: prepareErrorCode(reason), pdfCode: code }),
        ),
      );
    const sourceLength = revision.byteLength;
    const { appendix, byteRange, contentsStart, contentsEnd } = prepared;
    const [start, firstLength, secondStart, secondLength] = byteRange;
    if (
      start !== 0 ||
      contentsStart <= sourceLength ||
      contentsEnd <= contentsStart ||
      firstLength !== contentsStart - 1 ||
      secondStart !== contentsEnd + 1 ||
      secondStart + secondLength !== sourceLength + appendix.byteLength
    )
      return yield* new LocalError({ code: "pdfPrepareFailed" });
    return { widget, appearance, prepared };
  }),
  sign: Effect.fnUntraced(function* ({ revision }, input) {
    const { session, policy, signedAt, digest, prepared } = input;
    const certificate = yield* a1.certificate(session);
    const bindCms = yield* certificate.cms;
    const detached = yield* bindCms({
      messageDigest: digest,
      signingTime: signedAt,
      icpBrasil: policy === "icpBrasilAdRbV11" ? IcpBrasilPadesPolicy.adRbV11 : undefined,
    }).pipe(Effect.mapError(() => new LocalError({ code: "signFailed" })));
    const cms = yield* detached
      .sign((attributes) => a1.sign(session.sessionId, session.generation, attributes))
      .pipe(
        Effect.mapError((error) =>
          error._tag === "LocalError" ? error : new LocalError({ code: "signFailed" }),
        ),
        Effect.withSpan("local.pdf.cms", { attributes: { policy } }),
      );
    const sourceLength = revision.byteLength;
    const signed = yield* embedPreparedSignature(
      {
        pdf: prepared.appendix,
        contentsStart: prepared.contentsStart - sourceLength,
        contentsEnd: prepared.contentsEnd - sourceLength,
      },
      cms,
    ).pipe(Effect.withSpan("local.pdf.embed"));
    yield* revision.check(signed, (document) =>
      selfVerify(prepared, sourceLength, detached.verify, signed, document),
    );
    return signed;
  }),
  release: () => Effect.void,
});
