import { Button, FileDrop, Input } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command, File } from "foldkit";
import type { Html } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineView } from "foldkit/submodel";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { shell } from "./styles/shell";
import { signing } from "./styles/signing";
import { className, sx } from "./styles/sx";
import { tools } from "./styles/tools";
import {
  CertificateRead,
  CertificateReadFields,
  PdfExtracted,
  PdfExtractedFields,
  TextLine,
  XmlPreviewLine,
  CertificateReport,
  PdfSignatureReport,
  PdfVerified,
  PdfVerifiedFields,
  ToolFailed,
  ToolFailedFields,
  XmlSigned,
  XmlSignedFields,
} from "./tool-config";
import type { ToolId } from "./tool-config";

const DropTarget = Schema.Literals(["verify", "certificate", "xml", "xmlPfx", "pdfcore"]);
type DropTarget = typeof DropTarget.Type;

const Idle = Schema.TaggedStruct("Idle", {});
const Working = Schema.TaggedStruct("Working", {});
const Failed = Schema.TaggedStruct("Failed", { message: Schema.String });
const Verified = Schema.TaggedStruct("Verified", { reports: Schema.Array(PdfSignatureReport) });
const Read = Schema.TaggedStruct("Read", { report: CertificateReport });
const Extracted = Schema.TaggedStruct("Extracted", {
  pageCount: Schema.Int,
  characters: Schema.Int,
  extractMillis: Schema.Finite,
  renderMillis: Schema.NullOr(Schema.Finite),
  lines: Schema.Array(TextLine),
  image: Schema.NullOr(Schema.String),
});
const Signed = Schema.TaggedStruct("Signed", {
  preview: Schema.Array(XmlPreviewLine),
  url: Schema.String,
  fileName: Schema.String,
  bytes: Schema.Int,
  signer: Schema.String,
  verified: Schema.Boolean,
  referenceUris: Schema.Array(Schema.String),
});
const idle = Idle.make({});
const working = Working.make({});

export const ToolsModel = Schema.Struct({
  run: Schema.Int,
  verifyDrop: FileDrop.Model,
  verifyFile: Schema.Option(Schema.String),
  verify: Schema.Union([Idle, Working, Failed, Verified]),
  certificateDrop: FileDrop.Model,
  certificateFile: Schema.Option(File.File),
  certificate: Schema.Union([Idle, Working, Failed, Read]),
  xmlDrop: FileDrop.Model,
  xmlPfxDrop: FileDrop.Model,
  xmlFile: Schema.Option(File.File),
  xmlPfx: Schema.Option(File.File),
  xml: Schema.Union([Idle, Working, Failed, Signed]),
  pdfcoreDrop: FileDrop.Model,
  pdfcoreFile: Schema.Option(Schema.String),
  pdfcore: Schema.Union([Idle, Working, Failed, Extracted]),
});
export type ToolsModel = typeof ToolsModel.Type;

export const Message = defineMessageUnion({
  GotDropMessage: { targetId: DropTarget, message: FileDrop.Message },
  CertificateSubmitted: {},
  XmlSubmitted: {},
  PdfVerified: PdfVerifiedFields,
  CertificateRead: CertificateReadFields,
  XmlSigned: XmlSignedFields,
  PdfExtracted: PdfExtractedFields,
  ToolFailed: ToolFailedFields,
});
export type Message = typeof Message.Type;

export const toolsInit = (): ToolsModel => ({
  run: 0,
  verifyDrop: FileDrop.init({ id: "tool-verify-pdf" }),
  verifyFile: Option.none(),
  verify: idle,
  certificateDrop: FileDrop.init({ id: "tool-certificate-pfx" }),
  certificateFile: Option.none(),
  certificate: idle,
  xmlDrop: FileDrop.init({ id: "tool-xml-file" }),
  xmlPfxDrop: FileDrop.init({ id: "tool-xml-pfx" }),
  xmlFile: Option.none(),
  xmlPfx: Option.none(),
  xml: idle,
  pdfcoreDrop: FileDrop.init({ id: "tool-pdfcore-pdf" }),
  pdfcoreFile: Option.none(),
  pdfcore: idle,
});

const fieldValue = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";

export const VerifyPdf = Command.define("VerifyPdf", {
  args: { file: File.File, run: Schema.Int },
  messages: [PdfVerified, ToolFailed],
  execute: ({ file, run }) =>
    Effect.promise(() => import("./tool-client")).pipe(
      Effect.flatMap((client) => client.verifyPdfFile(file, run)),
    ),
});

export const ExtractPdf = Command.define("ExtractPdf", {
  args: { file: File.File, run: Schema.Int, previousUrl: Schema.NullOr(Schema.String) },
  messages: [PdfExtracted, ToolFailed],
  execute: ({ file, run, previousUrl }) =>
    Effect.promise(() => import("./tool-client")).pipe(
      Effect.flatMap((client) => client.extractPdfFile(file, run, previousUrl)),
    ),
});

export const ReadCertificate = Command.define("ReadCertificate", {
  args: { file: File.File, run: Schema.Int },
  messages: [CertificateRead, ToolFailed],
  execute: ({ file, run }) =>
    Effect.suspend(() => {
      const password = fieldValue("tool-certificate-password");
      return password === ""
        ? Effect.succeed(
            ToolFailed.make({
              tool: "certificate",
              run,
              message: "Digite a senha do certificado.",
            }),
          )
        : Effect.promise(() => import("./tool-client")).pipe(
            Effect.flatMap((client) => client.readCertificateFile(file, password, run)),
          );
    }),
});

export const SignXml = Command.define("SignXml", {
  args: {
    xml: File.File,
    pfx: File.File,
    run: Schema.Int,
    previousUrl: Schema.NullOr(Schema.String),
  },
  messages: [XmlSigned, ToolFailed],
  execute: ({ xml, pfx, run, previousUrl }) =>
    Effect.suspend(() => {
      const password = fieldValue("tool-xml-password");
      const referenceId = fieldValue("tool-xml-reference").trim();
      return password === ""
        ? Effect.succeed(
            ToolFailed.make({ tool: "xml", run, message: "Digite a senha do certificado." }),
          )
        : Effect.promise(() => import("./tool-client")).pipe(
            Effect.flatMap((client) =>
              client.signXmlFile({ xml, pfx, password, referenceId, previousUrl }, run),
            ),
          );
    }),
});

const dropModel = (model: ToolsModel, target: DropTarget) =>
  target === "verify"
    ? model.verifyDrop
    : target === "certificate"
      ? model.certificateDrop
      : target === "xml"
        ? model.xmlDrop
        : target === "xmlPfx"
          ? model.xmlPfxDrop
          : model.pdfcoreDrop;

const withDrop = (model: ToolsModel, target: DropTarget, drop: FileDrop.Model): ToolsModel =>
  target === "verify"
    ? { ...model, verifyDrop: drop }
    : target === "certificate"
      ? { ...model, certificateDrop: drop }
      : target === "xml"
        ? { ...model, xmlDrop: drop }
        : target === "xmlPfx"
          ? { ...model, xmlPfxDrop: drop }
          : { ...model, pdfcoreDrop: drop };

const withProblem = (model: ToolsModel, tool: ToolId, message: string): ToolsModel =>
  tool === "verify"
    ? { ...model, verify: Failed.make({ message }) }
    : tool === "certificate"
      ? { ...model, certificate: Failed.make({ message }) }
      : tool === "xml"
        ? { ...model, xml: Failed.make({ message }) }
        : { ...model, pdfcore: Failed.make({ message }) };

export const toolsUpdate = (
  model: ToolsModel,
  message: Message,
): { model: ToolsModel; commands?: ReadonlyArray<Command.Command<Message>> } =>
  Message.match(message, {
    GotDropMessage: ({ targetId: target, message: dropped }) => {
      const next = FileDrop.update(dropModel(model, target), dropped);
      const commands = Command.mapMessages(next.commands ?? [], (child) =>
        Message.GotDropMessage({ targetId: target, message: child }),
      );
      const base = withDrop(model, target, next.model);
      if (next.outMessage?._tag !== "ReceivedFiles") return { model: base, commands };
      const file = next.outMessage.files[0];
      if (target === "verify") {
        const run = base.run + 1;
        return {
          model: {
            ...base,
            run,
            verifyFile: Option.some(file.name),
            verify: working,
          },
          commands: [...commands, VerifyPdf({ file, run })],
        };
      }
      if (target === "pdfcore") {
        const run = base.run + 1;
        return {
          model: { ...base, run, pdfcoreFile: Option.some(file.name), pdfcore: working },
          commands: [
            ...commands,
            ExtractPdf({
              file,
              run,
              previousUrl: base.pdfcore._tag === "Extracted" ? base.pdfcore.image : null,
            }),
          ],
        };
      }
      if (target === "certificate")
        return {
          model: {
            ...base,
            run: base.run + 1,
            certificateFile: Option.some(file),
            certificate: idle,
          },
          commands,
        };
      return {
        model: {
          ...base,
          run: base.run + 1,
          xml: idle,
          ...(target === "xml" ? { xmlFile: Option.some(file) } : { xmlPfx: Option.some(file) }),
        },
        commands,
      };
    },
    CertificateSubmitted: () => {
      if (model.certificate._tag === "Working") return { model };
      if (Option.isNone(model.certificateFile))
        return { model: withProblem(model, "certificate", "Escolha o arquivo do certificado.") };
      const run = model.run + 1;
      return {
        model: { ...model, run, certificate: working },
        commands: [ReadCertificate({ file: model.certificateFile.value, run })],
      };
    },
    XmlSubmitted: () => {
      if (model.xml._tag === "Working") return { model };
      if (Option.isNone(model.xmlFile))
        return { model: withProblem(model, "xml", "Escolha o arquivo XML.") };
      if (Option.isNone(model.xmlPfx))
        return { model: withProblem(model, "xml", "Escolha o arquivo do certificado A1.") };
      const run = model.run + 1;
      return {
        model: { ...model, run, xml: working },
        commands: [
          SignXml({
            xml: model.xmlFile.value,
            pfx: model.xmlPfx.value,
            run,
            previousUrl: model.xml._tag === "Signed" ? model.xml.url : null,
          }),
        ],
      };
    },
    PdfVerified: ({ run, reports }) => ({
      model: run === model.run ? { ...model, verify: Verified.make({ reports }) } : model,
    }),
    CertificateRead: ({ run, report }) => ({
      model: run === model.run ? { ...model, certificate: Read.make({ report }) } : model,
    }),
    XmlSigned: ({ run, _tag, ...signed }) => ({
      model: run === model.run ? { ...model, xml: Signed.make(signed) } : model,
    }),
    PdfExtracted: ({ run, _tag, ...extracted }) => ({
      model: run === model.run ? { ...model, pdfcore: Extracted.make(extracted) } : model,
    }),
    ToolFailed: ({ run, tool, message: text }) => ({
      model: run === model.run ? withProblem(model, tool, text) : model,
    }),
  });

const formatCpf = (value: string) => value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
const formatCnpj = (value: string) =>
  value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const formatDay = (time: number) => new Date(time).toLocaleDateString("pt-BR");
const formatMoment = (time: number) =>
  new Date(time).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kB`
      : `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const formatMillis = (value: number) =>
  `${value.toLocaleString("pt-BR", { maximumFractionDigits: value < 10 ? 2 : 1 })} ms`;

export const itiValidarUrl = "https://validar.iti.gov.br";

const sampleXml: ReadonlyArray<{ kind: "context" | "ghost"; text: string }> = [
  { kind: "context", text: '<?xml version="1.0" encoding="UTF-8"?>' },
  { kind: "context", text: '<documento Id="doc1">' },
  { kind: "context", text: "  <emitente>Empresa Exemplo Ltda</emitente>" },
  { kind: "context", text: "  <valor>1250.00</valor>" },
  { kind: "ghost", text: "  <ds:Signature>" },
  { kind: "ghost", text: "    <ds:SignedInfo>…</ds:SignedInfo>" },
  { kind: "ghost", text: "    <ds:SignatureValue>…</ds:SignatureValue>" },
  { kind: "ghost", text: "    <ds:KeyInfo>…</ds:KeyInfo>" },
  { kind: "ghost", text: "  </ds:Signature>" },
  { kind: "context", text: "</documento>" },
];

export const toolView = defineView<ToolsModel, Message, { tool: ToolId }>((model, input, h) => {
  const fileDrop = (
    target: DropTarget,
    accept: ReadonlyArray<string>,
    render: (attributes: {
      root: FileDrop.FileDropAttributes["root"];
      field: Html;
      over: boolean;
    }) => Html,
  ) => {
    const state = dropModel(model, target);
    return h.submodel({
      slotId: state.id,
      model: state,
      view: FileDrop.view,
      viewInputs: {
        accept,
        toView: ({ root, input: fileInput }) =>
          render({
            root,
            field: h.input([...fileInput, ...sx(h, signing.fileInput)]),
            over: state.isDragOver,
          }),
      },
      toParentMessage: (message) => Message.GotDropMessage({ targetId: target, message }),
    });
  };
  const rowDrop = (config: {
    target: DropTarget;
    label: string;
    hint: string;
    accept: ReadonlyArray<string>;
    glyph: IconName;
    filled: boolean;
  }) =>
    fileDrop(config.target, config.accept, ({ root, field, over }) =>
      h.label(
        [
          ...root,
          ...sx(h, signing.drop, config.filled && tools.dropFilled, over && signing.dropOver),
        ],
        [
          h.span([...sx(h, signing.dropGlyph)], [icon(h, config.glyph)]),
          h.span(
            [...sx(h, signing.dropText)],
            [
              h.strong([...sx(h, signing.dropTitle)], [config.label]),
              h.span([...sx(h, signing.dropHint)], [config.hint]),
            ],
          ),
          h.span([...sx(h, signing.dropAction)], [config.filled ? "Trocar" : "Escolher"]),
          field,
        ],
      ),
    );
  const privacy = (text: string) => h.p([...sx(h, tools.privacy)], [icon(h, "lock"), text]);
  const problem = (text: string) =>
    h.p(
      [...sx(h, tools.problem), h.Role("alert"), h.Attribute("data-tool-problem", "")],
      [h.span([...sx(h, tools.problemIcon)], [icon(h, "warn")]), text],
    );
  const drawnCheck = h.svg(
    [h.ViewBox("0 0 24 24"), h.AriaHidden(true), ...sx(h, tools.check)],
    [h.path([h.D("M5 12l5 5 9-10"), ...sx(h, tools.draw)])],
  );
  const pairs = (rows: ReadonlyArray<readonly [string, string | null, boolean?]>, dark = false) =>
    rows.flatMap(([term, value, mono]) =>
      value === null || value === ""
        ? []
        : [
            h.keyed("dt")(`${term}-term`, [...sx(h, dark ? tools.versoTerm : tools.term)], [term]),
            h.keyed("dd")(
              `${term}-value`,
              [...sx(h, tools.value, dark && tools.valueDark, mono === true && tools.mono)],
              [value],
            ),
          ],
    );
  const password = (id: string) =>
    h.div(
      [...sx(h, signing.group)],
      [
        h.span([...sx(h, signing.groupGlyph)], [icon(h, "lock")]),
        Input.view(
          {
            id,
            name: "password",
            type: "password",
            toView: (attributes) =>
              h.input([
                ...attributes.input,
                h.Class(className(signing.groupInput)),
                h.AriaLabel("Senha do certificado"),
                h.Attribute("placeholder", "Senha do certificado"),
                h.Attribute("autocomplete", "off"),
              ]),
          },
          h,
        ),
      ],
    );
  const submit = (label: string, busyLabel: string, busy: boolean, glyph: IconName) =>
    Button.view(
      {
        type: "submit",
        isDisabled: busy,
        toView: (attributes) =>
          h.button(
            [...attributes.button, ...sx(h, shell.primary, tools.submit)],
            [icon(h, glyph), busy ? busyLabel : label],
          ),
      },
      h,
    );
  const root = (children: ReadonlyArray<Html>, ...styles: Parameters<typeof sx>[1][]) =>
    h.section(
      [
        ...sx(h, "ph-no-capture", ...styles),
        h.Attribute("data-analytics-sensitive", "true"),
        h.Attribute("data-tool", input.tool),
      ],
      children,
    );

  if (input.tool === "verify") {
    const state = model.verify;
    const fileName = Option.getOrElse(model.verifyFile, () => "");
    const reports = state._tag === "Verified" ? state.reports : [];
    const sound = reports.filter((report) => report.intact && report.coverage).length;
    return root(
      [
        h.div(
          [...sx(h, tools.sheetBand)],
          [
            h.h2([...sx(h, tools.sheetTitle)], ["Laudo de verificação"]),
            h.p(
              [...sx(h, tools.sheetMeta)],
              [icon(h, "lock"), "Lido no seu navegador. Nada é enviado."],
            ),
          ],
        ),
        h.div(
          [...sx(h, tools.sheetBody)],
          [
            h.div(
              [...sx(h, tools.column)],
              [
                h.p([...sx(h, tools.label)], ["Documento"]),
                fileDrop("verify", ["application/pdf", ".pdf"], ({ root: zone, field, over }) =>
                  h.label(
                    [
                      ...zone,
                      ...sx(
                        h,
                        tools.paper,
                        fileName !== "" && tools.paperFilled,
                        over && tools.paperOver,
                      ),
                    ],
                    [
                      h.span([...sx(h, tools.paperGlyph)], [icon(h, "file")]),
                      h.strong(
                        [...sx(h, tools.paperName)],
                        [fileName === "" ? "Solte o PDF assinado aqui" : fileName],
                      ),
                      h.span(
                        [...sx(h, tools.paperHint)],
                        [
                          state._tag === "Working"
                            ? "Verificando as assinaturas…"
                            : state._tag === "Verified"
                              ? `${plural(reports.length, "assinatura", "assinaturas")}, ${sound === reports.length ? (sound === 1 ? "íntegra" : "todas íntegras") : `${reports.length - sound} com problema`}. Clique para trocar o arquivo.`
                              : fileName === ""
                                ? "ou clique para escolher um arquivo .pdf"
                                : "Clique para trocar o arquivo.",
                        ],
                      ),
                      field,
                    ],
                  ),
                ),
              ],
            ),
            h.div(
              [...sx(h, tools.column), h.Role("status"), h.AriaLive("polite")],
              [
                h.p([...sx(h, tools.label)], ["Assinaturas"]),
                state._tag === "Failed"
                  ? h.keyed("div")("failed", [], [problem(state.message)])
                  : state._tag === "Verified"
                    ? h.keyed("ol")(
                        `trail-${model.run}`,
                        [...sx(h, tools.trail), h.Attribute("data-stagger", "")],
                        reports.map((report, index) => {
                          const ok = report.intact && report.coverage;
                          return h.keyed("li")(
                            String(report.index),
                            [
                              ...sx(h, tools.trailItem),
                              h.Attribute("data-signature-intact", String(ok)),
                            ],
                            [
                              h.span(
                                [...sx(h, tools.seal, !ok && tools.sealWarn)],
                                [ok ? drawnCheck : icon(h, "warn")],
                              ),
                              ...(index < reports.length - 1
                                ? [h.span([...sx(h, tools.trailLine), h.AriaHidden(true)])]
                                : []),
                              h.div(
                                [...sx(h, tools.trailBody)],
                                [
                                  h.div(
                                    [...sx(h, tools.trailHead)],
                                    [
                                      h.p(
                                        [...sx(h, tools.name)],
                                        [report.signer ?? `Assinatura ${report.index + 1}`],
                                      ),
                                      h.span(
                                        [...sx(h, tools.badge, !ok && tools.badgeWarn)],
                                        [
                                          !report.intact
                                            ? "Inválida"
                                            : !report.coverage
                                              ? "Cobertura parcial"
                                              : "Íntegra",
                                        ],
                                      ),
                                    ],
                                  ),
                                  h.p(
                                    [...sx(h, tools.verdict)],
                                    [
                                      !report.intact
                                        ? "O conteúdo assinado foi alterado ou a assinatura não confere."
                                        : !report.coverage
                                          ? "A assinatura confere, mas não cobre o arquivo inteiro. Pode haver conteúdo incluído depois dela."
                                          : report.coversFileEnd
                                            ? "O conteúdo não foi alterado depois desta assinatura."
                                            : "O conteúdo coberto por esta assinatura não foi alterado. Há assinaturas ou revisões posteriores.",
                                    ],
                                  ),
                                  h.dl(
                                    [...sx(h, tools.trailFacts)],
                                    pairs([
                                      ["CPF", report.cpf === null ? null : formatCpf(report.cpf)],
                                      [
                                        "CNPJ",
                                        report.cnpj === null ? null : formatCnpj(report.cnpj),
                                      ],
                                      ["Emissor", report.issuer],
                                      [
                                        "Certificado",
                                        report.validFrom === null || report.validTo === null
                                          ? null
                                          : `${formatDay(report.validFrom)} a ${formatDay(report.validTo)}`,
                                      ],
                                      [
                                        "Data informada",
                                        report.declaredAt === null
                                          ? null
                                          : formatMoment(report.declaredAt),
                                      ],
                                      ["Formato", report.format],
                                    ]),
                                  ),
                                ],
                              ),
                            ],
                          );
                        }),
                      )
                    : h.keyed("ul")(
                        "ghost",
                        [...sx(h, tools.ghost), h.AriaHidden(true)],
                        ["a", "b", "c"].map((key) =>
                          h.keyed("li")(
                            key,
                            [...sx(h, tools.ghostRow)],
                            [
                              h.span([...sx(h, tools.ghostSeal)]),
                              h.span(
                                [...sx(h, tools.ghostBars)],
                                [
                                  h.span([...sx(h, tools.ghostBar, tools.ghostBarShort)]),
                                  h.span([...sx(h, tools.ghostBar)]),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                ...(state._tag === "Idle" || state._tag === "Working"
                  ? [
                      h.p(
                        [...sx(h, tools.verdict)],
                        [
                          state._tag === "Working"
                            ? "Lendo o arquivo e conferindo cada assinatura…"
                            : "As assinaturas aparecem aqui, na ordem em que foram aplicadas.",
                        ],
                      ),
                    ]
                  : []),
              ],
            ),
          ],
        ),
        h.div(
          [...sx(h, tools.sheetFoot)],
          [
            h.p(
              [...sx(h, tools.footText)],
              [
                "Este laudo confere a integridade de cada assinatura e lê o certificado do signatário. Ele não valida a cadeia da ICP-Brasil nem a revogação do certificado. A data informada vem do relógio de quem assinou.",
              ],
            ),
            h.a(
              [
                ...sx(h, tools.noteLink),
                h.Href(itiValidarUrl),
                h.Target("_blank"),
                h.Rel("noopener"),
              ],
              ["Validar no ITI ↗"],
            ),
          ],
        ),
      ],
      tools.sheet,
    );
  }

  if (input.tool === "certificate") {
    const state = model.certificate;
    const fileName = Option.match(model.certificateFile, {
      onNone: () => "",
      onSome: (file) => file.name,
    });
    const report = state._tag === "Read" ? state.report : undefined;
    const valid = report?.status === "valid";
    const elapsed = report?.elapsed ?? 0;
    return root(
      [
        h.div(
          [...sx(h, tools.panel)],
          [
            h.h2([...sx(h, tools.heading)], ["Ler um certificado A1"]),
            privacy("O certificado e a senha ficam no seu navegador."),
            h.form(
              [...sx(h, tools.root), h.OnSubmit(Message.CertificateSubmitted())],
              [
                rowDrop({
                  target: "certificate",
                  label: fileName === "" ? "Certificado A1" : fileName,
                  hint:
                    fileName === ""
                      ? "Arraste ou escolha um arquivo .pfx ou .p12"
                      : "Certificado A1",
                  accept: [".pfx", ".p12", "application/x-pkcs12"],
                  glyph: "key",
                  filled: fileName !== "",
                }),
                password("tool-certificate-password"),
                submit("Ler certificado", "Lendo…", state._tag === "Working", "search"),
              ],
            ),
            h.div(
              [h.Role("status"), h.AriaLive("polite")],
              state._tag === "Failed"
                ? [h.keyed("div")("failed", [], [problem(state.message)])]
                : [],
            ),
          ],
        ),
        h.div(
          [...sx(h, tools.cardStage)],
          [
            h.div(
              [
                ...sx(h, tools.card, report !== undefined && tools.cardFlipped),
                h.Attribute("data-certificate-card", report === undefined ? "front" : "back"),
              ],
              [
                h.div(
                  [...sx(h, tools.face, tools.front), h.AriaHidden(report !== undefined)],
                  [
                    h.div(
                      [...sx(h, tools.cardRow)],
                      [
                        h.p([...sx(h, tools.cardKind)], ["Certificado A1"]),
                        h.span([...sx(h, tools.chip)], [icon(h, "key")]),
                      ],
                    ),
                    h.div(
                      [...sx(h, tools.masked)],
                      [
                        h.span([...sx(h, tools.maskedBar), h.Style({ width: "62%" })]),
                        h.span([...sx(h, tools.maskedBar), h.Style({ width: "38%" })]),
                      ],
                    ),
                    h.p(
                      [...sx(h, tools.cardHint)],
                      [
                        state._tag === "Working"
                          ? "Abrindo o arquivo…"
                          : "Titular, CPF ou CNPJ, emissor e validade aparecem aqui.",
                      ],
                    ),
                  ],
                ),
                h.div(
                  [...sx(h, tools.face, tools.back), h.AriaHidden(report === undefined)],
                  report === undefined
                    ? []
                    : [
                        h.keyed("div")(
                          `head-${model.run}`,
                          [...sx(h, tools.cardRow)],
                          [
                            h.p([...sx(h, tools.cardKind)], ["Certificado A1"]),
                            h.span(
                              [...sx(h, tools.badge, !valid && tools.badgeWarn)],
                              [
                                report.status === "expired"
                                  ? "Expirado"
                                  : report.status === "notYetValid"
                                    ? "Ainda não vigente"
                                    : "Vigente",
                              ],
                            ),
                          ],
                        ),
                        h.keyed("div")(
                          `holder-${model.run}`,
                          [],
                          [
                            h.p([...sx(h, tools.holder)], [report.holder]),
                            h.p(
                              [...sx(h, tools.holderDoc)],
                              [
                                report.cnpj !== null
                                  ? `CNPJ ${formatCnpj(report.cnpj)}`
                                  : report.cpf !== null
                                    ? `CPF ${formatCpf(report.cpf)}`
                                    : "Sem CPF ou CNPJ no certificado",
                              ],
                            ),
                          ],
                        ),
                        h.keyed("div")(
                          `validity-${model.run}`,
                          [...sx(h, tools.validity)],
                          [
                            h.p(
                              [...sx(h, tools.verdict)],
                              [
                                report.status === "expired"
                                  ? "Expirou e não serve mais para assinar."
                                  : report.status === "notYetValid"
                                    ? "Ainda não começou a valer."
                                    : report.daysUntilExpiry === 0
                                      ? "Expira hoje."
                                      : `Expira em ${plural(report.daysUntilExpiry, "dia", "dias")}.`,
                              ],
                            ),
                            h.div(
                              [...sx(h, tools.track), h.AriaHidden(true)],
                              [
                                h.span(
                                  [
                                    ...sx(h, tools.fillSize),
                                    h.Style({ width: `${(elapsed * 100).toFixed(2)}%` }),
                                    h.Attribute("data-validity-fill", elapsed.toFixed(4)),
                                  ],
                                  [h.span([...sx(h, tools.fill, !valid && tools.fillWarn)])],
                                ),
                              ],
                            ),
                            h.p(
                              [...sx(h, tools.validityDates)],
                              [
                                h.span([], [formatDay(report.validFrom)]),
                                h.span([], [formatDay(report.validTo)]),
                              ],
                            ),
                          ],
                        ),
                      ],
                ),
              ],
            ),
            ...(report === undefined
              ? []
              : [
                  h.keyed("dl")(
                    `verso-${model.run}`,
                    [...sx(h, tools.verso), h.Attribute("data-stagger", "")],
                    pairs(
                      [
                        ["Organização", report.organization],
                        ["Emissor", report.issuer],
                        ["Tipo", "A1, em arquivo PKCS#12 (.pfx ou .p12)"],
                        [
                          "Cadeia no arquivo",
                          report.chainLength === 0
                            ? "Nenhum certificado intermediário"
                            : plural(
                                report.chainLength,
                                "certificado intermediário",
                                "certificados intermediários",
                              ),
                        ],
                        ["Número de série", report.serialNumber, true],
                        ["SHA-256", report.fingerprint, true],
                      ],
                      true,
                    ),
                  ),
                ]),
          ],
        ),
      ],
      tools.stage,
    );
  }

  if (input.tool === "pdfcore") {
    const state = model.pdfcore;
    const fileName = Option.getOrElse(model.pdfcoreFile, () => "");
    const stat = (term: string, value: string) =>
      h.keyed("div")(
        term,
        [...sx(h, tools.benchStat)],
        [h.dt([...sx(h, tools.benchTerm)], [term]), h.dd([...sx(h, tools.benchValue)], [value])],
      );
    return root(
      [
        fileDrop("pdfcore", ["application/pdf", ".pdf"], ({ root: zone, field, over }) =>
          h.label(
            [...zone, ...sx(h, tools.benchDrop, over && tools.benchDropOver)],
            [
              h.span([...sx(h, tools.benchGlyph)], [icon(h, "file")]),
              h.span(
                [...sx(h, signing.dropText)],
                [
                  h.strong(
                    [...sx(h, tools.benchTitle)],
                    [fileName === "" ? "Solte um PDF para extrair o texto" : fileName],
                  ),
                  h.span(
                    [...sx(h, tools.benchHint)],
                    [
                      state._tag === "Working"
                        ? "Carregando o WebAssembly e extraindo…"
                        : "O arquivo é processado no seu navegador, em um Web Worker.",
                    ],
                  ),
                ],
              ),
              h.span([...sx(h, tools.benchAction)], [fileName === "" ? "Escolher" : "Trocar"]),
              field,
            ],
          ),
        ),
        h.dl(
          [...sx(h, tools.benchStats), h.Role("status"), h.AriaLive("polite")],
          state._tag === "Extracted"
            ? [
                stat("Páginas", state.pageCount.toLocaleString("pt-BR")),
                stat("Extração", formatMillis(state.extractMillis)),
                stat(
                  "Por página",
                  state.pageCount === 0 ? "—" : formatMillis(state.extractMillis / state.pageCount),
                ),
                stat(
                  "Página 1 em imagem",
                  state.renderMillis === null ? "—" : formatMillis(state.renderMillis),
                ),
              ]
            : [
                stat("Páginas", "—"),
                stat("Extração", "—"),
                stat("Por página", "—"),
                stat("Página 1 em imagem", "—"),
              ],
        ),
        ...(state._tag === "Failed"
          ? [
              h.keyed("p")(
                "failed",
                [
                  ...sx(h, tools.benchProblem),
                  h.Role("alert"),
                  h.Attribute("data-tool-problem", ""),
                ],
                [state.message],
              ),
            ]
          : []),
        h.div(
          [...sx(h, tools.benchBody)],
          state._tag === "Extracted"
            ? [
                state.image === null
                  ? h.keyed("div")("thumb-ghost", [...sx(h, tools.benchThumbGhost)])
                  : h.keyed("img")(`thumb-${model.run}`, [
                      h.Src(state.image),
                      h.Alt(`Página 1 de ${fileName}`),
                      ...sx(h, tools.benchThumb, tools.line),
                    ]),
                h.keyed("ol")(
                  `text-${model.run}`,
                  [...sx(h, tools.benchText), h.Attribute("data-extracted-text", "")],
                  state.lines.length === 0
                    ? [
                        h.keyed("li")(
                          "empty",
                          [...sx(h, tools.codeGhost)],
                          ["A página 1 não tem camada de texto. Pode ser um PDF digitalizado."],
                        ),
                      ]
                    : state.lines.map((line, index) =>
                        h.keyed("li")(
                          line.id,
                          [
                            ...sx(h, tools.line),
                            h.Style({ transitionDelay: `${Math.min(index, 40) * 18}ms` }),
                          ],
                          [line.text],
                        ),
                      ),
                ),
              ]
            : [
                h.keyed("div")("thumb-ghost", [
                  ...sx(h, tools.benchThumbGhost),
                  h.AriaHidden(true),
                ]),
                h.keyed("ol")(
                  "text-ghost",
                  [...sx(h, tools.benchText)],
                  [
                    h.keyed("li")(
                      "ghost",
                      [...sx(h, tools.codeGhost)],
                      [
                        "O texto da página 1 aparece aqui em ordem de leitura, com o tempo medido no seu dispositivo.",
                      ],
                    ),
                  ],
                ),
              ],
        ),
      ],
      tools.bench,
    );
  }

  const state = model.xml;
  const xmlName = Option.match(model.xmlFile, { onNone: () => "", onSome: (file) => file.name });
  const pfxName = Option.match(model.xmlPfx, { onNone: () => "", onSome: (file) => file.name });
  const added = state._tag === "Signed" ? state.preview.filter((line) => line.added).length : 0;
  return root(
    [
      h.div(
        [...sx(h, tools.editorForm)],
        [
          h.h2([...sx(h, tools.heading)], ["Assinar um XML"]),
          privacy("O XML, o certificado e a senha ficam no seu navegador."),
          h.form(
            [...sx(h, tools.root), h.OnSubmit(Message.XmlSubmitted())],
            [
              rowDrop({
                target: "xml",
                label: xmlName === "" ? "Arquivo XML" : xmlName,
                hint: xmlName === "" ? "Arraste ou escolha um .xml em UTF-8" : "XML para assinar",
                accept: [".xml", "application/xml", "text/xml"],
                glyph: "file",
                filled: xmlName !== "",
              }),
              rowDrop({
                target: "xmlPfx",
                label: pfxName === "" ? "Certificado A1" : pfxName,
                hint: pfxName === "" ? ".pfx ou .p12" : "Certificado A1",
                accept: [".pfx", ".p12", "application/x-pkcs12"],
                glyph: "key",
                filled: pfxName !== "",
              }),
              password("tool-xml-password"),
              Input.view(
                {
                  id: "tool-xml-reference",
                  name: "referenceId",
                  type: "text",
                  toView: (attributes) =>
                    h.label(
                      [...attributes.label, ...sx(h, tools.field)],
                      [
                        h.span(
                          [],
                          [
                            "Id do elemento a assinar ",
                            h.span([...sx(h, tools.optional)], ["(opcional)"]),
                          ],
                        ),
                        h.input([
                          ...attributes.input,
                          h.Class(className(tools.input)),
                          h.Attribute("placeholder", "Em branco, assina o documento inteiro"),
                          h.Attribute("autocomplete", "off"),
                          h.Attribute("spellcheck", "false"),
                        ]),
                      ],
                    ),
                },
                h,
              ),
              submit("Assinar XML", "Assinando…", state._tag === "Working", "pen"),
            ],
          ),
          h.div(
            [h.Role("status"), h.AriaLive("polite"), ...sx(h, tools.root)],
            state._tag === "Failed"
              ? [h.keyed("div")("failed", [], [problem(state.message)])]
              : state._tag === "Signed"
                ? [
                    h.keyed("div")(
                      `signed-${model.run}`,
                      [...sx(h, tools.root), h.Attribute("data-stagger", "")],
                      [
                        h.dl(
                          [...sx(h, tools.facts)],
                          pairs([
                            ["Signatário", state.signer],
                            [
                              "Referência",
                              state.referenceUris.every((uri) => uri === "")
                                ? "Documento inteiro"
                                : state.referenceUris.join(", "),
                            ],
                            [
                              "Conferência",
                              state.verified
                                ? "Assinatura conferida depois de gerada"
                                : "A conferência automática falhou. Valide antes de usar.",
                            ],
                          ]),
                        ),
                        h.a(
                          [
                            ...sx(h, shell.primary, tools.download),
                            h.Href(state.url),
                            h.Download(state.fileName),
                          ],
                          [`Baixar XML assinado (${formatBytes(state.bytes)})`],
                        ),
                      ],
                    ),
                  ]
                : [],
          ),
        ],
      ),
      h.div(
        [...sx(h, tools.editorCode)],
        [
          h.div(
            [...sx(h, tools.editorBar)],
            [
              h.span(
                [...sx(h, tools.editorFile)],
                [
                  state._tag === "Signed"
                    ? state.fileName
                    : xmlName === ""
                      ? "exemplo.xml"
                      : xmlName,
                ],
              ),
              h.span(
                [...sx(h, tools.editorState, state._tag === "Signed" && tools.editorStateOn)],
                [
                  state._tag === "Signed"
                    ? `+${added} linhas de assinatura`
                    : state._tag === "Working"
                      ? "assinando…"
                      : "sem assinatura",
                ],
              ),
            ],
          ),
          state._tag === "Signed"
            ? h.keyed("ol")(
                `code-${model.run}`,
                [...sx(h, tools.code), h.Attribute("data-xml-preview", "signed")],
                state.preview.map((line, index) =>
                  h.keyed("li")(
                    line.id,
                    [
                      ...sx(h, tools.codeLine, line.added && tools.codeAdded, tools.line),
                      h.Style({ transitionDelay: `${Math.min(index, 30) * 28}ms` }),
                    ],
                    [
                      h.span(
                        [
                          ...sx(h, tools.gutter, line.added && tools.gutterAdded),
                          h.AriaHidden(true),
                        ],
                        [line.added ? "+" : String(index + 1)],
                      ),
                      h.span([], [line.text]),
                    ],
                  ),
                ),
              )
            : h.keyed("ol")(
                "code-sample",
                [...sx(h, tools.code), h.Attribute("data-xml-preview", "sample")],
                sampleXml.map((line, index) =>
                  h.keyed("li")(
                    line.text,
                    [...sx(h, tools.codeLine, line.kind === "ghost" && tools.codeGhost)],
                    [
                      h.span(
                        [...sx(h, tools.gutter), h.AriaHidden(true)],
                        [line.kind === "ghost" ? "+" : String(index + 1)],
                      ),
                      h.span([], [line.text]),
                    ],
                  ),
                ),
              ),
        ],
      ),
    ],
    tools.editor,
  );
});
