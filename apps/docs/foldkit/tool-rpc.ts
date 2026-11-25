import { CmsError } from "@signature-kit/cms/config";
import { PdfError } from "@signature-kit/pdf/config";
import { PdfCoreError } from "@signature-kit/pdf-core/config";
import { XmlError } from "@signature-kit/xml/config";
import { Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { WorkerSignatureKitErrorSchema } from "./signing-config.js";
import {
  CertificateReport,
  PdfExtractReport,
  PdfSignatureReport,
  XmlSignReport,
} from "./tool-config.js";

export const VerifyWorkerRequests = RpcGroup.make(
  Rpc.make("VerifyPdf", {
    payload: Schema.Struct({ pdf: Schema.Uint8Array }),
    success: Schema.Array(PdfSignatureReport),
    error: Schema.Union([PdfError, CmsError]),
  }),
);

export const CertificateWorkerRequests = RpcGroup.make(
  Rpc.make("ReadCertificate", {
    payload: Schema.Struct({ pfx: Schema.Uint8Array, password: Schema.String }),
    success: CertificateReport,
    error: WorkerSignatureKitErrorSchema,
  }),
);

export const XmlWorkerRequests = RpcGroup.make(
  Rpc.make("SignXml", {
    payload: Schema.Struct({
      xml: Schema.String,
      pfx: Schema.Uint8Array,
      password: Schema.String,
      referenceId: Schema.optional(Schema.NonEmptyString),
    }),
    success: XmlSignReport,
    error: Schema.Union([XmlError, WorkerSignatureKitErrorSchema]),
  }),
);

export const PdfCoreWorkerRequests = RpcGroup.make(
  Rpc.make("ExtractPdf", {
    payload: Schema.Struct({ pdf: Schema.Uint8Array }),
    success: PdfExtractReport,
    error: PdfCoreError,
  }),
);
