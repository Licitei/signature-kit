import type { PdfCoreNewSignatureFields } from "@signature-kit/engine/wasm/config";
import type { A1SessionBinding, PdfPrepareOptions } from "@signature-kit/engine/rpc";

export const signatories = [
  { name: "Contratante", page: 0, rect: [32, 35, 150, 75] },
  { name: "Contratada", page: 0, rect: [170, 35, 288, 75] },
] satisfies PdfCoreNewSignatureFields;
export const trustAt = new Date("2027-01-01T00:00:00.000Z");

export const existingField = (session: A1SessionBinding, name: string): PdfPrepareOptions => ({
  session,
  field: { kind: "existing", name },
  appearance: { kind: "visible" },
  policy: "cades",
});
