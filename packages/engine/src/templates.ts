import { Schema } from "effect";
import {
  Badge,
  Box,
  Document,
  Heading,
  KeepTogether,
  Link,
  Page,
  PageBreak,
  PageNumber,
  Paragraph,
  Path,
  Row,
  Rule,
  SignatureField,
  Span,
  Stack,
  Table,
  Text,
  TotalPages,
} from "./compose.js";
import type { ComposeNode, PathCommand, Style } from "./compose.js";

const LabelStyle = {
  color: "accent",
  fontSize: "caption",
  fontWeight: 700,
  letterSpacing: 1.1,
} satisfies Style;
const labels = (text: string) => Text(text, LabelStyle);
const small = (text: string, style: Style = {}) =>
  Text(text, { fontSize: "small", color: "muted", ...style });

const footer = (identity: string) =>
  Stack(
    [
      Rule(),
      Row([
        small(identity),
        Text([PageNumber(), "  /  ", TotalPages()], {
          color: "muted",
          fontSize: "caption",
          textAlign: "right",
        }),
      ]),
    ],
    { gap: "sm", margin: [18, 0, 0, 0] },
  );

const heading = (index: string, title: string, summary: string): ComposeNode =>
  Stack(
    [
      Rule({ height: 3, width: 29, background: "accent" }),
      labels(index),
      Heading(title, { fontSize: "display", lineHeight: 1.04 }),
      Paragraph(summary, { color: "muted", fontStyle: "italic" }),
    ],
    { gap: "sm" },
  );

const card = (nodes: readonly ComposeNode[], style: Style = {}): ComposeNode =>
  Stack(nodes, { padding: "lg", background: "paper", borderRadius: 5, gap: "sm", ...style });

const clause = (number: string, title: string, body: string): ComposeNode =>
  KeepTogether(
    [
      Row(
        [labels(number), Heading(title, { fontSize: "subtitle" })].map((node, index) =>
          Box([node], index === 0 ? { width: 36, shrink: 0 } : { grow: 1 }),
        ),
        {
          align: "center",
        },
      ),
      Paragraph(body, { textAlign: "justify" }),
    ],
    { gap: "xs" },
  );

const signatureArea = (field: string, label: string, name: string) =>
  Stack(
    [
      SignatureField(field, { height: 52, background: "paper", borderRadius: 4 }),
      Rule({ background: "accent" }),
      labels(label),
      small(name),
    ],
    { gap: 5 },
  );

export const contractTemplate = (pageCount = 2) => {
  const first = [
    heading(
      "ACORDO  •  CTS–2026–014",
      "Contrato de\nprestação de serviços",
      "Desenvolvimento e entrega de um portal de atendimento para a Aurora Editorial.",
    ),
    card([
      Row(
        [
          Stack(
            [
              labels("CONTRATANTE"),
              Text("Aurora Editorial Ltda.", { fontWeight: 700 }),
              small("CNPJ 00.000.000/0001-00"),
            ],
            { gap: 5 },
          ),
          Stack(
            [
              labels("CONTRATADA"),
              Text("Estúdio Campo Digital Ltda.", { fontWeight: 700 }),
              small("CNPJ 00.000.000/0002-00"),
            ],
            { gap: 5 },
          ),
        ],
        { gap: "lg" },
      ),
    ]),
    clause(
      "01",
      "Objeto",
      "A contratada desenvolverá um portal responsivo de atendimento, incluindo pesquisa, prototipação, implementação e documentação para a equipe da contratante.",
    ),
    clause(
      "02",
      "Prazo e entregas",
      "O trabalho será concluído em 60 dias corridos, contados da reunião inicial. As entregas serão apresentadas em três etapas: projeto visual, versão de homologação e publicação.",
    ),
    clause(
      "03",
      "Preço e pagamento",
      "O valor total é de R$ 24.800,00. Serão pagos 40% na assinatura, 30% na homologação e 30% após a entrega final, mediante emissão de nota fiscal.",
    ),
  ];
  const continuation = [
    clause(
      "04",
      "Aceite e revisões",
      "A contratante terá cinco dias úteis para avaliar cada entrega. Correções relacionadas ao escopo serão registradas por escrito e concluídas no ciclo seguinte.",
    ),
    clause(
      "05",
      "Confidencialidade",
      "As partes manterão em sigilo os materiais e dados aos quais tiverem acesso para executar este contrato. O dever de confidencialidade continua após o encerramento.",
    ),
    clause(
      "06",
      "Direitos sobre as entregas",
      "Após a quitação integral, a contratante poderá utilizar e adaptar as entregas. Ferramentas e bibliotecas preexistentes continuam regidas por suas respectivas licenças.",
    ),
  ];
  const sign = KeepTogether(
    [
      Rule(),
      Heading("Assinaturas", { fontSize: "subtitle" }),
      small("São Paulo, 25 de novembro de 2026"),
      Row(
        [
          signatureArea("assinatura-contratante", "CONTRATANTE", "Aurora Editorial Ltda."),
          signatureArea("assinatura-contratada", "CONTRATADA", "Estúdio Campo Digital Ltda."),
        ],
        { gap: "lg" },
      ),
    ],
    { gap: "sm" },
  );
  const body =
    pageCount === 1
      ? [Stack([...first, sign], { gap: "md" })]
      : [
          Stack(first, { gap: "xl" }),
          ...Array.from({ length: pageCount - 1 }, (_, index) => [
            PageBreak(),
            Stack(
              [
                ...(index === 0
                  ? [
                      heading(
                        "CONDIÇÕES GERAIS",
                        "Execução e aceite",
                        "Condições de trabalho, responsabilidades e assinatura das partes.",
                      ),
                      ...continuation,
                    ]
                  : [
                      heading(
                        "ANEXO CONTRATUAL",
                        `Registro de execução ${index}`,
                        "Acompanhamento das etapas acordadas entre as partes.",
                      ),
                      ...continuation,
                    ]),
                ...(index === pageCount - 2 ? [sign] : []),
              ],
              { gap: "lg" },
            ),
          ]).flat(),
        ];
  return Document(
    Page(body, {
      header: Stack([small("AURORA EDITORIAL     /     INSTRUMENTO PARTICULAR"), Rule()], {
        gap: "sm",
        margin: [0, 0, 24, 0],
      }),
      footer: footer("CTS–2026–014   /   PRESTAÇÃO DE SERVIÇOS"),
    }),
  );
};

const Evidence = Schema.Literals(["confirmado", "parcial", "pendente", "divergente"]);
const Signer = Schema.Struct({
  name: Schema.String,
  certificate: Schema.Literals(["e-CPF", "e-CNPJ"]),
  signedAt: Schema.String,
  field: Schema.String,
  coverage: Evidence,
  integrity: Evidence,
  trust: Evidence,
  revocation: Evidence,
});
const TimelineEntry = Schema.Struct({ time: Schema.String, detail: Schema.String });
export const EvidenceReport = Schema.Struct({
  document: Schema.String,
  digest: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/i)),
  signers: Schema.Array(Signer),
  timeline: Schema.Array(TimelineEntry),
});
export type EvidenceReport = typeof EvidenceReport.Type;

const evidenceStyles = {
  confirmado: { color: "accent", background: "tint" },
  parcial: { color: "ink", background: "#d5e6de" },
  pendente: { color: "muted", background: "#ebeef0" },
  divergente: { color: "white", background: "ink" },
} satisfies Record<typeof Evidence.Type, Style>;
const status = (name: string, value: typeof Evidence.Type) =>
  Stack([small(name), Badge(value, { ...evidenceStyles[value], textAlign: "center" })], {
    gap: "xs",
  });

export const evidenceReportTemplate = (data: EvidenceReport) =>
  Document(
    Page(
      [
        Stack(
          [
            heading(
              "CADERNO DE EVIDÊNCIAS  •  R01",
              "Relatório de assinaturas",
              "Identidade do documento, validação por signatário e histórico de revisões.",
            ),
            card(
              [
                labels("DOCUMENTO ANALISADO"),
                Text(data.document, { fontWeight: 700, fontSize: "subtitle" }),
                small("SHA-256"),
                Text(data.digest, { fontSize: "caption", letterSpacing: 0.32 }),
              ],
              { background: "tint" },
            ),
            Heading("Signatários", { fontSize: "subtitle" }),
            ...data.signers.map((signer, index) =>
              card([
                Row([
                  Stack(
                    [
                      labels(`SIGNATÁRIO 0${index + 1}`),
                      Text(signer.name, { fontWeight: 700 }),
                      small(`Campo: ${signer.field}`),
                    ],
                    { gap: "xs" },
                  ),
                  Stack(
                    [
                      Text(signer.certificate, {
                        color: "accent",
                        fontWeight: 700,
                        textAlign: "right",
                      }),
                      small(signer.signedAt, { textAlign: "right" }),
                    ],
                    { gap: "xs" },
                  ),
                ]),
                Rule(),
                Row(
                  [
                    status("Cobertura", signer.coverage),
                    status("Integridade", signer.integrity),
                    status("Confiança", signer.trust),
                    status("Revogação", signer.revocation),
                  ],
                  { gap: "sm" },
                ),
              ]),
            ),
            Heading("Linha do tempo", { fontSize: "subtitle" }),
            Table(
              [],
              data.timeline.map(({ time, detail }) =>
                Stack(
                  [
                    Rule(),
                    Row(
                      [
                        small(time, { width: 117, shrink: 0 }),
                        Text(detail, { grow: 1, fontSize: "small" }),
                      ],
                      { gap: "sm" },
                    ),
                  ],
                  { gap: 6 },
                ),
              ),
              { gap: 6 },
            ),
          ],
          { gap: "md" },
        ),
      ],
      { footer: footer("RELATÓRIO DE ASSINATURAS  /  R01") },
    ),
  );

export const sampleEvidence: EvidenceReport = {
  document: "Contrato de prestação de serviços.pdf",
  digest: "1f6a9db5c7e2f498e7402418477cbda43f1cd6ae05dd7c0f495b8c8264917216e2",
  signers: [
    {
      name: "Marina Ferreira",
      certificate: "e-CPF",
      signedAt: "25 nov. 2026, 10:42 BRT",
      field: "assinatura-contratante",
      coverage: "confirmado",
      integrity: "confirmado",
      trust: "confirmado",
      revocation: "pendente",
    },
    {
      name: "Estúdio Campo Digital Ltda.",
      certificate: "e-CNPJ",
      signedAt: "25 nov. 2026, 11:08 BRT",
      field: "assinatura-contratada",
      coverage: "parcial",
      integrity: "confirmado",
      trust: "pendente",
      revocation: "pendente",
    },
  ],
  timeline: [
    { time: "25 nov. · 10:30", detail: "Revisão 0  ·  documento original criado" },
    { time: "25 nov. · 10:42", detail: "Revisão 1  ·  assinatura da contratante adicionada" },
    { time: "25 nov. · 11:08", detail: "Revisão 2  ·  assinatura da contratada adicionada" },
  ],
};

const square = (x: number, y: number, n: number): readonly PathCommand[] => [
  { kind: "move", point: [x, y] },
  { kind: "line", point: [x + n, y] },
  { kind: "line", point: [x + n, y + n] },
  { kind: "line", point: [x, y + n] },
  { kind: "close" },
];
const mark = Path(
  [
    ...square(0, 0, 18),
    ...square(24, 0, 18),
    ...square(0, 24, 18),
    ...square(24, 24, 6),
    ...square(36, 36, 6),
    ...square(24, 36, 6),
    ...square(36, 24, 6),
  ],
  { background: "accent", height: 42, width: 42, shrink: 0 },
);

const invoiceLine = (description: string, quantity: string, amount: string, header = false) => {
  const cellStyle = {
    fontSize: header ? "caption" : "body",
    fontWeight: header ? 700 : 400,
  } satisfies Style;
  return Stack(
    [
      Row(
        [
          Text(description, { ...cellStyle, grow: 1 }),
          Text(quantity, { ...cellStyle, textAlign: "right", width: 55 }),
          Text(amount, { ...cellStyle, textAlign: "right", width: 95 }),
        ],
        { gap: "md" },
      ),
      ...(!header ? [Rule()] : []),
    ],
    {
      background: header ? "tint" : "white",
      padding: [8, 12, 8, 12],
      gap: 8,
      borderRadius: header ? 4 : 0,
    },
  );
};

export const receiptTemplate = () =>
  Document(
    Page(
      [
        Stack(
          [
            heading(
              "ESTÚDIO CAMPO  •  FINANCEIRO",
              "Recibo de serviços",
              "Referência  2026–014  /  Primeira parcela do projeto Aurora",
            ),
            Row(
              [
                card([
                  labels("RECEBEMOS DE"),
                  Text("Aurora Editorial Ltda.", { fontWeight: 700 }),
                  small("CNPJ 00.000.000/0001-00"),
                ]),
                card([
                  labels("EMISSÃO"),
                  Text("25 de novembro de 2026", { fontWeight: 700 }),
                  small("São Paulo, SP"),
                ]),
              ],
              { gap: "md" },
            ),
            Heading("Detalhamento", { fontSize: "subtitle" }),
            Table(
              [invoiceLine("DESCRIÇÃO", "QTD.", "VALOR", true)],
              [
                invoiceLine("Pesquisa e levantamento de requisitos", "1", "R$ 3.200,00"),
                invoiceLine("Projeto visual e prototipação", "1", "R$ 4.800,00"),
                invoiceLine("Configuração inicial do ambiente", "1", "R$ 1.920,00"),
              ],
            ),
            card(
              [
                Row(
                  [
                    Stack([labels("TOTAL RECEBIDO"), small("Pagamento via transferência")], {
                      gap: "xs",
                    }),
                    Heading("R$ 9.920,00", { color: "accent", textAlign: "right" }),
                  ],
                  { align: "center" },
                ),
              ],
              { background: "tint" },
            ),
            Rule(),
            Row(
              [
                mark,
                Stack(
                  [
                    Text([Span("ESTÚDIO CAMPO DIGITAL LTDA.", { fontWeight: 700 })], {
                      fontSize: "small",
                    }),
                    small("CNPJ 00.000.000/0002-00  ·  Recibo demonstrativo"),
                    Link("https://signaturekit.dev", [
                      small("signaturekit.dev", { color: "accent" }),
                    ]),
                  ],
                  { grow: 1, gap: "xs" },
                ),
              ],
              { align: "center", gap: "md" },
            ),
          ],
          { gap: "lg" },
        ),
      ],
      { footer: footer("RECIBO 2026–014  /  VIA DO CLIENTE") },
    ),
  );
