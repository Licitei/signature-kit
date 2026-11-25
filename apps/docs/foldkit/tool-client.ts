import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { cmsErrorMessages } from "@signature-kit/cms/config";
import { errorMessage } from "@signature-kit/i18n";
import { PdfErrorCodeValue, pdfErrorMessages } from "@signature-kit/pdf/config";
import { signatureKitErrorMessages } from "@signature-kit/signatures";
import { xmlErrorMessages } from "@signature-kit/xml/config";
import { Effect, Layer } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import { captureDocsEvent } from "./analytics";
import { pdfCoreErrorMessages } from "@signature-kit/pdf-core/config";
import { CertificateRead, PdfExtracted, PdfVerified, ToolFailed, XmlSigned } from "./tool-config";
import type { ToolId } from "./tool-config";
import {
  CertificateWorkerRequests,
  PdfCoreWorkerRequests,
  VerifyWorkerRequests,
  XmlWorkerRequests,
} from "./tool-rpc";

const workerProtocol = (spawn: () => Worker) =>
  Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(Effect.sync(spawn), (instance) =>
      Effect.sync(() => instance.terminate()),
    );
    return yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1 }).pipe(
        Layer.provide(BrowserWorker.layer(() => worker)),
      ),
    );
  });

const fileBytes = (file: File) =>
  Effect.promise(async () => new Uint8Array(await file.arrayBuffer()));

const describe = (error: { readonly _tag: string; readonly code?: string }) =>
  error._tag === "RpcClientError" || error._tag === "WorkerError"
    ? "Não foi possível iniciar a ferramenta. Recarregue a página e tente novamente."
    : errorMessage(error, {
        locale: "pt-BR",
        catalogs: [
          signatureKitErrorMessages,
          pdfErrorMessages,
          cmsErrorMessages,
          xmlErrorMessages,
          pdfCoreErrorMessages,
        ],
      });

const failedMessage = (tool: ToolId, run: number, message: string) => {
  captureDocsEvent("tool_finished", { tool, ok: false });
  return ToolFailed.make({ tool, run, message });
};

const unexpected = (tool: ToolId, run: number) => () =>
  Effect.sync(() =>
    failedMessage(
      tool,
      run,
      "Algo deu errado ao processar o arquivo. Recarregue a página e tente de novo.",
    ),
  );

export const verifyPdfFile = (file: File, run: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pdf = yield* fileBytes(file);
      const context = yield* workerProtocol(
        () => new Worker(new URL("./tool-verify.worker.ts", import.meta.url), { type: "module" }),
      );
      const client = yield* RpcClient.make(VerifyWorkerRequests).pipe(
        Effect.provideContext(context),
      );
      const reports = yield* client.VerifyPdf({ pdf });
      captureDocsEvent("tool_finished", {
        tool: "verify",
        ok: true,
        signature_count: reports.length,
      });
      return PdfVerified.make({ run, reports });
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        failedMessage(
          "verify",
          run,
          "code" in error && error.code === PdfErrorCodeValue.placeholderNotFound
            ? "Este PDF não tem assinatura digital."
            : describe(error),
        ),
      ),
    ),
    Effect.catchDefect(unexpected("verify", run)),
  );

export const readCertificateFile = (file: File, password: string, run: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pfx = yield* fileBytes(file);
      const context = yield* workerProtocol(
        () =>
          new Worker(new URL("./tool-certificate.worker.ts", import.meta.url), { type: "module" }),
      );
      const client = yield* RpcClient.make(CertificateWorkerRequests).pipe(
        Effect.provideContext(context),
      );
      const report = yield* client.ReadCertificate({ pfx, password });
      captureDocsEvent("tool_finished", { tool: "certificate", ok: true });
      return CertificateRead.make({ run, report });
    }),
  ).pipe(
    Effect.catch((error) => Effect.succeed(failedMessage("certificate", run, describe(error)))),
    Effect.catchDefect(unexpected("certificate", run)),
  );

export const extractPdfFile = (file: File, run: number, previousUrl: string | null) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pdf = yield* fileBytes(file);
      const context = yield* workerProtocol(
        () => new Worker(new URL("./tool-pdfcore.worker.ts", import.meta.url), { type: "module" }),
      );
      const client = yield* RpcClient.make(PdfCoreWorkerRequests).pipe(
        Effect.provideContext(context),
      );
      const report = yield* client.ExtractPdf({ pdf });
      if (previousUrl !== null) URL.revokeObjectURL(previousUrl);
      const image =
        report.image === null
          ? null
          : URL.createObjectURL(new Blob([new Uint8Array(report.image)], { type: "image/jpeg" }));
      captureDocsEvent("tool_finished", {
        tool: "pdfcore",
        ok: true,
        page_count: report.pageCount,
      });
      return PdfExtracted.make({
        run,
        pageCount: report.pageCount,
        characters: report.characters,
        extractMillis: report.extractMillis,
        renderMillis: report.renderMillis,
        lines: report.firstPage
          .split("\n")
          .filter((line) => line.trim() !== "")
          .slice(0, 80)
          .map((text, position) => ({ id: `line-${position}`, text })),
        image,
      });
    }),
  ).pipe(
    Effect.catch((error) => Effect.succeed(failedMessage("pdfcore", run, describe(error)))),
    Effect.catchDefect(unexpected("pdfcore", run)),
  );

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

export const xmlPreview = (xml: string) => {
  const lines: Array<{ id: string; added: boolean; text: string }> = [];
  let depth = 0;
  let signature = 0;
  let inline = false;
  for (const token of xml.match(/<[^>]+>|[^<]+/g) ?? []) {
    const text = token.trim();
    if (text === "") continue;
    const tag = text.startsWith("<");
    const closing = text.startsWith("</");
    const opening = tag && !closing && !text.startsWith("<?") && !text.endsWith("/>");
    if (closing) depth = Math.max(0, depth - 1);
    if (/^<(?:\w+:)?Signature[\s>]/.test(text)) signature = depth + 1;
    const last = lines.at(-1);
    if (!tag && last !== undefined) {
      last.text += clip(text, 40);
      inline = true;
    } else if (closing && inline && last !== undefined) {
      last.text += text;
      inline = false;
    } else {
      lines.push({
        id: `line-${lines.length}`,
        added: signature > 0,
        text: `${"  ".repeat(depth)}${clip(text, 72)}`,
      });
      inline = false;
    }
    if (closing && signature > 0 && depth < signature) signature = 0;
    if (opening) depth += 1;
  }
  const first = lines.findIndex((line) => line.added);
  const last = lines.findLastIndex((line) => line.added);
  if (first === -1) return lines.slice(0, 24);
  const head = lines.slice(0, first);
  return [
    ...head.slice(0, 6),
    ...(head.length > 9 ? [{ id: "gap", added: false, text: "  …" }] : []),
    ...(head.length > 9 ? head.slice(-3) : head.slice(6)),
    ...lines.slice(first, last + 1),
    ...lines.slice(last + 1, last + 4),
  ];
};

export const signXmlFile = (
  input: {
    xml: File;
    pfx: File;
    password: string;
    referenceId: string;
    previousUrl: string | null;
  },
  run: number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const bytes = yield* fileBytes(input.xml);
      const xml = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => ToolFailed.make({ tool: "xml", run, message: "" }),
      });
      const pfx = yield* fileBytes(input.pfx);
      const context = yield* workerProtocol(
        () => new Worker(new URL("./tool-xml.worker.ts", import.meta.url), { type: "module" }),
      );
      const client = yield* RpcClient.make(XmlWorkerRequests).pipe(Effect.provideContext(context));
      const report = yield* client.SignXml({
        xml,
        pfx,
        password: input.password,
        ...(input.referenceId === "" ? {} : { referenceId: input.referenceId }),
      });
      if (input.previousUrl !== null) URL.revokeObjectURL(input.previousUrl);
      const blob = new Blob([report.xml], { type: "application/xml" });
      const signedXmlUrl = URL.createObjectURL(blob);
      captureDocsEvent("tool_finished", { tool: "xml", ok: true });
      return XmlSigned.make({
        run,
        url: signedXmlUrl,
        preview: xmlPreview(report.xml),
        fileName: input.xml.name.replace(/\.xml$/i, "").concat("-assinado.xml"),
        bytes: blob.size,
        signer: report.signer,
        verified: report.verified,
        referenceUris: report.referenceUris,
      });
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        failedMessage(
          "xml",
          run,
          error._tag === "ToolFailed"
            ? "O XML precisa estar codificado em UTF-8."
            : describe(error),
        ),
      ),
    ),
    Effect.catchDefect(unexpected("xml", run)),
  );
